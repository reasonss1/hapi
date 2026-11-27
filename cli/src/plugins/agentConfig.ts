import type { PluginAgent, PluginMcpConfig } from '@hapi/protocol'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { PluginManager, pluginsEnabled } from './manager'
import { HUB_TODO_ENV_VARS, loadHubTodoServers } from './hubTodo'

async function loadPluginServers<T>(agent: PluginAgent, convert: (config: PluginMcpConfig) => T): Promise<Record<string, T>> {
    if (!pluginsEnabled() || !configuration.cliApiToken) return {}
    try {
        const manager = new PluginManager(configuration.happyHomeDir, configuration.cliApiToken)
        const entries = await manager.enabledMcp(agent)
        return Object.fromEntries(entries.map(({ name, config }) => [`hapi-plugin-${name}`, convert(config)]))
    } catch {
        logger.warn(`[Plugins] Unable to load ${agent} MCP settings. Check the plugin page on this device.`)
        return {}
    }
}

export type CodexPluginServer = ({ command: string; args: string[] } | { url: string }) & { env_vars?: string[] }

export async function loadCodexPluginServers(): Promise<Record<string, CodexPluginServer>> {
    const [local, hub] = await Promise.all([loadPluginServers<CodexPluginServer>('codex', (config) => config.transport === 'http'
        ? { url: config.url }
        : { command: config.command, args: config.args }), loadHubTodoServers()])
    return { ...local, ...Object.fromEntries(Object.entries(hub).map(([name, command]) => [name, { ...command, env_vars: HUB_TODO_ENV_VARS }])) }
}

export async function loadClaudePluginServers() {
    const [local, hub] = await Promise.all([loadPluginServers('claude', (config) => config.transport === 'http'
        ? { type: 'http' as const, url: config.url }
        : { type: 'stdio' as const, command: config.command, args: config.args }), loadHubTodoServers()])
    const env = Object.fromEntries(HUB_TODO_ENV_VARS.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
    return { ...local, ...Object.fromEntries(Object.entries(hub).map(([name, command]) => [name, { type: 'stdio' as const, ...command, env }])) }
}
