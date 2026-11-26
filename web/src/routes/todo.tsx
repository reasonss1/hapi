import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, CloseIcon, MarkAllReadIcon } from '@/components/icons'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { Button } from '@/components/ui/button'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import type { TodoTask } from '@/types/todo'
import TodoDetail from './todo-detail'

const filters = ['open', 'running', 'ready', 'completed'] as const
type TodoFilter = typeof filters[number]
export type TodoSearch = { list?: string; task?: string; filter?: TodoFilter; assign?: boolean; complete?: boolean }

export function parseTodoSearch(search: Record<string, unknown>): TodoSearch {
    const id = (value: unknown) => typeof value === 'string' && value ? value : undefined
    const filter = filters.find((value) => value === search.filter)
    return {
        list: id(search.list),
        task: id(search.task),
        filter,
        assign: search.assign === true || search.assign === 'true' ? true : undefined,
        complete: search.complete === true || search.complete === 'true' ? true : undefined,
    }
}

export function TodoIcon() {
    return <MarkAllReadIcon className="h-5 w-5" />
}

function matchesFilter(task: TodoTask, filter: TodoFilter): boolean {
    if (filter === 'completed') return task.status === 'completed'
    if (task.status === 'completed') return false
    if (filter === 'ready') return task.assignment?.phase === 'ready'
    if (filter === 'running') return ['queued', 'assigned', 'running', 'waiting'].includes(task.assignment?.phase ?? '')
    return true
}

