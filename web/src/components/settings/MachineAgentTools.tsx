import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentToolsResponse, AgentToolStatus } from '@hapi/protocol/agentTools'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

function getCodexStatus(response: AgentToolsResponse | undefined): AgentToolStatus | undefined {
    return response?.tools.find((tool) => tool.id === 'codex')
}

function isUpdating(tool: AgentToolStatus | undefined): boolean {
    return tool?.state === 'installing' || tool?.state === 'retrying'
}

function isVisibleTool(tool: AgentToolStatus): boolean {
    return tool.installedVersion !== null || isUpdating(tool) || tool.reason === 'manual_version' || tool.reason === 'check_failed'
}

const REASON_KEYS: Record<string, string> = {
    custom_path: 'settings.machines.tools.customPath',
    unsupported_platform: 'settings.machines.tools.manualUpdate',
    npm_unavailable: 'settings.machines.tools.manualUpdate',
    unsupported_tool: 'settings.machines.tools.manualUpdate',
    check_failed: 'settings.machines.tools.checkFailed',
    insufficient_space: 'settings.machines.tools.insufficientSpace',
    disk_space: 'settings.machines.tools.insufficientSpace',
    manual_version: 'settings.machines.tools.manualVersion',
}

export function MachineAgentTools({ api, machine }: { api: ApiClient | null; machine: Machine }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const isOnline = useOnlineStatus()
    const operationRef = useRef(false)
    const refreshedVersions = useRef(new Set<string>())
    const [error, setError] = useState<string | null>(null)
    const supported = machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.CodexAgentToolUpdates) === true
    const enabled = Boolean(api && machine.active && supported && isOnline)
    const queryKey = queryKeys.machineAgentTools(machine.id)
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            const cached = queryClient.getQueryData<AgentToolsResponse>(queryKey)
            // Status polling must not repeat registry lookups during installation.
            const refresh = !isUpdating(getCodexStatus(cached))
            return await api.getMachineAgentTools(machine.id, refresh)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
        refetchInterval: (current) => isUpdating(getCodexStatus(current.state.data)) ? 2_000 : false,
    })
    const refreshMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            await queryClient.cancelQueries({ queryKey })
            return await api.getMachineAgentTools(machine.id, true)
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKey, data)
            setError(null)
        },
        onError: () => setError(t('settings.machines.tools.checkFailed')),
        onSettled: () => { operationRef.current = false },
    })
    const updateMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            await queryClient.cancelQueries({ queryKey })
            return await api.updateMachineAgentTool(machine.id, 'codex')
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKey, data)
            setError(null)
        },
        onError: () => {
            setError(t('settings.machines.tools.requestFailed'))
            // A response can be lost after the runner accepted an update.
            // Recover its actual state instead of inviting an immediate retry.
            void queryClient.invalidateQueries({ queryKey })
        },
        onSettled: () => { operationRef.current = false },
    })

    const codex = getCodexStatus(query.data)
    useEffect(() => {
        if (!supported || codex?.state !== 'updated') return
        const versionKey = `${machine.id}:${codex.installedVersion}`
        if (refreshedVersions.current.has(versionKey)) return
        refreshedVersions.current.add(versionKey)
        // New sessions fetch the updated machine catalog. Current sessions keep their scoped catalog.
        void queryClient.invalidateQueries({ queryKey: queryKeys.machineAgentAvailability(machine.id) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.machineCodexModels(machine.id) })
    }, [codex, machine.id, queryClient, supported])
    const updating = isUpdating(codex)
    const visibleCodex = codex && isVisibleTool(codex) ? codex : null
    const operating = refreshMutation.isPending || updateMutation.isPending
    const disabled = !enabled || operating || query.isFetching

    function checkUpdates() {
        if (operationRef.current || disabled) return
        operationRef.current = true
        setError(null)
        refreshMutation.mutate()
    }

    function updateCodex() {
        if (operationRef.current || disabled || !codex?.canUpdate || updating) return
        operationRef.current = true
        setError(null)
        updateMutation.mutate()
    }

    function toolMessage(tool: AgentToolStatus): string | null {
        if (tool.reason === 'disk_space' || tool.reason === 'insufficient_space') return t('settings.machines.tools.insufficientSpace')
        if (tool.state === 'installing') return t('settings.machines.tools.updating')
        if (tool.state === 'retrying') return t('settings.machines.tools.retrying')
        if (tool.state === 'updated') return t('settings.machines.tools.updated')
        if (tool.state === 'failed') return t(tool.reason === 'insufficient_space' || tool.reason === 'disk_space'
            ? 'settings.machines.tools.insufficientSpace'
            : 'settings.machines.tools.failed')
        if (tool.reason && REASON_KEYS[tool.reason]) return t(REASON_KEYS[tool.reason])
        if (tool.latestVersion && tool.latestVersion === tool.installedVersion) return t('settings.machines.tools.current')
        return null
    }

    const offline = !machine.active || !isOnline
    const message = offline
        ? t('settings.machines.tools.offline')
        : visibleCodex ? toolMessage(visibleCodex) : query.data ? t('settings.machines.tools.empty') : null

    return (
        <div className="mt-2 space-y-2 text-xs">
            <div className="text-[var(--app-hint)]">
                {t('settings.machines.tools.runnerVersion', { version: machine.metadata?.happyCliVersion ?? '—' })}
            </div>
            {!supported ? (
                <p className="text-[var(--app-hint)]">
                    {t('settings.machines.tools.runnerRequired', { addDevice: t('settings.machines.enrollment.add') })}
                </p>
            ) : (
                <>
                    <div role="group" aria-label={t('settings.machines.tools.title')} className="flex min-w-0 items-center gap-1.5 rounded-lg bg-[var(--app-bg)] px-2 py-1.5 sm:gap-2">
                        <span className="shrink-0 font-medium text-[var(--app-fg)]">{visibleCodex?.name ?? 'Codex'}</span>
                        {visibleCodex ? (
                            <span className="shrink-0 whitespace-nowrap text-[var(--app-hint)]">{visibleCodex.installedVersion ?? '—'}</span>
                        ) : null}
                        {visibleCodex?.latestVersion && visibleCodex.latestVersion !== visibleCodex.installedVersion ? (
                            <span className="truncate text-[var(--app-link)]" title={t('settings.machines.tools.available', { version: visibleCodex.latestVersion })}>
                                → {visibleCodex.latestVersion}
                            </span>
                        ) : null}
                        {message ? (
                            <span role="status" title={message} className={`truncate ${!offline && visibleCodex?.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-[var(--app-hint)]'}`}>
                                {message}
                            </span>
                        ) : null}
                        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap sm:gap-2">
                            <button type="button" onClick={checkUpdates} disabled={disabled || updating}
                                className="text-[var(--app-link)] disabled:opacity-50">
                                {query.isFetching || refreshMutation.isPending
                                    ? t('settings.machines.tools.checking')
                                    : t('settings.machines.tools.check')}
                            </button>
                            {visibleCodex?.canUpdate && !updating ? (
                                <button type="button" onClick={updateCodex} disabled={disabled}
                                    aria-label={t('settings.machines.tools.updateNamed', { name: visibleCodex.name })}
                                    title={t('settings.machines.tools.continuity')}
                                    className="rounded-md border border-[var(--app-border)] px-2 py-1 text-[var(--app-link)] disabled:opacity-50">
                                    {t('settings.machines.tools.update')}
                                </button>
                            ) : null}
                        </div>
                    </div>
                    {error || query.isError ? (
                        <p role="alert" className="text-red-600 dark:text-red-400">
                            {error ?? t('settings.machines.tools.checkFailed')}
                        </p>
                    ) : null}
                </>
            )}
        </div>
    )
}
