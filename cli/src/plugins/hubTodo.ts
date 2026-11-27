import axios from 'axios'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { getHappyCliCommand, type HappyCliCommand } from '@/utils/spawnHappyCLI'
import { logger } from '@/ui/logger'

// Codex does not forward arbitrary parent env to stdio MCP processes.
// Pass variable names, not secret values in process arguments/config flags.
export const HUB_TODO_ENV_VARS = ['HAPI_API_URL', 'HAPI_HOME', 'CLI_API_TOKEN', 'HAPI_EXTRA_HEADERS_JSON']

export async function requestHubTodo(path: 'status' | 'tools' | 'call', body?: unknown) {
    const response = await axios.request({
        url: `${configuration.apiUrl.replace(/\/+$/, '')}/cli/todo-mcp/${path}`,
        method: body === undefined ? 'GET' : 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${getAuthToken()}` }),
        data: body,
        timeout: path === 'status' ? 5_000 : 30_000,
        maxRedirects: 0,
        validateStatus: () => true,
    })
    if (response.status !== 200) throw new Error(`Hub Todo MCP request failed (HTTP ${response.status})`)
    return response.data as unknown
}

export async function loadHubTodoServers(): Promise<Record<string, HappyCliCommand>> {
    if (!configuration.cliApiToken) return {}
    try {
        const status = await requestHubTodo('status') as { available?: boolean }
        if (status.available !== true) return {}
        const command = getHappyCliCommand(['todo-mcp'])
        return { 'hapi-todo': command }
    } catch {
        // Older hubs and namespaces without a Todo connector have no such capability.
        logger.debug('[Todo MCP] Hub connector unavailable for this namespace')
        return {}
    }
}

/** A remote device needs only HAPI, never the Hub's command path or Microsoft tokens. */
export function createHubTodoMcpServer(request: typeof requestHubTodo = requestHubTodo) {
    const server = new Server({ name: 'hapi-hub-todo', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ListToolsResultSchema.parse(await request('tools')))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
            return CallToolResultSchema.parse(await request('call', { name: params.name, arguments: params.arguments ?? {} }))
        } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Hub Todo MCP unavailable' }] }
        }
    })
    return server
}

export async function runHubTodoMcpServer() {
    const server = createHubTodoMcpServer()
    await server.connect(new StdioServerTransport())
}
