import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
    AgentToolIdSchema,
    type AgentToolId,
    type AgentToolsResponse,
    type AgentToolStatus,
} from '@hapi/protocol/agentTools'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { resolveCodexCommand } from '@/codex/utils/codexExecutable'
import { getProcessStartMarker, isProcessAlive } from '@/utils/process'
import { resolveExecutable } from './agentLaunchCommand'
import {
    getManagedAgentCommand,
    getManagedAgentDirectory,
    getManagedAgentManifestPath,
    readManagedAgentTool,
} from './managedAgentTools'

type ToolDefinition = { name: string; packageName?: string; versionArgs: string[] }

const TOOLS: Record<AgentToolId, ToolDefinition> = {
    codex: { name: 'Codex', packageName: '@openai/codex', versionArgs: ['--version'] },
    claude: { name: 'Claude Code', packageName: '@anthropic-ai/claude-code', versionArgs: ['--version'] },
    pi: { name: 'Pi', packageName: '@mariozechner/pi-coding-agent', versionArgs: ['--version'] },
    // Its shared native background service owns the actual engine lifecycle.
    // Updating only the launcher cannot promise an isolated version switch.
    opencode: { name: 'OpenCode', versionArgs: ['--version'] },
    copilot: { name: 'GitHub Copilot', packageName: '@github/copilot', versionArgs: ['--version', '--no-auto-update'] },
    // HAPI wraps xAI's official Grok Build CLI. The similarly named npm
    // @vibe-kit/grok-cli is a different product and must never replace it.
    grok: { name: 'Grok', versionArgs: ['version'] },
    cursor: { name: 'Cursor', versionArgs: ['--version'] },
    kimi: { name: 'Kimi', versionArgs: ['--version'] },
    agy: { name: 'Antigravity', versionArgs: ['--version'] },
    dsh: { name: 'DSH', versionArgs: ['--version'] },
}

const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const installationQueues = new Map<string, Promise<void>>()

export function parseAgentToolVersion(output: string): string | null {
    return output.match(VERSION_PATTERN)?.[1] ?? null
}

function isNewerVersion(candidate: string, installed: string): boolean {
    if (candidate.includes('-') && !installed.includes('-')) return false
    const candidateParts = candidate.split(/[.+-]/).slice(0, 3).map(Number)
    const installedParts = installed.split(/[.+-]/).slice(0, 3).map(Number)
    for (let index = 0; index < 3; index++) {
        if (candidateParts[index] !== installedParts[index]) return candidateParts[index] > installedParts[index]
    }
    // Never move a stable installation to a prerelease via this button.
    return !candidate.includes('-') && installed.includes('-')
}

function runFile(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number, diskDirectory?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32'
        const child = spawn(command, [...args], { env, cwd: diskDirectory ?? homedir(), detached: grouped, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        let failed = false
        let finished = false
        let failureReason = 'install_failed'
        const terminate = (reason = 'install_failed') => {
            if (finished) return
            failed = true
            failureReason = reason
            try {
                // Include postinstall descendants. Cleaning a failed staging
                // directory is only safe once its entire installer is stopped.
                if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL')
                else child.kill('SIGKILL')
            } catch { /* Process group already exited. */ }
        }
        const timer = setTimeout(terminate, timeout)
        const diskWatch = diskDirectory ? setInterval(() => {
            void statfs(diskDirectory).then((disk) => {
                if (!finished && disk.bavail * disk.bsize < 256 * 1024 * 1024) terminate('disk_space')
            }).catch(() => { if (!finished) terminate() })
        }, 1000) : null
        const clearTimers = () => {
            clearTimeout(timer)
            if (diskWatch) clearInterval(diskWatch)
        }
        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString()
            if (stdout.length > 1024 * 1024) terminate()
        })
        child.on('error', () => {
            clearTimers()
            finished = true
            reject(new Error(failureReason))
        })
        child.on('close', (code) => {
            clearTimers()
            if (code !== 0 || failed) {
                terminate(failureReason)
                finished = true
                reject(new Error(failureReason))
            } else {
                finished = true
                resolve(stdout)
            }
        })
    })
}

