import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

describe('namespace-scoped Hub Todo MCP bridge', () => {
    const connector = {
        listAgentTools: mock(async () => ({ tools: [{ name: 'get-todo-task', inputSchema: { type: 'object' } }] })),
        callAgentTool: mock(async () => ({ content: [{ type: 'text', text: 'task result' }] })),
    }
    const app = new Hono().route('/cli', createCliRoutes(() => null, { namespace: 'alice', connector } as never))
    const request = (path: string, token = 'test-token:alice', body?: unknown) => app.request('/cli/todo-mcp/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })

    it('authenticates CLI credentials and isolates namespaces before upstream access', async () => {
        const before = connector.listAgentTools.mock.calls.length
        expect((await request('tools', 'wrong:alice')).status).toBe(401)
        expect((await request('tools', 'test-token:bob')).status).toBe(404)
        expect((await request('tools', 'test-token')).status).toBe(404)
        expect(connector.listAgentTools.mock.calls.length).toBe(before)
        const response = await request('tools')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toHaveProperty('tools.0.name', 'get-todo-task')
    })

    it('forwards only allowed Todo tools and preserves results', async () => {
        const before = connector.callAgentTool.mock.calls.length
        for (const name of ['send-mail', 'create-todo-task', 'update-todo-task', 'delete-todo-task']) {
            expect((await request('call', undefined, { name, arguments: {} })).status).toBe(400)
        }
        expect((await request('call', undefined, { name: 'get-todo-task', arguments: [], url: 'http://elsewhere' })).status).toBe(400)
        expect((await request('call', undefined, { name: 'get-todo-task', arguments: { text: 'x'.repeat(70_000) } })).status).toBe(413)
        expect(connector.callAgentTool.mock.calls.length).toBe(before)
        const response = await request('call', undefined, { name: 'get-todo-task', arguments: { todoTaskListId: 'list', todoTaskId: 'task' } })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ content: [{ type: 'text', text: 'task result' }] })
    })

    it('returns no capability when Hub Todo is not configured', async () => {
        const disabled = new Hono().route('/cli', createCliRoutes(() => null))
        expect((await disabled.request('/cli/todo-mcp/status', { headers: { authorization: 'Bearer test-token:alice' } })).status).toBe(404)
    })
})
