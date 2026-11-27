import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createConfiguration } from '../../configuration'
import { TodoMcp } from '../todoMcp'
import { createCliRoutes } from './cli'

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

// Runs the real HAPI stdio command in an isolated device home. No model API is used.
describe.skipIf(process.env.HAPI_RUN_TODO_BRIDGE_TESTS !== '1')('device → authenticated Hub → central Todo MCP', () => {
    it('reads through the Hub without installing the provider or its Microsoft credentials on the device', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-remote-todo-'))
        const central = join(root, 'central.cjs')
        const device = join(root, 'device'); await mkdir(device)
        await writeFile(central, `#!/usr/bin/env node
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line); if (id === undefined) return;
    const result = method === 'initialize' ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'central-todo', version: '1' } }
        : method === 'tools/list' ? { tools: ['list-todo-task-lists', 'send-mail'].map(name => ({ name, description: 'Central-only test tool', inputSchema: { type: 'object' } })) }
        : { content: [{ type: 'text', text: JSON.stringify({ value: [{ id: 'central-list', displayName: 'Central-only test list' }] }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
});
`)
        await chmod(central, 0o700)
        const connector = new TodoMcp(process.env.HAPI_TEST_TODO_MCP_COMMAND ?? central)
        const app = new Hono().route('/cli', createCliRoutes(() => null, { namespace: 'alice', connector }))
        const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
        const repo = resolve(import.meta.dir, '../../../..')
        const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MS365_|HAPI_TODO_)/.test(key))) as Record<string, string>
        Object.assign(env, { HAPI_HOME: device, HAPI_API_URL: `http://127.0.0.1:${hub.port}`, CLI_API_TOKEN: 'test-token:alice', HAPI_ENABLE_PLUGIN_MANAGEMENT: '0' })
        const client = new Client({ name: 'isolated-remote-device', version: '1' })
        try {
            await client.connect(new StdioClientTransport({ command: process.execPath,
                args: [join(repo, 'cli/src/index.ts'), 'todo-mcp'], cwd: join(repo, 'cli'), env, stderr: 'pipe' }), { timeout: 20_000 })
            const catalog = await client.listTools()
            expect(catalog.tools.some(tool => tool.name === 'list-todo-task-lists')).toBe(true)
            expect(catalog.tools.some(tool => tool.name === 'send-mail')).toBe(false)
            const result = await client.callTool({ name: 'list-todo-task-lists', arguments: { top: 1 } })
            expect(result.isError).not.toBe(true)
            const text = (result.content as Array<{ type: string; text?: string }>).find(part => part.type === 'text')?.text
            expect(Array.isArray(JSON.parse(text!).value)).toBe(true)
            // The device receives only MCP schemas/results, never the executable path.
            expect(JSON.stringify(catalog)).not.toContain(central)
        } finally {
            await client.close()
            await connector.close()
            hub.stop(true)
            await rm(root, { recursive: true, force: true, maxRetries: 3 })
        }
    }, 45_000)
})
