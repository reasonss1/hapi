import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHubTodoMcpServer, HUB_TODO_ENV_VARS, loadHubTodoServers } from './hubTodo'
import { loadClaudePluginServers, loadCodexPluginServers } from './agentConfig'
import axios from 'axios'

vi.mock('axios', () => ({ default: { request: vi.fn() } }))
vi.mock('@/utils/spawnHappyCLI', () => ({ getHappyCliCommand: (args: string[]) => ({ command: 'hapi-device', args }) }))
vi.mock('./manager', () => ({ pluginsEnabled: () => false }))
afterEach(() => vi.clearAllMocks())

describe('remote device Todo MCP', () => {
    it('auto-injects the Hub bridge without local plugin management or a Microsoft command path', async () => {
        vi.mocked(axios.request).mockResolvedValue({ status: 200, data: { available: true } })
        expect(await loadCodexPluginServers()).toEqual({ 'hapi-todo': { command: 'hapi-device', args: ['todo-mcp'], env_vars: HUB_TODO_ENV_VARS } })
        expect(await loadClaudePluginServers()).toEqual({ 'hapi-todo': { type: 'stdio', command: 'hapi-device', args: ['todo-mcp'], env: expect.any(Object) } })
        const options = vi.mocked(axios.request).mock.calls[0][0]
        expect(options.url).toMatch(/\/cli\/todo-mcp\/status$/)
        expect(options.maxRedirects).toBe(0)
        expect(options.headers).toHaveProperty('Authorization')
    })

    it.each([401, 404, 503])('omits the connector on HTTP %s', async status => {
        vi.mocked(axios.request).mockResolvedValue({ status })
        expect(await loadHubTodoServers()).toEqual({})
    })

    it('preserves upstream tool schemas and errors without retrying calls', async () => {
        const request = vi.fn(async (path: string, _body?: unknown): Promise<unknown> => path === 'tools'
            ? { tools: [{ name: 'get-todo-task', description: 'Get task', inputSchema: { type: 'object' } }] }
            : { isError: true, content: [{ type: 'text', text: 'provider failure' }] })
        const server = createHubTodoMcpServer(request)
        const client = new Client({ name: 'remote-device-test', version: '1' })
        const [local, remote] = InMemoryTransport.createLinkedPair()
        await server.connect(local)
        await client.connect(remote)
        try {
            expect((await client.listTools()).tools[0].description).toBe('Get task')
            expect(await client.callTool({ name: 'get-todo-task', arguments: { todoTaskId: 'task' } })).toMatchObject({ isError: true })
            request.mockRejectedValueOnce(new Error('connection lost'))
            expect(await client.callTool({ name: 'get-todo-task', arguments: {} })).toMatchObject({ isError: true })
            expect(request.mock.calls.filter(([path]) => path === 'call')).toHaveLength(2)
        } finally {
            await client.close()
            await server.close()
        }
    })
})
