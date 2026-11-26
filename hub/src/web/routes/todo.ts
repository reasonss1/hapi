import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isObject } from '@hapi/protocol'
import { extractAssistantPlainText, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { z } from 'zod'
import type { Store } from '../../store'
import type { TodoAssignmentRecord } from '../../store/todoAssignments'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { TodoMcp, TodoMcpError, type TodoSourceTask } from '../todoMcp'

const delivery = z.object({
    requestId: z.string().uuid(),
    notes: z.string().trim().max(6000).optional(),
})
const assignBody = delivery.extend({ sessionId: z.string().min(1).max(128) }).strict()
const continueBody = delivery.extend({ notes: z.string().trim().min(1).max(6000) }).strict()
const resultBody = z.object({ messageId: z.string().min(1).max(128) }).strict()
const externalId = z.string().min(1).max(512).regex(/^[A-Za-z0-9_=+.-]+$/)

type Phase = 'queued' | 'assigned' | 'running' | 'waiting' | 'ready' | 'offline' | 'indeterminate' | 'failed' | 'completed' | 'released'

function progressFrom(value: Record<string, unknown>, turn: string) {
    const input = isObject(value.input) ? value.input : null
    const plan = value.type === 'plan_update' ? value.plan : value.name === 'update_plan' ? input?.plan : null
    if (!Array.isArray(plan) || !plan.length ||
        value.turn_id !== turn && value.turnId !== turn && value.callId !== 'codex-plan-state:' + turn) return null
    const steps = plan.filter((step) => isObject(step) && typeof step.step === 'string')
    if (!steps.length) return null
    const current = steps.find((step) => step.status === 'in_progress')?.step
    return {
        completed: steps.filter((step) => step.status === 'completed').length,
        total: steps.length,
        current: typeof current === 'string' ? current.slice(0, 500) : null,
    }
}

function inspectAssignment(store: Store, engine: SyncEngine | null, assignment: TodoAssignmentRecord, includeResults = false) {
    const { sessionId, namespace, localId, updatedAt, completedAt, releasedAt, result, resultMessageId } = assignment
    const session = engine?.getSessionByNamespace(sessionId, namespace)
    const delivery = store.messages.lookupQueuedMessage(sessionId, localId)
    const message = delivery.status === 'invoked' ? delivery.message : null
    const invocation = message?.invokedAt
    const turn = session?.metadata?.conversationHistoryTurns?.[localId]
    const results: Array<{ id: string; text: string; createdAt: number }> = []
    let latestProgress: ReturnType<typeof progressFrom> = null
    let progressAt = 0
    let replyAt = 0

    if (turn && invocation != null) {
        for (const row of store.messages.getMessages(sessionId, 200)) {
            if (row.createdAt < invocation) continue
            const envelope = unwrapRoleWrappedRecordEnvelope(row.content)
            if (envelope?.role !== 'agent' && envelope?.role !== 'assistant') continue
            const content = envelope.content
            if (!isObject(content) || content.type !== 'codex' || !isObject(content.data)) continue
            const data = content.data
            const progress = progressFrom(data, turn)
            if (progress && row.createdAt >= progressAt) {
                latestProgress = progress
                progressAt = row.createdAt
            }
            if (data.turn_id !== turn && data.turnId !== turn) continue
            const text = extractAssistantPlainText(content)?.trim()
            if (text) {
                replyAt = Math.max(replyAt, row.createdAt)
                if (includeResults) results.push({ id: row.id, text: text.slice(0, 12_000), createdAt: row.createdAt })
            }
        }
    }

    let phase: Phase = 'assigned'
    if (completedAt !== null) phase = 'completed'
    else if (releasedAt !== null) phase = 'released'
    else if (resultMessageId) phase = 'ready'
    else if (!session?.active) phase = 'offline'
    else if (delivery.status === 'absent') phase = 'failed'
    else if (delivery.status === 'indeterminate' || delivery.status === 'dispatching') phase = 'indeterminate'
    else if (delivery.status === 'queued') phase = 'queued'
    else if (message && session.activeTurnStartedAt != null && invocation != null
        && session.activeTurnStartedAt >= message.createdAt && session.activeTurnStartedAt <= invocation) {
        const pending = Object.values(session.agentState?.requests ?? {}).some((request) => {
            return typeof request.createdAt === 'number' && request.createdAt >= invocation
        })
        if (pending) phase = 'waiting'
        else if (session.thinking) phase = 'running'
    }

    return {
        view: {
            id: assignment.id,
            sessionId,
            phase,
            updatedAt: Math.max(updatedAt, progressAt, replyAt, invocation ?? 0),
            progress: latestProgress,
            result,
            resultMessageId,
        },
        results: results.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
    }
}

function messageFor(task: TodoSourceTask, notes?: string) {
    const checklist = task.checklist.map((item) => (item.isChecked ? '[x] ' : '[ ] ') + item.displayName)
    return [
        'Please work on the following Microsoft To Do task in this session and report the result here.',
        'Leave the Microsoft To Do completion state for me to confirm.',
        'Task: ' + task.title.slice(0, 1000),
        task.body?.slice(0, 12_000),
        ...checklist.slice(0, 40).map((entry) => entry.slice(0, 500)),
        notes && 'Additional instructions: ' + notes,
    ].filter(Boolean).join('\n\n')
}

export function createTodoRoutes(store: Store, getEngine: () => SyncEngine | null, config: {
    namespace: string
    connector: Pick<TodoMcp, 'listLists' | 'listTasks' | 'getTask' | 'completeTask'>
} | null) {
    const app = new Hono<WebAppEnv>()
    const assignments = store.todoAssignments
    const inFlight = new Map<string, Promise<void>>()
    const completing = new Set<string>()

    async function deliver(engine: SyncEngine, assignment: TodoAssignmentRecord) {
        const { id, sessionId, localId, text } = assignment
        if (store.messages.getLocalMessageStates(sessionId, [localId]).length) return
        let work = inFlight.get(id)
        if (!work) {
            work = engine.sendMessage(sessionId, { localId, text, deliveryMode: 'queue', sentFrom: 'webapp' })
                .finally(() => inFlight.delete(id))
            inFlight.set(id, work)
        }
        try {
            await work
        } catch (error) {
            if (!store.messages.getLocalMessageStates(sessionId, [localId]).length) throw error
        }
    }

    app.get('/status', (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json({ available: config !== null && c.get('namespace') === config.namespace })
    })
    if (!config) return app
    const { connector, namespace } = config
    app.use('*', bodyLimit({ maxSize: 16_384 }), async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (c.get('namespace') !== namespace) return c.json({ error: 'Todo unavailable' }, 404)
        return await next()
    })
    app.onError((error, c) => {
        if (error instanceof TodoMcpError) {
            return c.json({ error: error.code, code: error.code }, error.code === 'todo_missing' ? 404 : 503)
        }
        return c.json({ error: 'Todo request failed', code: 'todo_unavailable' }, 503)
    })

    const taskRoute = '/lists/:listId/tasks/:taskId'
    app.use('/lists/:listId/*', async (c, next) => {
        if (!externalId.safeParse(c.req.param('listId')).success) return c.json({ error: 'Invalid list ID' }, 400)
        return await next()
    })
    app.use(taskRoute, async (c, next) => {
        if (!externalId.safeParse(c.req.param('taskId')).success) return c.json({ error: 'Invalid task ID' }, 400)
        return await next()
    })
    app.use(taskRoute + '/*', async (c, next) => {
        if (!externalId.safeParse(c.req.param('taskId')).success) return c.json({ error: 'Invalid task ID' }, 400)
        return await next()
    })

    function withAssignment(listId: string, task: TodoSourceTask) {
        const record = assignments.byTask(namespace, listId, task.id)
        return { ...task, assignment: record ? inspectAssignment(store, getEngine(), record).view : null }
    }

    app.get('/lists', async (c) => c.json({ lists: await connector.listLists() }))
    app.get('/assignments', (c) => c.json({
        assignments: assignments.list(namespace).map((record) => ({
            listId: record.listId,
            taskId: record.taskId,
            ...inspectAssignment(store, getEngine(), record).view,
        })),
    }))
    app.get('/lists/:listId/tasks', async (c) => {
        const listId = c.req.param('listId')
        const cursor = c.req.query('cursor')
        if (cursor !== undefined && !/^(?:skip:\d{1,7}|token:.{1,3000})$/.test(cursor)) {
            return c.json({ error: 'Invalid cursor' }, 400)
        }
        const { tasks, nextCursor } = await connector.listTasks(listId, cursor)
        return c.json({ tasks: tasks.map((task) => withAssignment(listId, task)), nextCursor })
    })
    app.get(taskRoute, async (c) => {
        const { listId, taskId } = c.req.param()
        const task = await connector.getTask(listId, taskId)
        const record = assignments.byTask(namespace, listId, taskId)
        const detail = record ? inspectAssignment(store, getEngine(), record, true) : null
        return c.json({ task: { ...task, assignment: detail?.view ?? null }, results: detail?.results ?? [] })
    })

    function getAvailableSession(engine: SyncEngine, sessionId: string, ignoreLocalId?: string) {
        const session = engine.getSessionByNamespace(sessionId, namespace)
        if (!session?.active || session.metadata?.flavor !== 'codex' || session.thinking
            || session.agentState?.controlledByUser === true
            || Object.keys(session.agentState?.requests ?? {}).length > 0) return null
        const queued = store.messages.getUninvokedLocalMessages(sessionId, { deliverableOnly: true })
        if (queued.some((message) => message.localId !== ignoreLocalId)) return null
        return session
    }

    app.post(`${taskRoute}/assign`, async (c) => {
        const { listId, taskId } = c.req.param()
        const parsed = assignBody.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid assignment' }, 400)
        if (completing.has(JSON.stringify([listId, taskId]))) return c.json({ error: 'Completion in progress' }, 409)
        const engine = getEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const { sessionId, requestId, notes } = parsed.data
        const previous = assignments.byTask(namespace, listId, taskId)
        if (previous?.requestId === requestId && previous.sessionId === sessionId) {
            if (!previous.completedAt && !previous.releasedAt && getAvailableSession(engine, sessionId, previous.localId)) {
                await deliver(engine, previous)
            }
            return c.json({ assignment: inspectAssignment(store, engine, previous).view })
        }
        if (!getAvailableSession(engine, sessionId)) return c.json({ error: 'Session not available', code: 'todo_session_unavailable' }, 409)
        const task = await connector.getTask(listId, taskId)
        if (task.status === 'completed' || completing.has(JSON.stringify([listId, taskId]))) {
            return c.json({ error: 'Task is complete or syncing' }, 409)
        }
        if (!getAvailableSession(engine, sessionId)) return c.json({ error: 'Session not available', code: 'todo_session_unavailable' }, 409)
        const reserved = assignments.reserve({ namespace, listId, taskId, sessionId, requestId, text: messageFor(task, notes) })
        if (reserved.status !== 'ok') return c.json({ error: reserved.status, code: reserved.status }, 409)
        const assignment = reserved.assignment
        if (!assignment.completedAt) await deliver(engine, assignment)
        return c.json({ assignment: inspectAssignment(store, engine, assignment).view })
    })

    app.post(`${taskRoute}/result`, async (c) => {
        const { listId, taskId } = c.req.param()
        const parsed = resultBody.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid result' }, 400)
        const assignment = assignments.byTask(namespace, listId, taskId)
        if (!assignment) return c.json({ error: 'Assignment not found' }, 404)
        if (completing.has(assignment.id) || assignment.completedAt || assignment.releasedAt) return c.json({ error: 'Assignment unavailable' }, 409)
        const engine = getEngine()
        const { results } = inspectAssignment(store, engine, assignment, true)
        const selected = results.find(({ id }) => id === parsed.data.messageId)
        if (!selected) return c.json({ error: 'Reply does not belong to this assignment' }, 409)
        const updated = assignments.linkResult(assignment, selected.id, selected.text)
        if (!updated) return c.json({ error: 'Assignment changed' }, 409)
        return c.json({ assignment: inspectAssignment(store, engine, updated).view })
    })

    app.post(`${taskRoute}/continue`, async (c) => {
        const { listId, taskId } = c.req.param()
        const parsed = continueBody.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid instructions' }, 400)
        const engine = getEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const assignment = assignments.byTask(namespace, listId, taskId)
        if (!assignment) return c.json({ error: 'Assignment not found' }, 404)
        if (completing.has(assignment.id) || assignment.completedAt || assignment.releasedAt) return c.json({ error: 'Assignment unavailable' }, 409)
        if (assignment.requestId === parsed.data.requestId) {
            if (getAvailableSession(engine, assignment.sessionId, assignment.localId)) await deliver(engine, assignment)
            return c.json({ assignment: inspectAssignment(store, engine, assignment).view })
        }
        const phase = inspectAssignment(store, engine, assignment).view.phase
        if (!['assigned', 'ready'].includes(phase) || !getAvailableSession(engine, assignment.sessionId)) {
            return c.json({ error: 'Assignment is still running or unavailable' }, 409)
        }
        const task = await connector.getTask(listId, taskId)
        if (task.status === 'completed' || completing.has(assignment.id) || !getAvailableSession(engine, assignment.sessionId)) {
            return c.json({ error: 'Task or session no longer available' }, 409)
        }
        const updated = assignments.continue(assignment, parsed.data.requestId, messageFor(task, parsed.data.notes))
        if (updated.status !== 'ok') return c.json({ error: updated.status, code: updated.status }, 409)
        await deliver(engine, updated.assignment)
        return c.json({ assignment: inspectAssignment(store, engine, updated.assignment).view })
    })

    app.post(`${taskRoute}/retry`, async (c) => {
        const { listId, taskId } = c.req.param()
        const assignment = assignments.byTask(namespace, listId, taskId)
        if (!assignment) return c.json({ error: 'Assignment not found' }, 404)
        const engine = getEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        if (assignment.releasedAt || assignment.completedAt || completing.has(assignment.id)) {
            return c.json({ error: 'Assignment unavailable' }, 409)
        }
        const current = inspectAssignment(store, engine, assignment).view
        if (current.phase === 'failed') {
            const source = await connector.getTask(listId, taskId)
            const latest = assignments.byTask(namespace, listId, taskId)
            if (source.status === 'completed' || latest?.id !== assignment.id || latest.releasedAt || latest.completedAt) {
                return c.json({ error: 'Task or assignment changed' }, 409)
            }
            if (!getAvailableSession(engine, assignment.sessionId)) return c.json({ error: 'Session not available' }, 409)
            await deliver(engine, assignment)
        } else if (current.phase === 'offline' || current.phase === 'indeterminate') {
            return c.json({ error: 'Assignment cannot be retried' }, 409)
        }
        return c.json({ assignment: inspectAssignment(store, engine, assignment).view })
    })

    app.post(`${taskRoute}/release`, async (c) => {
        const { listId, taskId } = c.req.param()
        const assignment = assignments.byTask(namespace, listId, taskId)
        if (!assignment) return c.json({ error: 'Assignment not found' }, 404)
        const engine = getEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const current = inspectAssignment(store, engine, assignment).view
        if (current.phase === 'released') return c.json({ assignment: current })
        const terminalSource = await connector.getTask(listId, taskId).then((task) => task.status === 'completed', (error) => {
            if (error instanceof TodoMcpError && error.code === 'todo_missing') return true
            if (current.phase === 'failed' || current.phase === 'offline') return false
            throw error
        })
        const phase = inspectAssignment(store, engine, assignment).view.phase
        if ((!terminalSource && !['failed', 'offline'].includes(phase)) ||
            completing.has(assignment.id) || inFlight.has(assignment.id)) return c.json({ error: 'Assignment unavailable' }, 409)
        const updated = assignments.release(assignment)
        if (!updated) return c.json({ error: 'Assignment changed' }, 409)
        return c.json({ assignment: inspectAssignment(store, engine, updated).view })
    })

    app.post(`${taskRoute}/complete`, async (c) => {
        const { listId, taskId } = c.req.param()
        const taskKey = JSON.stringify([listId, taskId])
        const assignment = assignments.byTask(namespace, listId, taskId)
        if (assignment && !assignment.resultMessageId && !assignment.releasedAt) return c.json({ error: 'Select an assignment result first' }, 409)
        if (completing.has(taskKey)) return c.json({ error: 'Completion in progress' }, 409)
        completing.add(taskKey)
        if (assignment) completing.add(assignment.id)
        try {
            const task = await connector.getTask(listId, taskId)
            const current = assignments.byTask(namespace, listId, taskId)
            if (current?.id !== assignment?.id || current?.resultMessageId !== assignment?.resultMessageId) {
                return c.json({ error: 'Assignment changed' }, 409)
            }
            if (task.status !== 'completed') await connector.completeTask(listId, taskId)
            if (assignment && !assignment.completedAt && !assignments.complete(assignment)) {
                return c.json({ error: 'Assignment changed' }, 409)
            }
            return c.json({ task: withAssignment(listId, { ...task, status: 'completed' }) })
        } finally {
            completing.delete(taskKey)
            if (assignment) completing.delete(assignment.id)
        }
    })

    return app
}
