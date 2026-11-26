import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoAssignmentStore } from './todoAssignments'

const task = {
    namespace: 'owner', listId: 'list', taskId: 'task', sessionId: 'session',
    requestId: 'original', text: 'Do the original task',
}

describe('Todo assignment persistence', () => {
    it('preserves the original delivery key on restart and rejects stale or occupied assignments', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-todo-store-'))
        let db: Database | undefined
        try {
            const path = join(directory, 'db')
            db = new Database(path)
            const initial = new TodoAssignmentStore(db).reserve(task)
            if (initial.status !== 'ok') throw new Error(initial.status)
            db.close()

            db = new Database(path)
            const store = new TodoAssignmentStore(db)
            expect(store.reserve(task)).toEqual(initial)
            expect(store.reserve({ ...task, text: 'Changed text' }).status).toBe('request_conflict')
            expect(store.reserve({ ...task, taskId: 'other', requestId: 'another' }).status).toBe('session_conflict')
            expect(store.list('other')).toEqual([])

            const continued = store.continue(initial.assignment, 'followup', 'New instructions')
            if (continued.status !== 'ok') throw new Error(continued.status)
            expect(continued.assignment.localId).not.toBe(initial.assignment.localId)
            expect(store.byTask('owner', 'list', 'task')).toEqual(continued.assignment)
            expect(store.reserve(task).status).toBe('request_conflict')
            expect(store.linkResult(initial.assignment, 'old-reply', 'stale')).toBeNull()
            expect(store.release(continued.assignment)?.completedAt).toBeNull()
            expect(store.reserve({ ...task, taskId: 'other', requestId: 'another' }).status).toBe('ok')
        } finally {
            db?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
