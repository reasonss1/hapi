import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { AgentFlavor } from '@hapi/protocol'
import { getManagedAgentDirectory } from './managedAgentTools'

/** Keep all managed version directories immutable, including retained versions. */
export function getManagedAgentLaunchPolicy(
    agent: AgentFlavor,
    command: string,
    env: NodeJS.ProcessEnv = process.env,
): { extraArgs: string[]; env: NodeJS.ProcessEnv } {
    const unchanged = { extraArgs: [] as string[], env }
    if (agent !== 'claude' && agent !== 'copilot') return unchanged
    const override = agent === 'claude' ? env.HAPI_CLAUDE_PATH?.trim() : env.COPILOT_CLI_PATH?.trim()
    if (override === command) return unchanged
    try {
        const child = relative(realpathSync(getManagedAgentDirectory(agent, env)), realpathSync(command))
        if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return unchanged
    } catch {
        return unchanged
    }
    return agent === 'claude'
        ? { extraArgs: [], env: { ...env, DISABLE_AUTOUPDATER: '1' } }
        : { extraArgs: ['--no-auto-update'], env }
}
