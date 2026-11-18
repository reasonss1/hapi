import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentFlavor } from '@hapi/protocol'
import { resolveHapiHomeDir } from '@/configuration'

type LaunchEnvironment = Record<string, string | undefined>

export type ManagedAgentTool = { version: string; command: string }

const MANAGED_TOOLS = new Set<AgentFlavor>(['codex', 'claude', 'pi', 'opencode', 'copilot'])
const pinnedCommands = new Map<string, string | null>()

export function getManagedAgentDirectory(agent: AgentFlavor, env: LaunchEnvironment = process.env): string {
    return join(resolveHapiHomeDir(env), 'agent-tools', agent)
}

export function getManagedAgentManifestPath(agent: AgentFlavor, env: LaunchEnvironment = process.env): string {
    return join(getManagedAgentDirectory(agent, env), 'active.json')
}

export function readManagedAgentTool(agent: AgentFlavor, env: LaunchEnvironment = process.env): ManagedAgentTool | null {
    if (!MANAGED_TOOLS.has(agent)) return null
    try {
        const manifest: unknown = JSON.parse(readFileSync(getManagedAgentManifestPath(agent, env), 'utf8'))
        if (!manifest || typeof manifest !== 'object') return null
        const { version, command } = manifest as Record<string, unknown>
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) return null
        if (typeof command !== 'string' || !isAbsolute(command)) return null
        // A malformed manifest must never redirect launches outside this tool's
        // private version directories, including through a symlink.
        const commandPath = realpathSync(command)
        const toolPath = realpathSync(getManagedAgentDirectory(agent, env))
        const childPath = relative(toolPath, commandPath)
        if (!childPath || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) return null
        if (!statSync(commandPath).isFile()) return null
        if (process.platform !== 'win32') accessSync(commandPath, constants.X_OK)
        return { version, command }
    } catch {
        return null
    }
}

/** Fresh selection for the runner inventory and availability checks. */
export function getManagedAgentCommand(agent: AgentFlavor, env: LaunchEnvironment = process.env): string | null {
    return readManagedAgentTool(agent, env)?.command ?? null
}

/** A session process keeps its initial selection, even across later updates. */
export function getPinnedManagedAgentCommand(agent: AgentFlavor, env: LaunchEnvironment = process.env): string | null {
    const key = `${resolveHapiHomeDir(env)}\0${agent}`
    if (!pinnedCommands.has(key)) pinnedCommands.set(key, getManagedAgentCommand(agent, env))
    return pinnedCommands.get(key) ?? null
}
