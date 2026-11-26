import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const id = z.string().min(1).max(512).regex(/^[A-Za-z0-9_=+.-]+$/)
const task = z.object({
    id,
    title: z.string(),
    status: z.string(),
    body: z.object({ contentType: z.string().optional(), content: z.string().nullish() }).nullish(),
    dueDateTime: z.object({ dateTime: z.string(), timeZone: z.string() }).nullish(),
    importance: z.string().nullish(),
    checklistItems: z.array(z.object({ id, displayName: z.string(), isChecked: z.boolean().nullish() })).nullish(),
})
const list = z.object({ id, displayName: z.string() })
const collections = <T extends z.ZodType>(item: T) => z.object({
    value: z.array(item),
    '@odata.nextLink': z.string().optional(),
})

export class TodoMcpError extends Error {
    constructor(readonly code: 'todo_unavailable' | 'todo_missing' | 'todo_unauthorized') {
        super(code)
    }
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
    let value: unknown = result.structuredContent
    const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : []
    const raw = content.find((part) => part.type === 'text')?.text
    if (value === undefined && raw && raw.length < 2 * 1024 * 1024) {
        try { value = JSON.parse(raw) } catch { /* The provider can return a plain error. */ }
    }
    const error = value && typeof value === 'object' && 'error' in value ? value.error : null
    const status = Number(result._meta?.http_status)
    if (result.isError || error || status >= 400) {
        const hint = [raw, error && JSON.stringify(error)].join(' ')
        if (status === 404 || /ErrorItemNotFound|ResourceNotFound|HTTP (?:Error: )?404|\bitemNotFound\b/i.test(hint)) throw new TodoMcpError('todo_missing')
        if (status === 401 || /interaction_required|invalid_grant|not logged in|not authenticated|no accounts found/i.test(hint)) throw new TodoMcpError('todo_unauthorized')
        throw new TodoMcpError('todo_unavailable')
    }
    return value
}

type Tool = 'list-todo-task-lists' | 'list-todo-tasks' | 'get-todo-task' | 'update-todo-task'
const timeout = 10_000
const pageSize = 30

function nextPage(link: string | undefined, expectedPath: string): string | null {
    if (!link) return null
    const url = new URL(link)
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password ||
        decodeURIComponent(url.pathname) !== expectedPath) throw new TodoMcpError('todo_unavailable')
    const token = url.searchParams.get('$skiptoken')
    if (token && token.length <= 3000) return 'token:' + token
    const skip = url.searchParams.get('$skip')
    return skip && /^\d{1,7}$/.test(skip) ? 'skip:' + skip : null
}

function pagination(cursor?: string) {
    if (cursor?.startsWith('token:') && cursor.length <= 3006 && cursor.length > 6) {
        return { skiptoken: cursor.slice(6) }
    }
    if (cursor && /^skip:\d{1,7}$/.test(cursor)) return { skip: Number(cursor.slice(5)) }
    return {}
}

function plainText(content: string) {
    return content.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, '')
        .replace(/<br\b[^>]*>|<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (token) => ({
            '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
        })[token] ?? token)
}

function normalizeTask(value: z.infer<typeof task>) {
    const content = value.body?.content ?? ''
    return {
        id: value.id, title: value.title, status: value.status,
        body: (value.body?.contentType === 'html' ? plainText(content) : content).trim() || null,
        dueDateTime: value.dueDateTime ?? null, importance: value.importance ?? null,
        checklist: (value.checklistItems ?? []).map(({ id, displayName, isChecked }) => ({
            id, displayName, isChecked: isChecked === true,
        })),
    }
}

export type TodoSourceTask = ReturnType<typeof normalizeTask>

export class TodoMcp {
    private client: Promise<Client> | undefined

    constructor(private readonly command: string) {
        if (!isAbsolute(command)) throw new Error('HAPI_TODO_MCP_COMMAND requires an absolute path')
    }

    private connect() {
        const client = new Client({ name: 'hapi-todo', version: '1.0.0' })
        const transport = new StdioClientTransport({ command: this.command, stderr: 'ignore' })
        client.onerror = () => {}
        const connected = client.connect(transport, { timeout }).then(() => client).catch(async () => {
            await client.close().catch(() => undefined)
            throw new TodoMcpError('todo_unavailable')
        })
        this.client = connected
        client.onclose = () => {
            if (this.client === connected) this.client = undefined
        }
        return connected
    }

    private async call(tool: Tool, args: Record<string, unknown>) {
        const client = await (this.client ?? this.connect())
        try {
            return parseResult(await client.callTool({ name: tool, arguments: args }, undefined, { timeout }))
        } catch (error) {
            if (error instanceof TodoMcpError) throw error
            await client.close().catch(() => undefined)
            throw new TodoMcpError('todo_unavailable')
        }
    }

    async listLists() {
        const lists: z.infer<typeof list>[] = []
        const seen = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
            const result = collections(list).parse(await this.call('list-todo-task-lists', {
                top: pageSize, ...pagination(cursor),
            }))
            lists.push(...result.value)
            const next = nextPage(result['@odata.nextLink'], '/v1.0/me/todo/lists')
            if (!next || seen.has(next)) break
            seen.add(next)
            cursor = next
        }
        return lists
    }

    async listTasks(listId: string, cursor?: string) {
        const result = collections(task).parse(await this.call('list-todo-tasks', {
            todoTaskListId: id.parse(listId), top: pageSize, ...pagination(cursor),
        }))
        return {
            tasks: result.value.map(normalizeTask),
            nextCursor: nextPage(result['@odata.nextLink'], '/v1.0/me/todo/lists/' + listId + '/tasks'),
        }
    }

    async getTask(listId: string, taskId: string) {
        return normalizeTask(task.parse(await this.call('get-todo-task', {
            todoTaskListId: id.parse(listId), todoTaskId: id.parse(taskId), expand: ['checklistItems'],
        })))
    }

    async completeTask(listId: string, taskId: string) {
        await this.call('update-todo-task', {
            todoTaskListId: id.parse(listId), todoTaskId: id.parse(taskId), body: { status: 'completed' },
        })
    }
}