type UpdateOptions = {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    now?: () => number
    resolveCommand?: (tool: AgentToolId) => string | null
    probeVersion?: (command: string, args: readonly string[]) => Promise<string>
    fetchLatest?: (packageName: string) => Promise<string>
    install?: (packageName: string, version: string, directory: string) => Promise<void>
    sleep?: (duration: number) => Promise<void>
    retryDelaysMs?: readonly number[]
    ensureDiskSpace?: (directory: string) => Promise<void>
}

type PersistedUpdate = {
    version: string
    state: AgentToolStatus['state']
    reason?: string
    pid: number
    processStartMarker: string | null
}

/**
 * Installs into new private directories and only publishes a validated version.
 * Existing installations, running processes, credentials and old version
 * directories are never modified or removed.
 */
export class AgentToolUpdateService {
    private readonly env: NodeJS.ProcessEnv
    private readonly platform: NodeJS.Platform
    private readonly now: () => number
    private readonly options: UpdateOptions
    private readonly tools = new Map<AgentToolId, AgentToolStatus>()
    private readonly eligibility = new Map<AgentToolId, string | null>()
    private readonly running = new Map<AgentToolId, Promise<void>>()
    private readonly operationGenerations = new Map<AgentToolId, number>()
    private checkedAt: number | null = null
    private initialized = false
    private checking: Promise<void> | null = null
    private readonly processStartMarker = getProcessStartMarker(process.pid)

    constructor(options: UpdateOptions = {}) {
        this.options = options
        this.env = options.env ? { ...options.env } : { ...process.env }
        this.platform = options.platform ?? process.platform
        this.now = options.now ?? Date.now
        for (const id of AgentToolIdSchema.options) {
            this.tools.set(id, {
                id, name: TOOLS[id].name, installedVersion: null, latestVersion: null,
                canUpdate: false, state: 'idle', reason: 'not_installed',
            })
        }
    }

    private configuredCommand(id: AgentToolId): string | undefined {
        if (id === 'codex') return this.env.HAPI_CODEX_APP_SERVER_BIN?.trim() || undefined
        if (id === 'claude') return this.env.HAPI_CLAUDE_PATH?.trim() || undefined
        if (id === 'copilot') return this.env.COPILOT_CLI_PATH?.trim() || undefined
        if (id === 'dsh') return this.env.HAPI_DSH_ACP_COMMAND?.trim() || undefined
        return undefined
    }

    private resolveCommand(id: AgentToolId): string | null {
        if (this.options.resolveCommand) return this.options.resolveCommand(id)
        const configured = this.configuredCommand(id)
        if (configured) return configured
        const managed = getManagedAgentCommand(id, this.env)
        if (managed) return managed
        if (id === 'claude') {
            try { return getDefaultClaudeCodePath(this.env, { freshManaged: true }) } catch { return null }
        }
        if (id === 'codex') {
            const resolved = resolveCodexCommand(this.env, this.platform, { freshManaged: true })
            // On Windows, resolveCodexCommand may return `node <shim>`. The
            // inventory falls back to the CLI shim, which execFile cannot run
            // reliably; unsupported-platform rows still retain managed info.
            if (resolved.args.length === 0) return resolveExecutable(resolved.command, { platform: this.platform, pathValue: this.env.PATH })
        }
        return resolveExecutable(id === 'cursor' ? 'agent' : id, { platform: this.platform, pathValue: this.env.PATH, pathExt: this.env.PATHEXT })
    }

    private async probe(command: string, args: readonly string[]): Promise<string | null> {
        const output = this.options.probeVersion
            ? await this.options.probeVersion(command, args)
            : await runFile(command, args, { ...this.env, DISABLE_AUTOUPDATER: '1' }, 10_000)
        return parseAgentToolVersion(output)
    }

