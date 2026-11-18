import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolId, AgentToolsResponse } from '@hapi/protocol/agentTools'
import { AgentToolUpdateService } from './agentToolUpdates'
import { getManagedAgentCommand, getManagedAgentDirectory, getManagedAgentManifestPath } from './managedAgentTools'

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, readFile: vi.fn(actual.readFile) }
})

const temporaryHomes: string[] = []

afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(overrides: ConstructorParameters<typeof AgentToolUpdateService>[0] = {}) {
    const home = await mkdtemp(join(tmpdir(), 'hapi-agent-updates-'))
    temporaryHomes.push(home)
    // CI can install npm under a hosted toolcache rather than /usr/bin. The
    // service still checks executable availability even with a fake installer,
    // so provide a local executable instead of depending on the host's layout.
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const env = { HAPI_HOME: home, PATH: bin }
    const initial = join(home, 'old-codex')
    await writeFile(initial, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const install = vi.fn(async (_packageName: string, _version: string, directory: string) => {
        const bin = join(directory, 'node_modules', '.bin')
        await mkdir(bin, { recursive: true })
        await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        await chmod(join(bin, 'codex'), 0o755)
    })
    const fetchLatest = vi.fn(async () => '2.0.0')
    const serviceOptions = {
        resolveCommand: (tool: AgentToolId) => tool === 'codex' ? initial : null,
        probeVersion: async (command: string) => command === initial ? 'codex-cli 1.0.0' : 'codex-cli 2.0.0',
        fetchLatest, install, sleep: async () => {}, ensureDiskSpace: async () => {},
        ...overrides,
        env: { ...env, ...overrides.env },
    }
    return { home, env, initial, install, fetchLatest, serviceOptions, service: new AgentToolUpdateService(serviceOptions) }
}

function codex(response: AgentToolsResponse) {
    return response.tools.find((tool) => tool.id === 'codex')!
}

async function complete(service: AgentToolUpdateService) {
    let result: AgentToolsResponse | undefined
    await vi.waitFor(async () => {
        result = await service.getStatus()
        expect(['updated', 'failed']).toContain(codex(result).state)
    }, { timeout: 5_000, interval: 10 })
    return result!
}

describe('AgentToolUpdateService', () => {
    it('reads versions locally and checks the registry only on request', async () => {
        const f = await fixture()
        expect(codex(await f.service.getStatus())).toMatchObject({ installedVersion: '1.0.0', latestVersion: null, canUpdate: false })
        expect(f.fetchLatest).not.toHaveBeenCalled()
        const result = await f.service.getStatus(true)
        expect(codex(result)).toMatchObject({ installedVersion: '1.0.0', latestVersion: '2.0.0', canUpdate: true, state: 'idle' })
        expect(result.checkedAt).toBeTypeOf('number')
        expect(result.tools.find((tool) => tool.id === 'pi')).toMatchObject({ installedVersion: null, canUpdate: false, reason: 'not_installed' })
    })

    it('publishes a validated side installation and preserves the old executable', async () => {
        const f = await fixture()
        expect(codex(await f.service.update('codex')).state).toBe('installing')
        const result = await complete(f.service)
        expect(codex(result)).toMatchObject({ state: 'updated', installedVersion: '2.0.0', canUpdate: false })
        const selected = getManagedAgentCommand('codex', f.env)
        expect(selected).toContain(join(f.home, 'agent-tools', 'codex', '2.0.0-'))
        expect(await readFile(f.initial, 'utf8')).toContain('exit 0')
        expect(f.install).toHaveBeenCalledOnce()
        expect(f.install.mock.calls[0][0]).toBe('@openai/codex')
    })

    it('retries failures without changing the active version or exposing command output', async () => {
        const f = await fixture({ install: vi.fn(async () => { throw new Error('secret-token=private') }) })
        const oldDirectory = join(getManagedAgentDirectory('codex', f.env), '1.0.0-old')
        const oldCommand = join(oldDirectory, 'codex')
        await mkdir(oldDirectory, { recursive: true })
        await writeFile(oldCommand, 'old working executable', { mode: 0o755 })
        const manifest = JSON.stringify({ version: '1.0.0', command: oldCommand })
        await writeFile(getManagedAgentManifestPath('codex', f.env), manifest)
        await f.service.update('codex')
        const result = await complete(f.service)
        expect(codex(result)).toMatchObject({ state: 'failed', installedVersion: '1.0.0', reason: 'install_failed', canUpdate: true })
        expect(f.serviceOptions.install).toHaveBeenCalledTimes(3)
        expect(JSON.stringify(result)).not.toContain('secret-token')
        expect(await readFile(getManagedAgentManifestPath('codex', f.env), 'utf8')).toBe(manifest)
        expect(await readFile(oldCommand, 'utf8')).toBe('old working executable')
        expect((await readdir(getManagedAgentDirectory('codex', f.env))).filter((name) => name.startsWith('2.0.0-'))).toEqual([])
    })

    it('keeps the current version when the installed candidate reports a different version', async () => {
        const f = await fixture({ probeVersion: async () => 'codex-cli 1.0.0', retryDelaysMs: [] })
        await f.service.update('codex')
        expect(codex(await complete(f.service))).toMatchObject({ state: 'failed', installedVersion: '1.0.0', reason: 'version_mismatch' })
        expect(getManagedAgentCommand('codex', f.env)).toBeNull()
        expect(f.install).toHaveBeenCalledOnce()
    })

    it('coalesces repeated update requests for a tool', async () => {
        const f = await fixture()
        await Promise.all([f.service.update('codex'), f.service.update('codex'), f.service.update('codex')])
        await complete(f.service)
        expect(f.install).toHaveBeenCalledOnce()
    })

    it('shares an active update across service instances and sees completion without another registry check', async () => {
        let release!: () => void
        let started!: () => void
        const installing = new Promise<void>((resolve) => { started = resolve })
        const released = new Promise<void>((resolve) => { release = resolve })
        const f = await fixture()
        const install = f.serviceOptions.install
        const service = new AgentToolUpdateService({ ...f.serviceOptions, install: async (...args) => { started(); await released; await install(...args) } })
        await service.update('codex')
        await installing
        const observer = new AgentToolUpdateService(f.serviceOptions)
        expect(codex(await observer.getStatus(true))).toMatchObject({ state: 'installing', installedVersion: '1.0.0', canUpdate: false })
        release()
        await complete(service)
        expect(codex(await observer.getStatus())).toMatchObject({ state: 'updated', installedVersion: '2.0.0', canUpdate: false })
        expect(f.install).toHaveBeenCalledOnce()
    })

    it('does not let an older delayed status read overwrite a newly started installation', async () => {
        const f = await fixture()
        const oldDirectory = join(getManagedAgentDirectory('codex', f.env), '1.0.0-old')
        const oldCommand = join(oldDirectory, 'codex')
        const updateFile = join(getManagedAgentDirectory('codex', f.env), 'update.json')
        await mkdir(oldDirectory, { recursive: true })
        await writeFile(oldCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        await writeFile(getManagedAgentManifestPath('codex', f.env), JSON.stringify({ version: '1.0.0', command: oldCommand }))
        await writeFile(updateFile, JSON.stringify({ version: '1.0.0', state: 'updated' }))

        let releaseInstaller!: () => void
        let installerStarted!: () => void
        const blockedInstaller = new Promise<void>((resolve) => { releaseInstaller = resolve })
        const installing = new Promise<void>((resolve) => { installerStarted = resolve })
        const service = new AgentToolUpdateService({
            ...f.serviceOptions,
            install: async (...args) => { installerStarted(); await blockedInstaller; await f.install(...args) },
        })
        await service.getStatus(true)

        let releaseRead!: () => void
        let readStarted!: () => void
        const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve })
        const reading = new Promise<void>((resolve) => { readStarted = resolve })
        const actualReadFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
        let delayNextRead = true
        vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
            const content = await actualReadFile(...args)
            if (String(args[0]) === updateFile && delayNextRead) {
                delayNextRead = false
                readStarted()
                await blockedRead
            }
            return content
        }) as typeof readFile)
        try {
            const oldPoll = service.getStatus()
            await reading
            expect(codex(await service.update('codex')).state).toBe('installing')
            await installing
            releaseRead()
            expect(codex(await oldPoll)).toMatchObject({ state: 'installing', canUpdate: false, installedVersion: '1.0.0' })
            expect(codex(await service.getStatus())).toMatchObject({ state: 'installing', canUpdate: false })
        } finally {
            releaseRead()
            releaseInstaller()
            vi.mocked(readFile).mockImplementation(actualReadFile)
            await complete(service)
        }
    })

    it('serializes simultaneous requests from separate services before touching the same manifest', async () => {
        const f = await fixture()
        const other = new AgentToolUpdateService(f.serviceOptions)
        await Promise.all([f.service.update('codex'), other.update('codex')])
        expect(codex(await complete(f.service)).installedVersion).toBe('2.0.0')
        expect(codex(await complete(other)).installedVersion).toBe('2.0.0')
        expect(f.install).toHaveBeenCalledOnce()
    })

    it('installs different tools one at a time even when update all requests arrive together', async () => {
        const f = await fixture()
        let activeInstallers = 0
        let peakInstallers = 0
        const service = new AgentToolUpdateService({
            ...f.serviceOptions,
            resolveCommand: (id) => id === 'codex' || id === 'pi' ? f.initial : null,
            install: async (packageName, _version, directory) => {
                activeInstallers++
                peakInstallers = Math.max(peakInstallers, activeInstallers)
                try {
                    await new Promise((resolve) => setTimeout(resolve, 25))
                    const bin = join(directory, 'node_modules', '.bin')
                    await mkdir(bin, { recursive: true })
                    await writeFile(join(bin, packageName === '@openai/codex' ? 'codex' : 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
                } finally {
                    activeInstallers--
                }
            },
        })
        await Promise.all([service.update('codex'), service.update('pi')])
        await vi.waitFor(async () => {
            const tools = (await service.getStatus()).tools.filter((tool) => tool.id === 'codex' || tool.id === 'pi')
            expect(tools.every((tool) => tool.state === 'updated')).toBe(true)
        }, { timeout: 5_000, interval: 10 })
        expect(peakInstallers).toBe(1)
    })

    it('does not downgrade stable or newer installed versions', async () => {
        const f = await fixture({ probeVersion: async () => 'codex-cli 3.0.0' })
        expect(codex(await f.service.update('codex'))).toMatchObject({ canUpdate: false, installedVersion: '3.0.0' })
        expect(f.install).not.toHaveBeenCalled()
        const prerelease = await fixture({ fetchLatest: async () => '4.0.0-beta.1' })
        expect(codex(await prerelease.service.update('codex')).canUpdate).toBe(false)
        expect(prerelease.install).not.toHaveBeenCalled()
    })

    it('does not replace an explicitly configured command', async () => {
        const f = await fixture({ env: { HAPI_CODEX_APP_SERVER_BIN: '/custom/codex', PATH: '/usr/bin' } })
        expect(codex(await f.service.update('codex'))).toMatchObject({ canUpdate: false, reason: 'custom_path' })
        expect(f.install).not.toHaveBeenCalled()
    })

    it('rejects an update when npm is absent from the device PATH', async () => {
        const f = await fixture({ env: { PATH: '' } })
        expect(codex(await f.service.update('codex'))).toMatchObject({
            installedVersion: '1.0.0', latestVersion: '2.0.0',
            canUpdate: false, state: 'idle', reason: 'npm_unavailable',
        })
        expect(f.install).not.toHaveBeenCalled()
    })

    it.each<NodeJS.Platform>(['win32', 'freebsd', 'openbsd'])('keeps %s version detection read only', async (platform) => {
        const f = await fixture({ platform })
        expect(codex(await f.service.update('codex'))).toMatchObject({ canUpdate: false, reason: 'unsupported_platform' })
        expect(f.install).not.toHaveBeenCalled()
    })

    it.each<{ tool: AgentToolId; platform: NodeJS.Platform; command: string }>([
        { tool: 'cursor', platform: 'linux', command: '/tools/agent' },
        { tool: 'codex', platform: 'win32', command: 'C:\\Tools\\codex.cmd' },
        { tool: 'claude', platform: 'win32', command: 'C:\\Tools\\claude.BAT' },
    ])('does not spawn a maintenance probe for $tool on $platform when it could be unsafe', async ({ tool, platform, command }) => {
        const probeVersion = vi.fn(async () => '1.0.0')
        const f = await fixture({ platform, resolveCommand: (id) => id === tool ? command : null, probeVersion })
        const result = await f.service.getStatus(true)
        expect(result.tools.find((entry) => entry.id === tool)).toMatchObject({ installedVersion: null, canUpdate: false, reason: 'manual_version' })
        expect(probeVersion).not.toHaveBeenCalled()
    })

    it('disables Copilot auto update during every version probe', async () => {
        const probeVersion = vi.fn(async () => 'GitHub Copilot CLI 1.0.0')
        const f = await fixture({ resolveCommand: (tool) => tool === 'copilot' ? '/tools/copilot' : null, probeVersion })
        await f.service.getStatus(true)
        expect(probeVersion).toHaveBeenCalledWith('/tools/copilot', ['--version', '--no-auto-update'])
    })

    it('stops before installing when disk headroom is insufficient', async () => {
        const f = await fixture({ ensureDiskSpace: async () => { throw new Error('disk_space') } })
        await f.service.update('codex')
        expect(codex(await complete(f.service))).toMatchObject({ state: 'failed', reason: 'disk_space', installedVersion: '1.0.0' })
        expect(f.install).not.toHaveBeenCalled()
        expect(getManagedAgentCommand('codex', f.env)).toBeNull()
    })

    it('identifies an interrupted update after its runner exited', async () => {
        const f = await fixture()
        await mkdir(getManagedAgentDirectory('codex', f.env), { recursive: true })
        await writeFile(join(getManagedAgentDirectory('codex', f.env), 'update.json'), JSON.stringify({
            state: 'installing', version: '2.0.0', pid: 2147483647, processStartMarker: 'dead-process',
        }))
        expect(codex(await f.service.getStatus(true))).toMatchObject({ state: 'failed', reason: 'install_interrupted', installedVersion: '1.0.0', canUpdate: true })
        expect(f.install).not.toHaveBeenCalled()
    })

    it('keeps official Grok read only instead of installing an unrelated npm package', async () => {
        const f = await fixture({ resolveCommand: (tool) => tool === 'grok' ? '/official/grok' : null, probeVersion: async () => 'Grok 1.0.0' })
        const result = await f.service.update('grok')
        expect(result.tools.find((tool) => tool.id === 'grok')).toMatchObject({ installedVersion: '1.0.0', canUpdate: false, reason: 'unsupported_tool' })
        expect(f.fetchLatest).not.toHaveBeenCalled()
        expect(f.install).not.toHaveBeenCalled()
    })

    it('keeps OpenCode read only because its shared background engine owns version switching', async () => {
        const f = await fixture({ resolveCommand: (tool) => tool === 'opencode' ? '/native/opencode' : null, probeVersion: async () => '2.0.0' })
        const result = await f.service.update('opencode')
        expect(result.tools.find((tool) => tool.id === 'opencode')).toMatchObject({ installedVersion: '2.0.0', canUpdate: false, reason: 'unsupported_tool' })
        expect(f.fetchLatest).not.toHaveBeenCalled()
        expect(f.install).not.toHaveBeenCalled()
    })
})
