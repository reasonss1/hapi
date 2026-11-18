import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import { MachineDeletionError } from '../../sync/machineDeletionError'
import { ArchiveCleanupError } from '../../sync/archiveCleanupError'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function appWith(engine: Partial<SyncEngine> | null) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'tenant'); await next() })
    app.route('/api', createMachinesRoutes(() => engine as SyncEngine | null))
    return app
}

describe('machine management HTTP contract', () => {
    it('keeps the default picker online-only and opts management into offline/ghost records', async () => {
        const calls: string[] = []
        const app = appWith({
            getOnlineMachinesByNamespace: namespace => { calls.push(`online:${namespace}`); return [] },
            getMachinesForManagement: namespace => { calls.push(`management:${namespace}`); return [] }
        })
        for (const suffix of ['', '?includeOffline=1', '?includeOffline=true', '?includeOffline=false']) {
            const response = await app.request(`/api/machines${suffix}`)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ machines: [] })
        }
        expect(calls).toEqual(['online:tenant', 'management:tenant', 'management:tenant', 'online:tenant'])
    })
    it('deletes session-only records through the same scoped API without requiring a real machine row', async () => {
        const app = appWith({ deleteMachine: async (id, namespace) => {
            expect([id, namespace]).toEqual(['ghost', 'tenant'])
            return { ok: true, deletedSessions: 2 }
        } })
        const response = await app.request('/api/machines/ghost', { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, deletedSessions: 2 })
    })
    it.each([
        new MachineDeletionError('Missing', 404, 'machine_not_found'),
        new MachineDeletionError('Busy', 409, 'machine_sessions_busy'),
        new MachineDeletionError('Unavailable', 503, 'machine_runner_unavailable'),
        new ArchiveCleanupError('unconfirmed'),
        new ArchiveCleanupError('unavailable')
    ])('returns structured cleanup errors with their retryable status (%s)', async error => {
        const response = await appWith({ deleteMachine: async () => { throw error } })
            .request('/api/machines/target', { method: 'DELETE' })
        expect(response.status).toBe(error.status)
        expect(await response.json()).toEqual({ error: error.message, code: error.code })
    })
    it('returns 503 when the Hub engine is unavailable', async () => {
        const response = await appWith(null).request('/api/machines/target', { method: 'DELETE' })
        expect(response.status).toBe(503)
    })
})
