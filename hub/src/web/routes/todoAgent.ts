import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { AGENT_TODO_TOOLS, type TodoMcp } from '../todoMcp'

export type TodoAgentConfig = {
    namespace: string
    connector: Pick<TodoMcp, 'listAgentTools' | 'callAgentTool'>
}

// Mounted inside /cli, after its CLI token authentication middleware.
export function createTodoAgentRoutes(config: TodoAgentConfig | null) {
    const app = new Hono<{ Variables: { namespace: string } }>()
    app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'Payload too large' }, 413) }), async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (!config || c.get('namespace') !== config.namespace) return c.json({ error: 'Todo unavailable' }, 404)
        return next()
    })
    app.onError((_error, c) => c.json({ error: 'Todo MCP unavailable' }, 503))
    app.get('/status', c => c.json({ available: true }))
    app.get('/tools', async c => c.json(await config!.connector.listAgentTools()))
    app.post('/call', async c => {
        const text = await c.req.text()
        let json: unknown
        try { json = JSON.parse(text) } catch { return c.json({ error: 'Invalid JSON' }, 400) }
        const parsed = z.object({
            name: z.enum(AGENT_TODO_TOOLS),
            arguments: z.record(z.string(), z.unknown()).default({}),
        }).strict().safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid Todo tool call' }, 400)
        return c.json(await config!.connector.callAgentTool(parsed.data.name, parsed.data.arguments))
    })
    return app
}
