export type TodoList = { id: string; displayName: string }

export type TodoPhase = 'queued' | 'assigned' | 'running' | 'waiting' | 'ready' | 'offline' | 'indeterminate' | 'failed' | 'completed' | 'released'

export type TodoAssignment = {
    id: string
    sessionId: string
    phase: TodoPhase
    updatedAt: number
    progress?: { completed: number; total: number; current: string | null } | null
    result?: string | null
    resultMessageId?: string | null
}

export type LinkedTodoAssignment = TodoAssignment & { listId: string; taskId: string }

export type TodoTask = {
    id: string
    title: string
    body: string | null
    status: string
    dueDateTime: { dateTime: string; timeZone: string } | null
    importance: string | null
    checklist: { id: string; displayName: string; isChecked: boolean }[]
    assignment: TodoAssignment | null
}

export type TodoTasksResponse = { tasks: TodoTask[]; nextCursor: string | null }

export type TodoDetailResponse = {
    task: TodoTask
    results?: { id: string; text: string; createdAt: number }[]
}

export type TodoDelivery = { requestId: string; notes?: string }
