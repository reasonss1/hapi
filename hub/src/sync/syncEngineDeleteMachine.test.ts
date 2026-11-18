import { beforeEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { ArchiveCleanupError } from './archiveCleanupError'
import { MachineDeletionError } from './machineDeletionError'
import type { SyncEvent } from '@hapi/protocol'
import type { SessionCache } from './sessionCache'
import type { RpcGateway } from './rpcGateway'

describe('SyncEngine device cleanup', () => {
    let store: Store
    let engine: SyncEngine
    let gateway: RpcGateway
    let cache: SessionCache
    let events: SyncEvent[]
    beforeEach(() => {
        store = new Store(':memory:')
        events = []
        engine = new SyncEngine(store, { of: () => ({ sockets: new Map(), to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        const internals = engine as unknown as { rpcGateway: RpcGateway; sessionCache: SessionCache }
        gateway = internals.rpcGateway
        cache = internals.sessionCache
    })
    function machine(id: string, namespace = 'default') {
        return engine.getOrCreateMachine(id, { host: id, platform: 'linux', happyCliVersion: '0.35.1' }, null, namespace)
    }
    function session(tag: string, machineId: string, namespace = 'default', active = false) {
        const row = engine.getOrCreateSession(tag, {
            path: '/tmp/device-cleanup-fixture', host: machineId, machineId, flavor: 'codex',
            lifecycleState: active ? 'running' : 'archived', startedBy: 'runner', startedFromRunner: true
        }, null, namespace)
        if (active) cache.markSessionActive(row.id)
        store.messages.addMessage(row.id, { role: 'user', content: 'fixture' }, `message-${tag}`)
        return row
    }
    it('lists offline machines and session-only ghosts with namespace-specific counts', () => {
        machine('offline')
        session('real', 'offline')
        session('ghost', 'missing')
        session('hidden', 'hidden', 'other')
        expect(engine.getOnlineMachinesByNamespace('default')).toEqual([])
        expect(engine.getMachinesForManagement('default').map(row => [row.id, row.sessionOnly ?? false, row.sessionCount]))
            .toEqual([['offline', false, 1], ['missing', true, 1]])
    })
    it('removes only the target machine, its Hub sessions/messages and caches, publishing scoped SSE', async () => {
        machine('target'); machine('other')
        const first = session('target-1', 'target')
        const second = session('target-2', 'target')
        const other = session('other', 'other')
        const tenant = session('tenant', 'target', 'tenant')
        expect(await engine.deleteMachine('target', 'default')).toEqual({ ok: true, deletedSessions: 2 })
        for (const id of [first.id, second.id]) {
            expect(store.sessions.getSession(id)).toBeNull()
            expect(store.messages.getAllMessages(id)).toHaveLength(0)
            expect(engine.getSession(id)).toBeUndefined()
        }
        expect(store.sessions.getSession(other.id)).not.toBeNull()
        expect(store.sessions.getSession(tenant.id)).not.toBeNull()
        expect(store.messages.getAllMessages(tenant.id)).toHaveLength(1)
        expect(engine.getMachine('target')).toBeUndefined()
        expect(store.machines.getMachine('target')).toBeNull()
        expect(store.machines.getMachine('other')).not.toBeNull()
        expect(events).toContainEqual({ type: 'machine-updated', machineId: 'target', namespace: 'default', data: null })
    })
    it('can clear session-only records without stopping another namespace runner of the same id', async () => {
        machine('shared-id', 'other')
        const ghost = session('ghost', 'shared-id')
        gateway.getMachineRunnerSocketId = () => { throw new Error('must not inspect another namespace runner') }
        expect(await engine.deleteMachine('shared-id', 'default')).toEqual({ ok: true, deletedSessions: 1 })
        expect(store.sessions.getSession(ghost.id)).toBeNull()
        expect(store.machines.getMachineByNamespace('shared-id', 'other')).not.toBeNull()
    })
    it('keeps all records on unconfirmed archive and releases its lock for retry', async () => {
        machine('target')
        const inactive = session('inactive', 'target')
        const active = session('active', 'target', 'default', true)
        gateway.killSession = async () => ({})
        gateway.stopRunnerSession = async () => 'still_alive'
        await expect(engine.deleteMachine('target', 'default')).rejects.toBeInstanceOf(ArchiveCleanupError)
        for (const row of [inactive, active]) expect(store.sessions.getSession(row.id)).not.toBeNull()
        expect(store.machines.getMachine('target')).not.toBeNull()
        expect(() => machine('target')).not.toThrow()
    })
    it('archives live sessions before stopping Runner, waits for disconnect and guards concurrent registrations', async () => {
        machine('target')
        const live = session('live', 'target', 'default', true)
        const order: string[] = []
        let runnerSocket: string | null = 'runner-socket'
        let release!: () => void
        let entered!: () => void
        const stopEntered = new Promise<void>(resolve => { entered = resolve })
        const stopGate = new Promise<void>(resolve => { release = resolve })
        gateway.killSession = async () => { order.push('kill'); return {} }
        gateway.stopRunnerSession = async () => { order.push('session-exited'); return 'already_gone' }
        gateway.getMachineRunnerSocketId = () => runnerSocket
        gateway.stopRunner = async () => {
            order.push('stop-runner'); entered(); await stopGate; runnerSocket = null
        }
        const deleting = engine.deleteMachine('target', 'default')
        await stopEntered
        expect(store.sessions.getSession(live.id)).not.toBeNull()
        expect(() => machine('target')).toThrow(MachineDeletionError)
        expect(() => session('new', 'target')).toThrow(MachineDeletionError)
        expect((await engine.resumeSession(live.id, 'default')).type).toBe('error')
        expect((await engine.reopenSession(live.id, 'default')).type).toBe('error')
        await expect(engine.deleteMachine('target', 'default')).rejects.toBeInstanceOf(MachineDeletionError)
        release()
        expect(await deleting).toEqual({ ok: true, deletedSessions: 1 })
        expect(order).toEqual(['kill', 'session-exited', 'stop-runner'])
        expect(() => machine('target')).not.toThrow()
    })
    it('preserves records if Runner reconnects during shutdown', async () => {
        machine('target')
        const row = session('inactive', 'target')
        let socket = 'original'
        gateway.getMachineRunnerSocketId = () => socket
        gateway.stopRunner = async () => { socket = 'replacement' }
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 409, code: 'machine_runner_reconnected' })
        expect(store.sessions.getSession(row.id)).not.toBeNull()
        expect(store.machines.getMachine('target')).not.toBeNull()
    })
    it('refuses active ghost cleanup when another namespace owns that machine id', async () => {
        machine('shared-id', 'other')
        const row = session('active-ghost', 'shared-id', 'default', true)
        gateway.killSession = async () => { throw new Error('must not issue cross-namespace RPC') }
        await expect(engine.deleteMachine('shared-id', 'default')).rejects.toMatchObject({ status: 409, code: 'machine_session_owner_mismatch' })
        expect(store.sessions.getSession(row.id)).not.toBeNull()
    })
    it('refuses a pending startup that targets another machine before any RPC', async () => {
        machine('target')
        const row = session('pending', 'target')
        const current = store.sessions.getSession(row.id)!
        store.sessions.updateSessionMetadata(row.id, {
            ...current.metadata as object,
            codexResumePending: { machineId: 'different', nativeSessionId: 'native', startedAt: Date.now() }
        }, current.metadataVersion, 'default')
        cache.refreshSession(row.id)
        gateway.killSession = async () => { throw new Error('must not issue cross-machine RPC') }
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 409, code: 'machine_session_owner_mismatch' })
        expect(store.sessions.getSession(row.id)).not.toBeNull()
    })
    it('rechecks machine ownership after the asynchronous session stop before any machine RPC', async () => {
        machine('target'); machine('different', 'other')
        const row = session('changing-owner', 'target', 'default', true)
        gateway.killSession = async () => {
            const current = store.sessions.getSession(row.id)!
            store.sessions.updateSessionMetadata(row.id, { ...current.metadata as object, machineId: 'different' }, current.metadataVersion, 'default')
            cache.refreshSession(row.id)
            return {}
        }
        let calls = 0
        gateway.stopRunnerSession = async () => { calls++; return 'already_gone' }
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 409, code: 'machine_session_owner_mismatch' })
        expect(calls).toBe(0)
        expect(store.sessions.getSession(row.id)).not.toBeNull()
        expect(store.messages.getAllMessages(row.id)).toHaveLength(1)
    })
    it('keeps offline records when an online device has no confirmed control channel', async () => {
        const device = machine('target')
        device.active = true
        const row = session('preserve', 'target')
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 503, code: 'machine_runner_unavailable' })
        expect(store.sessions.getSession(row.id)).not.toBeNull()
        expect(store.messages.getAllMessages(row.id)).toHaveLength(1)
    })
    it('preflights attached jobs before stopping sessions or deleting any record', async () => {
        machine('target')
        const row = session('job', 'target')
        store.sessionJobs.getPrimaryRunning = () => ({ id: 'running-job' } as never)
        gateway.killSession = async () => { throw new Error('must not stop job owner') }
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 409, code: 'machine_sessions_busy' })
        expect(store.sessions.getSession(row.id)).not.toBeNull()
        expect(store.messages.getAllMessages(row.id)).toHaveLength(1)
    })
    it('returns a namespace-scoped 404 without touching another device', async () => {
        machine('target', 'other')
        await expect(engine.deleteMachine('target', 'default')).rejects.toMatchObject({ status: 404, code: 'machine_not_found' })
        expect(store.machines.getMachine('target')).not.toBeNull()
    })
})
