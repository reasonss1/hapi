import { describe, expect, it, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createTodoRoutes } from './todo'

const namespace = 'owner'
const route = '/api/todo/lists/list/tasks/task'

async function assigned(response: Response) {
    const payload = await response.json() as { assignment: { sessionId: string; phase: string } }
    return payload.assignment
}

function fixture() {
    const store = new Store(':memory:')
    let liveSession: { active: boolean; id: string; metadata: { machineId: string; flavor: string } } | undefined
    let spawnMode: 'success' | 'uncertain' | 'rejected' | 'preclaim-failure' = 'success'
    const spawnSession = mock(async (...args: Parameters<SyncEngine['spawnSession']>) => {
        const reservation = args[17]
        if (!reservation) throw new Error('Expected trusted reservation')
        if (spawnMode === 'preclaim-failure') throw new Error('Simulate stopping before durable claim')
        expect(reservation.claim()).toBe(true)
        if (spawnMode === 'uncertain') return { type: 'error' as const, message: 'lost spawn reply' }
        if (spawnMode === 'rejected') return { type: 'error' as const, message: 'not spawned', childStarted: false as const }
        awaken(reservation.sessionId)
        return { type: 'success' as const, sessionId: reservation.sessionId }
    })
    const sendMessage = mock(async (sessionId: string, { localId, text }: Parameters<SyncEngine['sendMessage']>[1]) => {
        if (typeof localId !== 'string') throw new Error('Expected stable message identity')
        store.sessions.getOrCreateSession('task-session', null, null, namespace, undefined, undefined, undefined, sessionId)
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId)
    })
    const engine = {
        getMachineByNamespace: (machineId: string, authorized: string) => machineId !== 'device' || authorized !== namespace ? undefined : ({
            active: true,
            metadata: {
                platform: 'linux', homeDir: '/fallback', workspaceRoots: ['/project'],
                capabilities: [MACHINE_CAPABILITIES.AgentAvailability],
            },
        }),
        getSessionByNamespace: (id: string) => liveSession?.id === id ? liveSession : undefined,
        spawnSession,
        sendMessage,
    } as unknown as SyncEngine
    const getTask = mock(async () => ({
        id: 'task', title: 'Fix a test', status: 'notStarted', body: null,
        checklist: [], importance: null, dueDateTime: null,
    }))
    const connector = {
        listLists: async () => [],
        listTasks: async () => ({ tasks: [], nextCursor: null }),
        getTask,
        completeTask: async () => {},
    }
    function makeApp(userNamespace = namespace) {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', userNamespace); await next() })
        app.route('/api/todo', createTodoRoutes(store, () => engine, { namespace, connector }))
        return (path: string, data: unknown) => app.request(route + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        })
    }
    function awaken(sessionId: string) {
        liveSession = { id: sessionId, metadata: { machineId: 'device', flavor: 'codex' }, active: true }
    }
    return { store, makeApp, awaken, spawnSession, sendMessage, getTask, mode: (mode: typeof spawnMode) => { spawnMode = mode } }
}

