import { describe, expect, it, spyOn } from 'bun:test'
import { TodoMcp } from './todoMcp'

type ConnectorTransport = {
    call(tool: string, args: Record<string, unknown>): Promise<unknown>
}

describe('Todo MCP reads', () => {
    it('shares concurrent reads, keeps fresh writes independent, and invalidates affected pages on completion', async () => {
        const connector = new TodoMcp('/unused-in-test')
        let status = 'notStarted'
        const body = { id: 'task', title: 'Task' }
        const transport = spyOn(connector as unknown as ConnectorTransport, 'call')
            .mockImplementation(async (tool) => {
                switch (tool) {
                    case 'list-todo-task-lists':
                        return { value: [{ id: 'list', displayName: 'List' }] }
                    case 'list-todo-tasks':
                        return { value: [{ ...body, status }] }
                    case 'get-todo-task':
                        return { ...body, status }
                    case 'update-todo-task':
                        status = 'completed'
                        return {}
                    default:
                        throw new Error(tool)
                }
            })

        await Promise.all([connector.listLists(), connector.listLists()])
        const [first, second] = await Promise.all([connector.listTasks('list'), connector.listTasks('list')])
        expect(first).toBe(second)
        expect(transport.mock.calls.map(([tool]) => tool)).toEqual(['list-todo-task-lists', 'list-todo-tasks'])
        await connector.listTasks('list', 'skip:30')
        await connector.listTasks('other')
        await connector.getTask('list', 'task')
        await connector.getTask('list', 'task')
        await connector.getTask('list', 'task', { fresh: true })
        expect(transport.mock.calls.filter(([tool]) => tool === 'get-todo-task')).toHaveLength(2)

        await connector.completeTask('list', 'task')
        expect((await connector.listTasks('list')).tasks[0]?.status).toBe('completed')
        expect((await connector.listTasks('list', 'skip:30')).tasks[0]?.status).toBe('completed')
        expect((await connector.listTasks('other')).tasks[0]?.status).toBe('notStarted')
        expect((await connector.getTask('list', 'task')).status).toBe('completed')
    })

    it('retries a failed shared read', async () => {
        const connector = new TodoMcp('/unused-in-test')
        const transport = spyOn(connector as unknown as ConnectorTransport, 'call')
            .mockRejectedValueOnce(new Error('unavailable'))
            .mockResolvedValueOnce({ value: [] })

        await expect(connector.listLists()).rejects.toThrow('unavailable')
        await expect(connector.listLists()).resolves.toEqual([])
        expect(transport).toHaveBeenCalledTimes(2)
    })

})
