import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ApiError, type ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { randomId } from '@/lib/randomId'
import { useTranslation } from '@/lib/use-translation'
import type { TodoAssignDelivery, TodoDelivery, TodoDetailResponse } from '@/types/todo'
import type { TodoSearch } from './todo'

export type TodoDevice = { id: string; label: string }

type TodoAction =
    | { type: 'assign'; delivery: TodoAssignDelivery }
    | { type: 'continue'; delivery: TodoDelivery }
    | { type: 'result'; messageId: string }
    | { type: 'retry' }

type TodoConfirmation = 'complete' | 'release'

function readPreference(key: string | null): string {
    if (!key) return ''
    try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

export default function TodoDetail(props: {
    api: ApiClient
    listId: string
    data: TodoDetailResponse
    devices: TodoDevice[]
    preview?: boolean
    search: TodoSearch
    assignee?: string
    refresh: () => Promise<void>
}) {
    const { t, locale } = useTranslation()
    const { api, listId, data, search, devices, preview, refresh } = props
    const scope = api.getReadStateScope?.()
    const preferenceKey = scope ? `hapi:todo:lastDevice:${scope}` : null
    const { task, results } = data
    const assignment = task.assignment
    const [assigning, setAssigning] = useState(Boolean(search.assign))
    const [continuing, setContinuing] = useState(false)
    const [confirmation, setConfirmation] = useState<TodoConfirmation | null>(search.complete ? 'complete' : null)
    const [machineId, setMachineId] = useState<string | null>(null)
    const [path, setPath] = useState('')
    const [notes, setNotes] = useState('')
    const attempt = useRef<{ fingerprint: string; id: string } | null>(null)
    const inFlight = useRef(false)
    const completed = task.status === 'completed'
    const canAssign = !assignment || assignment.phase === 'released'
    const canComplete = !completed && (canAssign || Boolean(assignment?.resultMessageId))
    const canContinue = !completed && (assignment?.phase === 'assigned' || assignment?.phase === 'ready')
    const canRelease = assignment && assignment.phase !== 'released' && assignment.phase !== 'completed'
        && (completed || assignment.phase === 'failed' || assignment.phase === 'offline')
    const preferredDevice = readPreference(preferenceKey)
    const device = machineId === null
        ? devices.find((item) => item.id === preferredDevice) ?? devices[0]
        : devices.find((item) => item.id === machineId)
    const assignTarget = device ? { machineId: device.id, path: path.trim() || undefined } : null

    const action = useMutation({
        mutationFn: async (operation: TodoAction) => {
            if (operation.type === 'result') return await api.selectTodoResult(listId, task.id, operation.messageId)
            if (operation.type === 'retry') return await api.retryTodoAssignment(listId, task.id)
            return operation.type === 'continue'
                ? await api.continueTodoTask(listId, task.id, operation.delivery)
                : await api.assignTodoTask(listId, task.id, operation.delivery)
        },
        onSuccess: (_, operation) => {
            if (operation.type === 'assign') {
                try { if (preferenceKey) localStorage.setItem(preferenceKey, operation.delivery.machineId) } catch { /* Storage can be disabled. */ }
            }
            if (operation.type === 'assign' || operation.type === 'continue') {
                setAssigning(false)
                setContinuing(false)
                setNotes('')
                attempt.current = null
            }
            return refresh()
        },
        onSettled: () => { inFlight.current = false },
    })
    const confirm = useMutation({
        mutationFn: async (operation: TodoConfirmation) => operation === 'release'
            ? await api.releaseTodoAssignment(listId, task.id)
            : await api.completeTodoTask(listId, task.id),
        onSuccess: refresh,
    })

    function run(operation: TodoAction) {
        if (inFlight.current) return
        inFlight.current = true
        action.mutate(operation)
    }

    function send(type: 'assign' | 'continue') {
        if (preview) return
        const text = notes.trim()
        if ((type === 'assign' && !assignTarget) || (type === 'continue' && !text)) return
        const target = type === 'assign' ? assignTarget : assignment?.sessionId
        const fingerprint = JSON.stringify([type, target, text])
        if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: randomId() }
        const delivery = { requestId: attempt.current.id, notes: text || undefined }
        if (type === 'assign' && assignTarget) run({ type, delivery: { ...delivery, ...assignTarget } })
        if (type === 'continue') run({ type, delivery })
    }

    const busy = action.isPending || confirm.isPending
    const releasing = confirmation === 'release'
    const headingClass = 'mb-1 text-sm font-semibold'
    const fieldClass = 'block w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm'
    const notesField = (
        <label className="block space-y-1 text-sm">
            <span>{t('todo.notes')}</span>
            <textarea className={fieldClass} value={notes} maxLength={4000} rows={3} onChange={(event) => setNotes(event.target.value)} />
        </label>
    )

    return (
        <article className="space-y-5 p-4 sm:p-5">
            <div className="lg:pr-7">
                <h2 className="break-words text-xl font-semibold">{task.title}</h2>
                {task.dueDateTime ? <p className="mt-1 text-sm text-[var(--app-hint)]">{t('todo.due', { date: task.dueDateTime.dateTime.slice(0, 10) })}</p> : null}
                {task.body ? <p className="mt-3 whitespace-pre-wrap break-words text-sm">{task.body}</p> : null}
            </div>
            {task.checklist.length > 0 ? (
                <section>
                    <h3 className={headingClass}>{t('todo.checklist')}</h3>
                    <ul className="space-y-1 text-sm">
                        {task.checklist.map((item) => (
                            <li key={item.id} className="flex items-start gap-2">
                                <input type="checkbox" checked={item.isChecked} disabled aria-label={item.displayName} />
                                <span className="min-w-0 break-words">{item.displayName}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {assignment ? (
                <section className="space-y-2 border-t border-[var(--app-border)] pt-3">
                    <h3 className={headingClass}>{t('todo.execution')}</h3>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span>{t(`todo.phase.${assignment.phase}`)}</span>
                        {props.assignee ? <span className="text-[var(--app-hint)]">{props.assignee}</span> : null}
                    </div>
                    {assignment.progress?.total ? (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <progress className="w-24" max={assignment.progress.total} value={assignment.progress.completed} />
                            <span>{t('todo.progress', { completed: assignment.progress.completed, total: assignment.progress.total })}</span>
                            {assignment.progress.current ? <span>{assignment.progress.current}</span> : null}
                        </div>
                    ) : null}
                    <p className="text-xs text-[var(--app-hint)]">{t('todo.updated', { time: new Date(assignment.updatedAt).toLocaleString(locale) })}</p>
                    <Link to="/sessions/$sessionId" params={{ sessionId: assignment.sessionId }} className="inline-block text-sm text-[var(--app-link)] hover:underline">
                        {t('todo.openSession')}
                    </Link>
                </section>
            ) : null}
            {assignment?.result ? (
                <section>
                    <h3 className={headingClass}>{t('todo.result')}</h3>
                    <p className="whitespace-pre-wrap break-words text-sm">{assignment.result}</p>
                </section>
            ) : null}
            {assignment && results?.length && !completed && !canAssign ? (
                <section>
                    <h3 className={headingClass}>{t('todo.replies')}</h3>
                    <ul className="divide-y divide-[var(--app-border)]">
                        {results.map((result) => (
                            <li key={result.id} className="space-y-1 py-2 text-sm">
                                <Link to="/sessions/$sessionId" params={{ sessionId: assignment.sessionId }} search={{ messageId: result.id }}
                                    className="block line-clamp-4 whitespace-pre-wrap break-words text-[var(--app-link)] hover:underline">{result.text}</Link>
                                <Button size="sm" variant="outline" disabled={busy || assignment?.resultMessageId === result.id}
                                    onClick={() => run({ type: 'result', messageId: result.id })}>{t('todo.useResult')}</Button>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {!preview && !completed && canAssign && assigning ? (
                <form className="space-y-3 rounded-xl border border-[var(--app-border)] p-3.5" onSubmit={(event) => { event.preventDefault(); send('assign') }}>
                    <h3 className={headingClass}>{t('todo.assign')}</h3>
                    <>
                            <label className="block space-y-1 text-sm">
                                <span>{t('todo.device')}</span>
                                <select className={fieldClass} value={device?.id ?? ''} onChange={(event) => { setMachineId(event.target.value); setPath('') }}>
                                    <option value="" disabled>{t(devices.length ? 'todo.selectDevice' : 'todo.noDevices')}</option>
                                    {devices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                </select>
                            </label>
                            {device ? (
                                <label className="block space-y-1 text-sm">
                                    <span>{t('todo.directory')}</span>
                                    <input className={fieldClass} value={path} placeholder={t('todo.defaultDirectory')} onChange={(event) => setPath(event.target.value)} />
                                </label>
                            ) : null}
                            <p className="text-xs text-[var(--app-hint)]">{t('todo.newDeviceSession')}</p>
                    </>
                    {notesField}
                    <Button type="submit" disabled={busy || !assignTarget}>
                        {t(busy ? 'todo.assigning' : 'todo.start')}
                    </Button>
                </form>
            ) : null}
            {!preview && canContinue && continuing ? (
                <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); send('continue') }}>
                    {notesField}
                    <Button type="submit" disabled={busy || !notes.trim()}>{t('todo.sendInstructions')}</Button>
                </form>
            ) : null}
            {!preview ? <div className="flex flex-wrap gap-2 empty:hidden">
                {!completed && canAssign && !assigning ? <Button variant="outline" onClick={() => setAssigning(true)}>{t('todo.assign')}</Button> : null}
                {canContinue && !continuing ? (
                    <Button variant="outline" onClick={() => { setNotes(''); setContinuing(true) }} disabled={busy}>{t('todo.continue')}</Button>
                ) : null}
                {!completed && assignment?.phase === 'failed' ? (
                    <Button variant="outline" onClick={() => run({ type: 'retry' })} disabled={busy}>{t('todo.retryDelivery')}</Button>
                ) : null}
                {canRelease ? <Button variant="outline" onClick={() => setConfirmation('release')} disabled={busy}>{t('todo.release')}</Button> : null}
                {canComplete ? <Button onClick={() => setConfirmation('complete')} disabled={busy}>{t('todo.confirm')}</Button> : null}
            </div> : null}
            {action.isError ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-600">
                    <span>{t(action.error instanceof ApiError && action.error.code === 'todo_workspace_unavailable'
                        ? 'todo.workspaceUnavailable' : 'todo.actionFailed')}</span>
                    {action.variables ? <Button size="sm" variant="outline" onClick={() => run(action.variables!)}>{t('todo.retry')}</Button> : null}
                </div>
            ) : null}
            <ConfirmDialog isOpen={!preview && Boolean(releasing ? canRelease : confirmation === 'complete' && canComplete)}
                onClose={() => setConfirmation(null)} title={t(releasing ? 'todo.release' : 'todo.confirm')}
                description={t(releasing ? 'todo.releaseDescription' : 'todo.confirmDescription', { title: task.title })}
                confirmLabel={t(releasing ? 'todo.release' : 'todo.confirm')} confirmingLabel={t('todo.confirming')}
                isPending={confirm.isPending} onConfirm={async () => {
                    try {
                        if (confirmation) await confirm.mutateAsync(confirmation)
                    } catch {
                        throw new Error(t(releasing ? 'todo.releaseFailed' : 'todo.completeFailed'))
                    }
                }} />
        </article>
    )
}