describe('assigning a Todo to a device', () => {
    it('uses the first workspace and fixed fresh Codex ID for duplicate clicks', async () => {
        const f = fixture()
        try {
            const post = f.makeApp()
            const body = { machineId: 'device', requestId: randomUUID() }
            const responses = await Promise.all([post('/assign', body), post('/assign', body)])
            const [one, two] = await Promise.all(responses.map(assigned))
            expect(responses.map((response) => response.status)).toEqual([200, 200])
            expect(one.sessionId).toBe(two.sessionId)
            expect(f.spawnSession).toHaveBeenCalledTimes(1)
            expect(f.spawnSession.mock.calls[0]?.slice(0, 3)).toEqual(['device', '/project', 'codex'])
            expect(f.sendMessage).toHaveBeenCalledTimes(1)
            expect(f.sendMessage.mock.calls[0]?.[0]).toBe(one.sessionId)
        } finally { f.store.close() }
    })

    it('resumes only delivery after an uncertain spawn when the reserved session registers', async () => {
        const f = fixture()
        try {
            const body = { machineId: 'device', requestId: randomUUID(), path: '/project/custom' }
            f.mode('uncertain')
            const first = await f.makeApp()('/assign', body)
            expect(first.status).toBe(200)
            const pending = await assigned(first)
            expect(pending.phase).toBe('indeterminate')
            const restarted = f.makeApp()
            const retry = await restarted('/assign', body)
            expect((await assigned(retry)).sessionId).toBe(pending.sessionId)
            f.awaken(pending.sessionId)
            expect((await restarted('/assign', body)).status).toBe(200)
            expect(f.spawnSession).toHaveBeenCalledTimes(1)
            expect(f.sendMessage).toHaveBeenCalledTimes(1)
        } finally { f.store.close() }
    })

    it('retries a pre-dispatch interruption with the same session ID after recreating the router', async () => {
        const f = fixture()
        try {
            const body = { machineId: 'device', requestId: randomUUID() }
            f.mode('preclaim-failure')
            expect((await f.makeApp()('/assign', body)).status).toBe(503)
            const pending = f.store.todoAssignments.byTask(namespace, 'list', 'task')
            if (!pending) throw new Error('Missing assignment')
            expect(pending.spawnDispatchedAt).toBeNull()
            f.mode('success')
            const retry = await f.makeApp()('/retry', {})
            expect(retry.status).toBe(200)
            expect((await assigned(retry)).sessionId).toBe(pending.sessionId)
            expect(f.spawnSession.mock.calls.map((args) => args[17]?.sessionId)).toEqual([pending.sessionId, pending.sessionId])
            expect(f.sendMessage).toHaveBeenCalledTimes(1)
        } finally { f.store.close() }
    })

    it('does not deliver a stale retry when the assignment is released during the task lookup', async () => {
        const f = fixture()
        try {
            const body = { machineId: 'device', requestId: randomUUID() }
            const post = f.makeApp()
            f.mode('uncertain')
            const initial = await assigned(await post('/assign', body))
            f.awaken(initial.sessionId)
            let unblock!: () => void
            let reading!: () => void
            const blocked = new Promise<void>((resolve) => { unblock = resolve })
            const started = new Promise<void>((resolve) => { reading = resolve })
            const source = await f.getTask()
            f.getTask.mockImplementation(async () => {
                reading()
                await blocked
                return source
            })
            const retry = post('/assign', body)
            await started
            const latest = f.store.todoAssignments.byTask(namespace, 'list', 'task')
            if (!latest) throw new Error('Missing assignment')
            expect(f.store.todoAssignments.release(latest)).not.toBeNull()
            unblock()
            expect((await assigned(await retry)).phase).toBe('released')
            expect(f.spawnSession).toHaveBeenCalledTimes(1)
            expect(f.sendMessage).not.toHaveBeenCalled()
        } finally { f.store.close() }
    })

    it('rejects initial session targets, inactive or unowned devices and relative paths before reading a task', async () => {
        const f = fixture()
        try {
            const post = f.makeApp()
            const requestId = randomUUID()
            expect((await post('/assign', { sessionId: 'old-session', requestId })).status).toBe(400)
            expect((await post('/assign', { machineId: 'device', sessionId: 'old-session', requestId })).status).toBe(400)
            expect((await post('/assign', { machineId: 'unknown', requestId })).status).toBe(409)
            expect((await post('/assign', { machineId: 'device', path: 'relative', requestId })).status).toBe(409)
            expect((await f.makeApp('neighbor')('/assign', { machineId: 'device', requestId })).status).toBe(404)
            expect(f.getTask).not.toHaveBeenCalled()
            expect(f.spawnSession).not.toHaveBeenCalled()
        } finally { f.store.close() }
    })
})