export default function TodoPage({ search }: { search: TodoSearch }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const filter = search.filter ?? 'open'
    const status = useQuery({ queryKey: queryKeys.todoStatus, queryFn: ({ signal }) => api.getTodoStatus(signal), retry: false })
    const canRead = status.data?.available !== false
    const scope = api.getReadStateScope?.()
    const listPreferenceKey = scope ? `hapi:todo:lastList:${scope}` : null
    let preferredList: string | undefined
    try { if (listPreferenceKey) preferredList = localStorage.getItem(listPreferenceKey) ?? undefined } catch { /* Storage can be disabled. */ }
    const lists = useQuery({
        queryKey: queryKeys.todoLists, queryFn: ({ signal }) => api.getTodoLists(signal),
        enabled: canRead, staleTime: 30_000, retry: false,
    })
    const listId = search.list ?? (lists.data
        ? lists.data.lists.find((list) => list.id === preferredList)?.id ?? lists.data.lists[0]?.id
        : preferredList)
    const verifiedListId = lists.data?.lists.find((list) => list.id === listId)?.id
    useEffect(() => {
        try { if (verifiedListId && listPreferenceKey) localStorage.setItem(listPreferenceKey, verifiedListId) } catch { /* Storage can be disabled. */ }
    }, [listPreferenceKey, verifiedListId])
    const taskId = search.task
    const enabled = status.data?.available === true
    const { sessions } = useSessions(api, { enabled })
    const { machines } = useMachines(api, enabled)
    const machineLabels = useMachineLabels(machines)
    const assignments = useQuery({
        queryKey: queryKeys.todoAssignments, queryFn: ({ signal }) => api.getTodoAssignments(signal),
        enabled, refetchInterval: 10_000, retry: false,
    })
    const tasks = useInfiniteQuery({
        queryKey: queryKeys.todoTasks(listId ?? ''),
        queryFn: ({ pageParam, signal }) => api.getTodoTasks(listId!, pageParam ?? undefined, signal),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: Boolean(listId && canRead),
        refetchInterval: 30_000,
        retry: false,
    })
    const detail = useQuery({
        queryKey: queryKeys.todoTask(listId ?? '', taskId ?? ''),
        queryFn: ({ signal }) => api.getTodoTask(listId!, taskId!, signal),
        enabled: Boolean(canRead && listId && taskId),
        staleTime: 15_000,
        retry: false,
    })
    const byTask = useMemo(() => new Map(assignments.data?.assignments.filter((item) => item.listId === listId)
        .map((item) => [item.taskId, item])), [assignments.data, listId])
    const sessionLabels = new Map(sessions.map((session) => {
        const machineId = session.metadata?.machineId
        const machine = machineId ? machineLabels[machineId] : undefined
        return [session.id, [getSessionTitle(session), machine, session.metadata?.path].filter(Boolean).join(' · ')]
    }))
    const devices = machines.filter((machine) => machine.active).map((machine) => ({
        id: machine.id,
        label: machineLabels[machine.id] ?? machine.id,
    }))
    const withAssignment = (task: TodoTask): TodoTask => ({ ...task, assignment: byTask.get(task.id) ?? task.assignment })
    const pageTasks = tasks.data?.pages.flatMap((page) => page.tasks.map(withAssignment)) ?? []
    const visibleTasks = pageTasks.filter((task) => matchesFilter(task, filter))
    const selectedRow = pageTasks.find((task) => task.id === taskId)
    const selected = detail.data ? { ...detail.data, task: withAssignment(detail.data.task) } : selectedRow ? { task: selectedRow } : null
    const assignedSessionIds = new Set(assignments.data?.assignments.map((item) => item.sessionId))
    const sessionWatermark = sessions.filter((session) => assignedSessionIds.has(session.id))
        .map((session) => [session.id, session.active, session.thinking, session.agentStateVersion, session.todosUpdatedAt, session.contentRevision].join(':')).join('|')
    const selectedAssignment = taskId ? byTask.get(taskId) : undefined
    const selectedUpdatedAt = selectedAssignment?.updatedAt
    const selectedPhase = selectedAssignment?.phase
    useEffect(() => {
        if (!enabled || !sessionWatermark) return
        const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: queryKeys.todoAssignments }), 800)
        return () => clearTimeout(timer)
    }, [enabled, queryClient, sessionWatermark])
    useEffect(() => {
        if (!listId || !taskId || selectedUpdatedAt === undefined) return
        void queryClient.invalidateQueries({ queryKey: queryKeys.todoTask(listId, taskId) })
    }, [listId, queryClient, selectedPhase, selectedUpdatedAt, taskId])

    async function refresh() {
        if (!listId || !taskId) return
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.todoAssignments }),
            queryClient.invalidateQueries({ queryKey: queryKeys.todoTask(listId, taskId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.todoTasks(listId) }),
        ])
    }
    const changeSearch = (next: TodoSearch) => navigate({ to: '/todos', search: next })
    const error = status.error ?? (canRead ? lists.error ?? tasks.error : null)
    const selectedList = lists.data?.lists.find((list) => list.id === listId)

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3 py-2 sm:px-5">
                {search.task ? (
                    <button type="button" onClick={() => void changeSearch({ list: listId, filter })}
                        aria-label={t('todo.backToTasks')} className="flex h-9 w-9 items-center justify-center lg:hidden">
                        <ArrowLeftIcon />
                    </button>
                ) : null}
                <Link to="/sessions" aria-label={t('common.back')} className={`${search.task ? 'hidden lg:flex' : 'flex'} h-9 w-9 items-center justify-center`}>
                    <ArrowLeftIcon />
                </Link>
                <h1 className="text-lg font-semibold">{t('todo.title')}</h1>
            </header>
            <div className="flex min-h-0 w-full flex-1">
                <nav aria-label={t('todo.list')} className="app-scroll-y hidden w-52 shrink-0 border-r border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-4 lg:block xl:w-56">
                    {lists.data?.lists.map((list) => (
                        <button type="button" key={list.id} aria-current={list.id === listId ? 'page' : undefined}
                            onClick={() => void changeSearch({ list: list.id, filter })}
                            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--app-secondary-bg)] aria-current:bg-[var(--app-secondary-bg)] aria-current:font-medium">
                            <span className="text-[var(--app-link)]"><TodoIcon /></span>
                            <span className="min-w-0 truncate">{list.displayName}</span>
                        </button>
                    ))}
                </nav>
                <main className={`${search.task ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col`}>
                    <div className="shrink-0 border-b border-[var(--app-border)] px-3 py-4 sm:px-5 lg:px-7 lg:py-5">
                        {selectedList ? <h2 className="mb-3 hidden break-words text-2xl font-semibold lg:block">{selectedList.displayName}</h2> : null}
                        {lists.data?.lists.length ? (
                            <select aria-label={t('todo.list')} value={listId} className="mb-2 max-w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm lg:hidden"
                                onChange={(event) => void changeSearch({ list: event.target.value, filter })}>
                                {lists.data.lists.map((list) => <option key={list.id} value={list.id}>{list.displayName}</option>)}
                            </select>
                        ) : null}
                        <div role="group" aria-label={t('todo.filter')} className="flex flex-wrap gap-1">
                            {filters.map((value) => (
                                <button key={value} type="button" aria-pressed={filter === value}
                                    className="rounded-md px-2 py-1.5 text-sm hover:bg-[var(--app-subtle-bg)] aria-pressed:bg-[var(--app-secondary-bg)] aria-pressed:font-medium"
                                    onClick={() => void changeSearch({ list: listId, filter: value })}>
                                    {t(`todo.filter.${value}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="app-scroll-y min-h-0 flex-1">
                        {error ? (
                            <div className="flex items-center gap-3 p-4" role="alert">
                                <span>{t('todo.loadFailed')}</span>
                                <Button size="sm" variant="outline" onClick={() => void (status.error ? status.refetch() : lists.error ? lists.refetch() : tasks.refetch())}>
                                    {t('todo.retry')}
                                </Button>
                            </div>
                        ) : null}
                        {status.data?.available === false ? <p className="p-5 text-sm text-[var(--app-hint)]">{t('todo.unavailable')}</p> : null}
                        {status.isLoading || lists.isLoading || tasks.isLoading ? <p role="status" className="p-5 text-sm">{t('loading')}</p> : null}
                        {!error && status.data?.available && lists.isSuccess && !listId ? <p className="p-5 text-sm">{t('todo.noLists')}</p> : null}
                        {tasks.isSuccess && visibleTasks.length === 0 ? <p className="p-5 text-sm">{t('todo.empty')}</p> : null}
                        <ul className="divide-y divide-[var(--app-border)] px-2 sm:px-4 lg:px-6">
                            {visibleTasks.map((task) => (
                                <li key={task.id} className={`flex min-h-12 items-center gap-3 rounded-md px-2 py-1 hover:bg-[var(--app-subtle-bg)] ${search.task === task.id ? 'bg-[var(--app-secondary-bg)]' : ''}`}>
                                    <input type="checkbox" checked={task.status === 'completed'} disabled={task.status === 'completed'}
                                        className="h-[1.15rem] w-[1.15rem] shrink-0 cursor-pointer appearance-none rounded-full border border-[var(--app-hint)] checked:border-[var(--app-link)] checked:bg-[var(--app-link)] checked:after:block checked:after:text-center checked:after:text-xs checked:after:leading-4 checked:after:text-[var(--app-bg)] checked:after:content-['✓']"
                                        aria-label={t('todo.markComplete', { title: task.title })}
                                        onChange={() => void changeSearch({ list: listId, task: task.id, filter, complete: !task.assignment || task.assignment.phase === 'released' || undefined })} />
                                    <button type="button" onClick={() => void changeSearch({ list: listId, task: task.id, filter })}
                                        aria-current={search.task === task.id || undefined} className="min-w-0 flex-1 break-words py-1.5 text-left text-sm">
                                        <span className={task.status === 'completed' ? 'text-[var(--app-hint)] line-through' : 'font-medium'}>{task.title}</span>
                                        {task.dueDateTime ? <span className="block text-xs text-[var(--app-hint)]">{t('todo.due', { date: task.dueDateTime.dateTime.slice(0, 10) })}</span> : null}
                                    </button>
                                    {task.assignment ? (
                                        <button type="button" className="max-w-[44%] shrink-0 text-right text-xs text-[var(--app-hint)]"
                                            onClick={() => void changeSearch({ list: listId, task: task.id, filter })}>
                                            <span className="block">{t(`todo.phase.${task.assignment.phase}`)}</span>
                                            {task.assignment.progress?.total ? <span>{t('todo.progress', {
                                                completed: task.assignment.progress.completed,
                                                total: task.assignment.progress.total,
                                            })}</span> : null}
                                        </button>
                                    ) : null}
                                    {(!task.assignment || task.assignment.phase === 'released') && task.status !== 'completed' ? (
                                        <button type="button" aria-label={t('todo.assignTask', { title: task.title })} title={t('todo.assign')}
                                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                                            onClick={() => void changeSearch({ list: listId, task: task.id, filter, assign: true })}>
                                            <AgentFlavorIcon flavor="codex" className="h-4 w-4" />
                                        </button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                        {tasks.hasNextPage ? (
                            <Button className="m-4" variant="outline" size="sm" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
                                {t('todo.loadMore')}
                            </Button>
                        ) : null}
                    </div>
                </main>
                {search.task ? <aside className="app-scroll-y relative min-w-0 flex-1 bg-[var(--app-bg)] lg:w-80 lg:flex-none lg:border-l lg:border-[var(--app-border)] xl:w-96">
                    <button type="button" aria-label={t('todo.backToTasks')} title={t('todo.backToTasks')}
                        className="absolute right-2 top-3 hidden h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] lg:flex"
                        onClick={() => void changeSearch({ list: listId, filter })}><CloseIcon /></button>
                    {selected && listId && canRead ? (
                        <TodoDetail key={JSON.stringify([listId, taskId, search.assign, search.complete])}
                            api={api} listId={listId} data={selected} devices={devices} search={search} refresh={refresh} preview={!detail.data}
                            assignee={selected.task.assignment ? sessionLabels.get(selected.task.assignment.sessionId) : undefined} />
                    ) : null}
                    {detail.isError && canRead ? (
                        <div role="alert" className="space-y-2 px-5 pb-4 text-sm">
                            <p>{t('todo.loadFailed')}</p>
                            <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>{t('todo.retry')}</Button>
                        </div>
                    ) : !detail.data ? <p role="status" className="p-5 text-sm text-[var(--app-hint)]">{t(canRead ? 'loading' : 'todo.unavailable')}</p> : null}
                </aside> : null}
            </div>
        </div>
    )
}
