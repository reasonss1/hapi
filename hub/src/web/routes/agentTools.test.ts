import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function setup(options: { namespace?: string; active?: boolean; capabilities?: readonly string[]; missing?: boolean } = {}) {
    const codex = { id: 'codex', name: 'Codex', installedVersion: '1.0.0', latestVersion: '2.0.0', canUpdate: true, state: 'idle' }
    const result = { tools: [codex, { ...codex, id: 'opencode', name: 'OpenCode' }], checkedAt: 1 }
    const getAgentTools = mock(async () => result)
    const updateAgentTool = mock(async () => result)
    const engine = {
        getMachine: () => options.missing ? null : ({
            id: 'machine', namespace: options.namespace ?? 'owner', active: options.active ?? true,
            metadata: { capabilities: options.capabilities ?? [MACHINE_CAPABILITIES.CodexAgentToolUpdates] },
        }),
        getAgentTools, updateAgentTool,
    }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'owner'); await next() })
    app.route('/api', createMachinesRoutes(() => engine as unknown as SyncEngine))
    const update = (body: unknown = { tool: 'codex' }) => app.request('/api/machines/machine/agent-tools/update', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { app, update, getAgentTools, updateAgentTool, codex }
}

describe('machine agent tools', () => {
    it('forwards checks and updates to scoped runners and returns only Codex', async () => {
        const { app, update, getAgentTools, updateAgentTool, codex } = setup()
        const expected = { tools: [codex], checkedAt: 1 }
        expect(await (await app.request('/api/machines/machine/agent-tools')).json()).toEqual(expected)
        expect(getAgentTools).toHaveBeenLastCalledWith('machine', false)
        await app.request('/api/machines/machine/agent-tools?refresh=true')
        expect(getAgentTools).toHaveBeenLastCalledWith('machine', true)
        const updated = await update()
        expect(updated.status).toBe(200)
        expect(await updated.json()).toEqual(expected)
        expect(updateAgentTool).toHaveBeenLastCalledWith('machine', 'codex')
    })

    it('rejects arbitrary packages, commands and extra properties', async () => {
        const { update, updateAgentTool } = setup()
        for (const body of [{ tool: 'opencode' }, { tool: '@evil/package' }, { tool: 'codex', command: 'curl example' }, null]) {
            expect((await update(body)).status).toBe(400)
        }
        expect(updateAgentTool).not.toHaveBeenCalled()
    })

    it('guards namespace, offline machines and older runners before RPC', async () => {
        for (const [options, status] of [
            [{ namespace: 'other' }, 403], [{ active: false }, 503],
            [{ capabilities: [] }, 409], [{ capabilities: [MACHINE_CAPABILITIES.AgentToolUpdates] }, 409], [{ missing: true }, 404],
        ] as const) {
            const { app, update, getAgentTools, updateAgentTool } = setup(options)
            expect((await app.request('/api/machines/machine/agent-tools')).status).toBe(status)
            expect((await update()).status).toBe(status)
            expect(getAgentTools).not.toHaveBeenCalled()
            expect(updateAgentTool).not.toHaveBeenCalled()
        }
    })

    it('returns an unavailable response when the device disconnects', async () => {
        const { app, getAgentTools } = setup()
        getAgentTools.mockImplementation(async () => { throw new RpcTargetMissingError('agent-tools', 'socket-disconnected') })
        expect((await app.request('/api/machines/machine/agent-tools')).status).toBe(503)
    })
})