    private async latest(packageName: string): Promise<string> {
        let version: unknown
        if (this.options.fetchLatest) {
            version = await this.options.fetchLatest(packageName)
        } else {
            const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
                headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok) throw new Error('Version check failed')
            const metadata = await response.json() as { name?: unknown; version?: unknown }
            if (metadata.name !== packageName) throw new Error('Unexpected package')
            version = metadata.version
        }
        if (typeof version !== 'string' || !EXACT_VERSION_PATTERN.test(version)) throw new Error('Invalid version')
        return version
    }

    private snapshot(): AgentToolsResponse {
        return {
            tools: [...this.tools.values()].map((tool) => ({ ...tool })),
            checkedAt: this.checkedAt,
        }
    }

    async getStatus(checkLatest = false): Promise<AgentToolsResponse> {
        if (this.checking) {
            await this.checking
            // A plain first inventory request must not swallow an explicit
            // subsequent request to contact the package registry.
            if (!checkLatest || this.checkedAt !== null) {
                await this.refreshExternalStates()
                return this.snapshot()
            }
        }
        if (!this.initialized || checkLatest) {
            const work = this.refresh(checkLatest)
            this.checking = work
            try { await work } finally { if (this.checking === work) this.checking = null }
        }
        await this.refreshExternalStates()
        return this.snapshot()
    }

    private async persistState(id: AgentToolId, version: string): Promise<void> {
        const tool = this.tools.get(id)!
        const directory = getManagedAgentDirectory(id, this.env)
        const temporary = join(directory, `update-${randomUUID()}.json`)
        const state: PersistedUpdate = {
            version, state: tool.state, reason: tool.reason,
            pid: process.pid, processStartMarker: this.processStartMarker,
        }
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(directory, 'update.json'))
    }

    private async refreshExternalStates(): Promise<void> {
        await Promise.all(AgentToolIdSchema.options.map(async (id) => {
            if (this.running.has(id)) return
            const tool = this.tools.get(id)!
            if (this.configuredCommand(id)) return
            const generation = this.operationGenerations.get(id) ?? 0
            const canApply = () => !this.running.has(id) && (this.operationGenerations.get(id) ?? 0) === generation
            let persisted: Partial<PersistedUpdate> | null = null
            let lock: Awaited<ReturnType<typeof stat>> | null = null
            try {
                const raw = await readFile(join(getManagedAgentDirectory(id, this.env), 'update.json'), 'utf8')
                if (!canApply()) return
                const value: unknown = JSON.parse(raw)
                if (value && typeof value === 'object') persisted = value as Partial<PersistedUpdate>
                if (typeof persisted?.version !== 'string' || !EXACT_VERSION_PATTERN.test(persisted.version)) persisted = null
                if (persisted?.state === 'installing' || persisted?.state === 'retrying') {
                    lock = await stat(`${getManagedAgentManifestPath(id, this.env)}.hapi.lock`).catch(() => null)
                    if (!canApply()) return
                }
            } catch {
                // The active manifest remains authoritative when an update
                // sidecar is absent, malformed or unreadable.
            }
            if (!canApply()) return
            // Read after all external I/O: another service may have activated a
            // new version while this poll was waiting on an old sidecar.
            const managed = readManagedAgentTool(id, this.env)
            const patch: Partial<AgentToolStatus> = managed ? { installedVersion: managed.version } : {}
            if (persisted) {
                if (managed?.version === persisted.version) {
                    patch.state = 'updated'
                    patch.reason = this.eligibility.get(id) ?? undefined
                } else if (persisted.state === 'installing' || persisted.state === 'retrying') {
                    const alive = typeof persisted.pid === 'number' && isProcessAlive(persisted.pid)
                    const sameProcess = alive && (persisted.pid === process.pid || (
                        typeof persisted.processStartMarker === 'string'
                        && getProcessStartMarker(persisted.pid!) === persisted.processStartMarker
                    ))
                    if (sameProcess && lock && this.now() - lock.mtimeMs < 30_000) {
                        patch.state = persisted.state
                        patch.latestVersion = persisted.version
                        patch.canUpdate = false
                        patch.reason = undefined
                    } else {
                        patch.state = 'failed'
                        patch.reason = 'install_interrupted'
                    }
                } else if (persisted.state === 'failed') {
                    patch.state = 'failed'
                    patch.reason = ['install_failed', 'version_mismatch', 'disk_space'].includes(persisted.reason ?? '')
                        ? persisted.reason : 'install_failed'
                }
                if (patch.canUpdate === undefined) {
                    const installedVersion = patch.installedVersion ?? tool.installedVersion
                    patch.canUpdate = !this.eligibility.get(id) && !!tool.latestVersion && !!installedVersion
                        && isNewerVersion(tool.latestVersion, installedVersion)
                }
            }
            // No await may separate this fence from the assignment. A stale
            // poll must never replace the state of a newer local operation.
            if (canApply()) Object.assign(tool, patch)
        }))
    }

    private async refresh(checkLatest: boolean): Promise<void> {
        const npm = resolveExecutable('npm', { platform: this.platform, pathValue: this.env.PATH, pathExt: this.env.PATHEXT })
        await Promise.all(AgentToolIdSchema.options.map(async (id) => {
            const tool = this.tools.get(id)!
            if (this.running.has(id)) return
            let installedVersion: string | null = null
            let probeFailed = false
            try {
                const command = this.resolveCommand(id)
                // Cursor CLI probes can terminate an active ACP child; do not
                // launch another Cursor process from a maintenance screen.
                if (command && (id === 'cursor' || this.platform === 'win32' && /\.(cmd|bat)$/i.test(command))) {
                    tool.reason = 'manual_version'
                    this.eligibility.set(id, tool.reason)
                    tool.canUpdate = false
                    return
                }
                if (command) installedVersion = await this.probe(command, TOOLS[id].versionArgs)
            } catch {
                probeFailed = true
            }
            tool.installedVersion = installedVersion
            const reason = !installedVersion ? probeFailed ? 'check_failed' : 'not_installed'
                : this.configuredCommand(id) ? 'custom_path'
                    : this.platform !== 'linux' && this.platform !== 'darwin' ? 'unsupported_platform'
                        : !TOOLS[id].packageName ? 'unsupported_tool'
                            : !npm ? 'npm_unavailable' : null
            this.eligibility.set(id, reason)
            tool.reason = reason ?? undefined
            tool.canUpdate = false
            if (checkLatest && installedVersion && TOOLS[id].packageName) {
                try {
                    tool.latestVersion = await this.latest(TOOLS[id].packageName!)
                } catch {
                    tool.reason = reason ?? 'check_failed'
                    return
                }
            }
            tool.canUpdate = !reason && !!installedVersion && !!tool.latestVersion
                && isNewerVersion(tool.latestVersion, installedVersion)
            if (tool.state === 'failed' && installedVersion === tool.latestVersion) tool.state = 'idle'
        }))
        this.initialized = true
        if (checkLatest) this.checkedAt = this.now()
    }

    async update(toolId: AgentToolId): Promise<AgentToolsResponse> {
        const id = AgentToolIdSchema.parse(toolId)
        if (this.running.has(id)) return this.snapshot()
        await this.getStatus(this.checkedAt === null)
        if (this.running.has(id)) return this.snapshot()
        const tool = this.tools.get(id)!
        if (!tool.canUpdate || !tool.latestVersion) return this.snapshot()
        this.operationGenerations.set(id, (this.operationGenerations.get(id) ?? 0) + 1)
        tool.state = 'installing'
        tool.canUpdate = false
        tool.reason = undefined
        const version = tool.latestVersion
        const queueKey = dirname(getManagedAgentDirectory(id, this.env))
        const work = (installationQueues.get(queueKey) ?? Promise.resolve()).then(() => this.performUpdate(id, version))
        const queue = work.catch(() => undefined)
        installationQueues.set(queueKey, queue)
        void queue.finally(() => {
            if (installationQueues.get(queueKey) === queue) installationQueues.delete(queueKey)
        })
        this.running.set(id, work)
        void work.finally(() => this.running.delete(id))
        return this.snapshot()
    }

    private async install(packageName: string, version: string, directory: string): Promise<void> {
        if (this.options.install) return this.options.install(packageName, version, directory)
        const npm = resolveExecutable('npm', { pathValue: this.env.PATH })
        if (!npm) throw new Error('npm_unavailable')
        await runFile(npm, [
            'install', '--prefix', directory, '--no-audit', '--no-fund', '--package-lock=false',
            '--cache', join(directory, '.npm-cache'),
            '--registry=https://registry.npmjs.org', `${packageName}@${version}`,
        ], this.env, 5 * 60_000, directory)
        await rm(join(directory, '.npm-cache'), { recursive: true, force: true })
    }

    private async ensureDiskSpace(directory: string): Promise<void> {
        if (this.options.ensureDiskSpace) return this.options.ensureDiskSpace(directory)
        const disk = await statfs(directory)
        // Leave headroom for both unpacked native binaries and the running
        // hub's database/log writes. Updating must not fill the system disk.
        if (disk.bavail * disk.bsize < 1024 * 1024 * 1024) throw new Error('disk_space')
    }

    private async validateCandidate(directory: string, command: string): Promise<void> {
        const childPath = relative(await realpath(directory), await realpath(command))
        if (!childPath || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) throw new Error('Invalid candidate')
        if (!(await stat(command)).isFile()) throw new Error('Invalid candidate')
        await access(command, constants.X_OK)
    }

    private async performUpdate(id: AgentToolId, version: string): Promise<void> {
        const tool = this.tools.get(id)!
        const toolDirectory = getManagedAgentDirectory(id, this.env)
        try {
            await mkdir(toolDirectory, { recursive: true })
            // Even different tools share the install budget. A multi-device
            // button must not start several unpackers on the same device.
            await withSettingsFileLock(join(dirname(toolDirectory), 'installation'), async () =>
                withSettingsFileLock(getManagedAgentManifestPath(id, this.env), async () => {
                const existing = readManagedAgentTool(id, this.env)
                if (existing && !isNewerVersion(version, existing.version)) {
                    tool.installedVersion = existing.version
                    tool.state = 'updated'
                    tool.reason = undefined
                    return
                }
                const currentCommand = this.resolveCommand(id)
                const currentVersion = currentCommand ? await this.probe(currentCommand, TOOLS[id].versionArgs) : null
                if (currentVersion && !isNewerVersion(version, currentVersion)) {
                    tool.installedVersion = currentVersion
                    tool.state = 'updated'
                    tool.reason = undefined
                    return
                }
                await this.persistState(id, version)
                const delays = (this.options.retryDelaysMs ?? [2_000, 10_000]).slice(0, 2)
                const sleep = this.options.sleep ?? ((duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration)))
                for (let attempt = 0; attempt <= delays.length; attempt++) {
                    // A new directory per attempt keeps a timed-out installer
                    // from changing either a retry or the active installation.
                    const directory = join(toolDirectory, `${version}-${randomUUID()}`)
                    try {
                        tool.state = attempt === 0 ? 'installing' : 'retrying'
                        await this.persistState(id, version)
                        await this.ensureDiskSpace(toolDirectory)
                        await mkdir(directory, { recursive: true })
                        await this.install(TOOLS[id].packageName!, version, directory)
                        const command = join(directory, 'node_modules', '.bin', id)
                        await this.validateCandidate(directory, command)
                        if (await this.probe(command, TOOLS[id].versionArgs) !== version) throw new Error('version_mismatch')
                        // Manifest lives on the same filesystem. rename makes
                        // new sessions see the old or the complete new version.
                        const temporary = join(toolDirectory, `active-${randomUUID()}.json`)
                        await writeFile(temporary, JSON.stringify({ version, command }), { mode: 0o600, flag: 'wx' })
                        await rename(temporary, getManagedAgentManifestPath(id, this.env))
                        tool.installedVersion = version
                        tool.state = 'updated'
                        tool.reason = undefined
                        await this.persistState(id, version).catch(() => undefined)
                        return
                    } catch (error) {
                        tool.reason = error instanceof Error && ['version_mismatch', 'disk_space'].includes(error.message) ? error.message : 'install_failed'
                        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
                        if (tool.reason === 'disk_space') break
                        if (attempt < delays.length) {
                            tool.state = 'retrying'
                            await this.persistState(id, version)
                            await sleep(delays[attempt])
                        }
                    }
                }
                tool.state = 'failed'
                tool.canUpdate = true
                await this.persistState(id, version).catch(() => undefined)
                })
            )
        } catch (error) {
            tool.state = 'failed'
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
            tool.reason = error instanceof Error && error.message === 'disk_space' ? 'disk_space'
                : code === 'ELOCKED' ? 'update_in_progress'
                    : code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'install_failed'
            tool.canUpdate = true
        }
    }
}
