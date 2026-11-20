import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { MachinesResponse } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachineManagement, type ManagedMachine } from '@/hooks/queries/useMachineManagement'
import { forgetMachineLabel, getMachineTitle } from '@/hooks/useMachineLabels'
import { forgetSessionListMachineFilter } from '@/hooks/useSessionListMachineFilter'
import { queryKeys } from '@/lib/query-keys'
import { MachineAgentTools } from '@/components/settings/MachineAgentTools'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

function MachineRow(props: { api: ApiClient | null; machine: ManagedMachine }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const savingRef = useRef(false)

    const label = getMachineTitle(props.machine)
    const host = props.machine.metadata?.host
    const platform = props.machine.metadata?.platform
    const subtitle = [host, platform].filter(Boolean).join(' · ')

    const renameMutation = useMutation({
        mutationFn: async (displayName: string) => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.renameMachine(props.machine.id, displayName)
        },
        onSuccess: () => {
            setEditing(false)
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
        },
        onError: () => setError(t('settings.machines.error')),
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!props.api) {
                throw new Error(t('settings.machines.deleteError'))
            }
            return await props.api.deleteMachine(props.machine.id)
        },
        onSuccess: async () => {
            // Drop live query entries before forgetting the label so mounted
            // sidebar hooks cannot write the deleted machine's name back.
            queryClient.setQueriesData<MachinesResponse>({ queryKey: queryKeys.machines }, (previous) => previous ? {
                ...previous,
                machines: previous.machines.filter((machine) => machine.id !== props.machine.id),
            } : previous)
            forgetMachineLabel(props.machine.id)
            forgetSessionListMachineFilter(props.machine.id)
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.machines }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ])
        },
    })

    function startEditing() {
        setDraft(props.machine.metadata?.displayName ?? '')
        setError(null)
        setEditing(true)
    }

    function save() {
        // Disabling the focused input on submit forces a blur, so `save` is
        // reached twice for a single Enter. A ref (not `isPending`, which is a
        // render-timing-dependent closure value) keeps that to one request.
        if (savingRef.current) {
            return
        }
        const next = draft.trim()
        if (next === (props.machine.metadata?.displayName ?? '')) {
            setEditing(false)
            return
        }
        savingRef.current = true
        renameMutation.mutate(next, {
            onSettled: () => {
                savingRef.current = false
            },
        })
    }

    return (
        <div className="px-3 py-3">
            <div className="flex min-h-9 items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                    {editing ? (
                        <input
                            autoFocus
                            value={draft}
                            maxLength={MACHINE_DISPLAY_NAME_MAX_LENGTH}
                            disabled={renameMutation.isPending}
                            placeholder={host ?? t('settings.machines.namePlaceholder')}
                            aria-label={t('settings.machines.rename', { name: label })}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={save}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault()
                                    save()
                                } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setEditing(false)
                                    setError(null)
                                }
                            }}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-60"
                        />
                    ) : props.machine.sessionOnly ? (
                        <div className="truncate text-sm font-medium text-[var(--app-fg)]">{label}</div>
                    ) : (
                        <button
                            type="button"
                            onClick={startEditing}
                            disabled={deleteMutation.isPending}
                            aria-label={t('settings.machines.rename', { name: label })}
                            className="block w-full truncate text-left text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-link)]"
                        >
                            {label}
                        </button>
                    )}
                    {subtitle ? (
                        <div className="mt-0.5 truncate text-xs leading-snug text-[var(--app-hint)]">{subtitle}</div>
                    ) : null}
                    <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                        {t(props.machine.sessionOnly
                            ? 'settings.machines.sessionOnly'
                            : props.machine.active ? 'settings.machines.online' : 'settings.machines.offline')}
                        {typeof props.machine.sessionCount === 'number'
                            ? ` · ${t('settings.machines.sessionCount', { count: props.machine.sessionCount })}`
                            : ''}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={editing || renameMutation.isPending || deleteMutation.isPending}
                    aria-label={t('settings.machines.deleteName', { name: label })}
                    className="shrink-0 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                    {t('settings.machines.delete')}
                </button>
            </div>
            {!props.machine.sessionOnly ? <MachineAgentTools api={props.api} machine={props.machine} /> : null}
            {error ? <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => {
                    if (!deleteMutation.isPending) setConfirmDelete(false)
                }}
                title={t('settings.machines.deleteTitle', { name: label })}
                description={[
                    t('settings.machines.deleteDescription'),
                    t('settings.machines.deleteNativeHistory'),
                    t('settings.machines.deleteReconnect'),
                ].join('\n\n')}
                confirmLabel={t('settings.machines.deleteConfirm')}
                confirmingLabel={t('settings.machines.deleting')}
                onConfirm={async () => { await deleteMutation.mutateAsync() }}
                isPending={deleteMutation.isPending}
                destructive
            />
        </div>
    )
}

export default function SettingsMachinesPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { machines, isLoading, error } = useMachineManagement(api)

    return (
        <SettingsPageContent description={t('settings.machines.description')}>
            <SettingsSection title={t('settings.machines.section')}>
                {isLoading ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.machines.loading')}</div>
                ) : error ? (
                    <div role="alert" className="px-3 py-3 text-sm text-red-600 dark:text-red-400">{t('settings.machines.loadError')}</div>
                ) : machines.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.machines.empty')}</div>
                ) : (
                    machines.map((machine) => (
                        <MachineRow key={machine.id} api={api} machine={machine} />
                    ))
                )}
            </SettingsSection>
            <a href="/hapi-local-source.tar.gz" target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--app-link)] hover:underline">
                {t('settings.machines.source')}
            </a>
        </SettingsPageContent>
    )
}
