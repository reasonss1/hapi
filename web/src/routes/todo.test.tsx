import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import type { TodoDetailResponse, TodoTask } from '@/types/todo'
import TodoPage from './todo'
import TodoDetail from './todo-detail'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    getTodoStatus: vi.fn(),
    getTodoLists: vi.fn(),
    getTodoTasks: vi.fn(),
    getTodoAssignments: vi.fn(),
    assignTodoTask: vi.fn(),
    completeTodoTask: vi.fn(),
    releaseTodoAssignment: vi.fn(),
    retryTodoAssignment: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...await importOriginal<typeof import('@tanstack/react-router')>(),
    useNavigate: () => mocks.navigate,
    Link: ({ children }: { children: React.ReactNode }) => <a href="#session">{children}</a>,
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: mocks, baseUrl: 'https://example.test' }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
vi.mock('@/hooks/queries/useMachines', () => ({ useMachines: () => ({ machines: [] }) }))
vi.mock('@/hooks/useMachineLabels', () => ({ useMachineLabels: () => ({}) }))

const task: TodoTask = {
    id: 'task', title: 'Review the login flow', body: 'Check the retry case', checklist: [],
    dueDateTime: null, importance: null, status: 'notStarted', assignment: null,
}

function mount(view: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={client}><I18nProvider>{view}</I18nProvider></QueryClientProvider>)
}

function renderDetail(data: TodoDetailResponse) {
    return mount(<TodoDetail api={mocks as unknown as ApiClient} listId="list" data={data} search={{ assign: true }}
        candidates={[{ id: 'busy', label: 'Busy Codex', disabled: 'busy' }, { id: 'idle', label: 'Idle Codex' }]}
        refresh={vi.fn().mockResolvedValue(undefined)} />)
}

describe('Todo Web page', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        localStorage.setItem('hapi-lang', 'en')
        localStorage.removeItem('hapi:todo:lastSession')
    })
    afterEach(cleanup)

    it('opens a task in assignment mode from its row', async () => {
        mocks.getTodoStatus.mockResolvedValue({ available: true })
        mocks.getTodoLists.mockResolvedValue({ lists: [{ id: 'list', displayName: 'Work' }] })
        mocks.getTodoTasks.mockResolvedValue({ tasks: [task], nextCursor: null })
        mocks.getTodoAssignments.mockResolvedValue({ assignments: [] })
        mount(<TodoPage search={{}} />)

        fireEvent.click(await screen.findByRole('button', { name: 'Assign: Review the login flow' }))
        expect(mocks.navigate).toHaveBeenCalledWith({ to: '/todos', search: { list: 'list', task: 'task', filter: 'open', assign: true } })
    })

    it('retries a failed delivery with the same request identifier and chosen idle session', async () => {
        mocks.assignTodoTask
            .mockRejectedValueOnce(new Error('network'))
            .mockResolvedValueOnce({ assignment: {} })
        renderDetail({ task })

        expect(screen.getByRole('option', { name: /Busy Codex/ })).toBeDisabled()
        expect(screen.getByRole('combobox', { name: 'Agent session' })).toHaveValue('idle')
        fireEvent.change(screen.getByRole('textbox', { name: 'Additional instructions' }), { target: { value: 'Check Linux' } })
        fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
        await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(mocks.assignTodoTask).toHaveBeenCalledTimes(2))
        const firstCall = mocks.assignTodoTask.mock.calls[0]
        expect(firstCall).toEqual(['list', 'task', { requestId: expect.any(String), notes: 'Check Linux', sessionId: 'idle' }])
        expect(mocks.assignTodoTask.mock.calls[1]).toEqual(firstCall)
        await waitFor(() => expect(localStorage.getItem('hapi:todo:lastSession')).toBe('idle'))
    })

    it('keeps confirmation unavailable while the assigned reply has not been selected', () => {
        renderDetail({
            task: { ...task, assignment: { id: 'assignment', sessionId: 'idle', phase: 'indeterminate', updatedAt: 1 } },
            results: [{ id: 'reply', text: 'The retry passed', createdAt: 2 }],
        })

        expect(screen.getByRole('button', { name: 'Use as result' })).toBeEnabled()
        expect(screen.queryByRole('button', { name: 'Confirm completion' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Release assignment' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull()
        expect(mocks.completeTodoTask).not.toHaveBeenCalled()
    })

    it('retries the original failed delivery and asks for confirmation before releasing it', async () => {
        mocks.retryTodoAssignment.mockResolvedValue({ assignment: {} })
        mocks.releaseTodoAssignment.mockRejectedValueOnce(new Error('network'))
        renderDetail({ task: { ...task, assignment: { id: 'assignment', sessionId: 'idle', phase: 'failed', updatedAt: 1 } } })

        fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' }))
        await waitFor(() => expect(mocks.retryTodoAssignment).toHaveBeenCalledWith('list', 'task'))
        const release = screen.getByRole('button', { name: 'Release assignment' })
        await waitFor(() => expect(release).toBeEnabled())
        fireEvent.click(release)
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/work already started.*may continue/i)).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Release assignment' }))
        expect(await within(dialog).findByText('Could not release the assignment. Try again.')).toBeInTheDocument()
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
    })

    it('permits a new assignment after release', () => {
        renderDetail({ task: { ...task, assignment: { id: 'assignment', sessionId: 'idle', phase: 'released', updatedAt: 1 } } })
        expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled()
        expect(screen.getByText('Assignment released')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull()
    })
})
