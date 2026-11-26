import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

type AssignmentInput = {
    namespace: string
    listId: string
    taskId: string
    sessionId: string
    requestId: string
    text: string
}

export type TodoAssignmentRecord = AssignmentInput & {
    id: string
    localId: string
    createdAt: number
    updatedAt: number
    resultMessageId: string | null
    result: string | null
    completedAt: number | null
    releasedAt: number | null
}

type Outcome = { status: 'ok'; assignment: TodoAssignmentRecord }
    | { status: 'task_conflict' | 'session_conflict' | 'request_conflict' }

const columns = `id, namespace, list_id AS listId, task_id AS taskId, session_id AS sessionId,
    request_id AS requestId, local_id AS localId, text, created_at AS createdAt, updated_at AS updatedAt,
    result_message_id AS resultMessageId, result, completed_at AS completedAt, released_at AS releasedAt`

export class TodoAssignmentStore {
    constructor(private readonly db: Database) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS todo_assignments (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                list_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                local_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                result_message_id TEXT,
                result TEXT,
                completed_at INTEGER,
                released_at INTEGER,
                current INTEGER NOT NULL DEFAULT 1,
                UNIQUE(namespace, request_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS todo_assignment_task ON todo_assignments(namespace, list_id, task_id) WHERE current = 1;
            CREATE UNIQUE INDEX IF NOT EXISTS todo_assignment_session ON todo_assignments(namespace, session_id)
                WHERE current = 1 AND completed_at IS NULL AND released_at IS NULL;
        `)
    }

    byTask(namespace: string, listId: string, taskId: string): TodoAssignmentRecord | null {
        return this.db.query<TodoAssignmentRecord, [string, string, string]>(`
            SELECT ${columns} FROM todo_assignments WHERE namespace = ? AND list_id = ? AND task_id = ? AND current = 1
        `).get(namespace, listId, taskId)
    }

    list(namespace: string): TodoAssignmentRecord[] {
        return this.db.query<TodoAssignmentRecord, [string]>(`
            SELECT ${columns} FROM todo_assignments WHERE namespace = ? AND current = 1 ORDER BY updated_at DESC
        `).all(namespace)
    }

    private prior(input: AssignmentInput): Outcome | null {
        const prior = this.db.query<TodoAssignmentRecord, [string, string]>(`
            SELECT ${columns} FROM todo_assignments WHERE namespace = ? AND request_id = ?
        `).get(input.namespace, input.requestId)
        if (!prior) return null
        const current = this.byTask(input.namespace, input.listId, input.taskId)
        return current?.id === prior.id && prior.sessionId === input.sessionId && prior.text === input.text
            ? { status: 'ok', assignment: current }
            : { status: 'request_conflict' }
    }

    private insert(input: AssignmentInput): Outcome {
        const id = randomUUID()
        const localId = 'todo-assign:' + id
        const now = Date.now()
        this.db.query(`
            INSERT INTO todo_assignments (id, namespace, list_id, task_id, session_id, request_id, local_id, text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, input.namespace, input.listId, input.taskId, input.sessionId, input.requestId, localId, input.text, now, now)
        return { status: 'ok', assignment: {
            ...input, id, localId, createdAt: now, updatedAt: now, resultMessageId: null, result: null, completedAt: null, releasedAt: null,
        } }
    }

    reserve(input: AssignmentInput): Outcome {
        return this.db.transaction((): Outcome => {
            const prior = this.prior(input)
            if (prior) return prior
            const current = this.byTask(input.namespace, input.listId, input.taskId)
            if (current && current.completedAt === null && current.releasedAt === null) return { status: 'task_conflict' }
            const occupied = this.db.query(`
                SELECT 1 FROM todo_assignments
                WHERE namespace = ? AND session_id = ? AND current = 1 AND completed_at IS NULL AND released_at IS NULL
            `).get(input.namespace, input.sessionId)
            if (occupied) return { status: 'session_conflict' }
            if (current) this.db.query('UPDATE todo_assignments SET current = 0 WHERE id = ?').run(current.id)
            return this.insert(input)
        }).immediate()
    }

    continue(assignment: TodoAssignmentRecord, requestId: string, text: string): Outcome {
        const { namespace, listId, taskId, sessionId } = assignment
        const input = { namespace, listId, taskId, sessionId, requestId, text }
        return this.db.transaction((): Outcome => {
            const prior = this.prior(input)
            if (prior) return prior
            const replaced = this.db.query(`
                UPDATE todo_assignments SET current = 0
                WHERE id = ? AND current = 1 AND completed_at IS NULL AND released_at IS NULL AND updated_at = ?
            `).run(assignment.id, assignment.updatedAt)
            if (!replaced.changes) return { status: 'task_conflict' }
            return this.insert(input)
        }).immediate()
    }

    linkResult(assignment: TodoAssignmentRecord, messageId: string, text: string): TodoAssignmentRecord | null {
        const updatedAt = Math.max(Date.now(), assignment.updatedAt + 1)
        const changed = this.db.query(`
            UPDATE todo_assignments SET result_message_id = ?, result = ?, updated_at = ?
            WHERE id = ? AND current = 1 AND completed_at IS NULL AND released_at IS NULL AND updated_at = ?
        `).run(messageId, text, updatedAt, assignment.id, assignment.updatedAt)
        return changed.changes ? { ...assignment, resultMessageId: messageId, result: text, updatedAt } : null
    }

    complete(assignment: TodoAssignmentRecord): TodoAssignmentRecord | null {
        const completedAt = Math.max(Date.now(), assignment.updatedAt + 1)
        const changed = this.db.query(`
            UPDATE todo_assignments SET completed_at = ?, updated_at = ?
            WHERE id = ? AND current = 1 AND completed_at IS NULL AND updated_at = ?
                AND (result_message_id IS NOT NULL OR released_at IS NOT NULL)
        `).run(completedAt, completedAt, assignment.id, assignment.updatedAt)
        return changed.changes ? { ...assignment, completedAt, updatedAt: completedAt } : null
    }

    release(assignment: TodoAssignmentRecord): TodoAssignmentRecord | null {
        if (assignment.releasedAt !== null) return assignment
        const releasedAt = Math.max(Date.now(), assignment.updatedAt + 1)
        const changed = this.db.query(`
            UPDATE todo_assignments SET released_at = ?, updated_at = ?
            WHERE id = ? AND current = 1 AND completed_at IS NULL AND released_at IS NULL AND updated_at = ?
        `).run(releasedAt, releasedAt, assignment.id, assignment.updatedAt)
        return changed.changes ? { ...assignment, releasedAt, updatedAt: releasedAt } : null
    }
}
