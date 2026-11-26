import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentToolId, AgentToolsResponse, AgentToolStatus } from '@hapi/protocol/agentTools'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

function isUpdating(tool: AgentToolStatus): boolean {
    return tool.state === 'installing' || tool.state === 'retrying'
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
    const supported = machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentToolUpdates) === true
    const enabled = Boolean(api && machine.active && supported && isOnline)
    const queryKey = queryKeys.machineAgentTools(machine.id)
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            const cached = queryClient.getQueryData<AgentToolsResponse>(queryKey)
            // Status polling must not repeat registry lookups during installation.
            const refresh = !cached || !cached.tools.some(isUpdating)
            return await api.getMachineAgentTools(machine.id, refresh)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
        refetchInterval: (current) => current.state.data?.tools.some(isUpdating) ? 2_000 : false,
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
        mutationFn: async (tools: AgentToolId[]) => {
            if (!api) throw new Error('API unavailable')
            await queryClient.cancelQueries({ queryKey })
            let failed = false
            for (const tool of tools) {
                try {
                    const data = await api.updateMachineAgentTool(machine.id, tool)
                    queryClient.setQueryData(queryKey, data)
                } catch {
                    // A failed request for one tool must not prevent the others.
                    failed = true
                }
            }
            if (failed) throw new Error('Update request failed')
        },
        onSuccess: () => setError(null),
        onError: () => {
            setError(t('settings.machines.tools.requestFailed'))
            // A response can be lost after the runner accepted an update.
            // Recover its actual state instead of inviting an immediate retry.
            void queryClient.invalidateQueries({ queryKey })
        },
        onSettled: () => { operationRef.current = false },
    })

    const tools = query.data?.tools ?? []
    useEffect(() => {
        for (const tool of tools) {
            const versionKey = `${machine.id}:${tool.id}:${tool.installedVersion}`
            if (tool.state !== 'updated' || refreshedVersions.current.has(versionKey)) continue
            refreshedVersions.current.add(versionKey)
            // New sessions must fetch the catalog from the newly selected CLI.
            // Existing sessions keep their own version and session-scoped catalog.
            void queryClient.invalidateQueries({ queryKey: queryKeys.machineAgentAvailability(machine.id) })
            const modelKeys: Partial<Record<AgentToolId, readonly (readonly string[])[]>> = {
                codex: [queryKeys.machineCodexModels(machine.id)],
                claude: [queryKeys.machineClaudeModels(machine.id)],
                pi: [queryKeys.machinePiModels(machine.id)],
                opencode: [['machine-opencode-models', machine.id], queryKeys.machineOpencodeModelVariants(machine.id)],
                copilot: [['machine-copilot-models', machine.id]],
                grok: [['machine-grok-models', machine.id]],
            }
            for (const key of modelKeys[tool.id] ?? []) void queryClient.invalidateQueries({ queryKey: key })
        }
    }, [tools, machine.id, queryClient])
    const updatable = tools.filter((tool) => tool.canUpdate && !isUpdating(tool))
    const updating = tools.some(isUpdating)
    const operating = refreshMutation.isPending || updateMutation.isPending
    const disabled = !enabled || operating || query.isFetching

    function checkUpdates() {
        if (operationRef.current || disabled) return
        operationRef.current = true
        setError(null)
        refreshMutation.mutate()
    }

    function updateTools(ids: AgentToolId[]) {
        if (operationRef.current || disabled || ids.length === 0) return
        operationRef.current = true
        setError(null)
        updateMutation.mutate(ids)
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-[var(--app-fg)]">{t('settings.machines.tools.title')}</span>
                        <div className="flex gap-3">
                            <button type="button" onClick={checkUpdates} disabled={disabled || updating}
                                className="text-[var(--app-link)] disabled:opacity-50">
                                {query.isFetching || refreshMutation.isPending
                                    ? t('settings.machines.tools.checking')
                                    : t('settings.machines.tools.check')}
                            </button>
                            {updatable.length > 1 ? (
                                <button type="button" onClick={() => updateTools(updatable.map((tool) => tool.id))}
                                    disabled={disabled || updating} className="font-medium text-[var(--app-link)] disabled:opacity-50">
                                    {t('settings.machines.tools.updateAll')}
                                </button>
                            ) : null}
                        </div>
                    </div>
                    <p className="text-[var(--app-hint)]">{t('settings.machines.tools.continuity')}</p>
                    {!machine.active || !isOnline ? (
                        <p role="status" className="text-[var(--app-hint)]">{t('settings.machines.tools.offline')}</p>
                    ) : null}
                    {tools.filter(isVisibleTool).map((tool) => {
                        const message = toolMessage(tool)
                        return (
                            <div key={tool.id} className="flex items-start justify-between gap-3 rounded-lg bg-[var(--app-bg)] px-2 py-2">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                        <span className="font-medium text-[var(--app-fg)]">{tool.name}</span>
                                        <span className="text-[var(--app-hint)]">{tool.installedVersion ?? '—'}</span>
                                        {tool.latestVersion && tool.latestVersion !== tool.installedVersion ? (
                                            <span className="text-[var(--app-link)]">{t('settings.machines.tools.available', { version: tool.latestVersion })}</span>
                                        ) : null}
                                    </div>
                                    {message ? (
                                        <p role="status" className={`mt-1 ${tool.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-[var(--app-hint)]'}`}>
                                            {message}
                                        </p>
                                    ) : null}
                                </div>
                                {tool.canUpdate && !isUpdating(tool) ? (
                                    <button type="button" onClick={() => updateTools([tool.id])} disabled={disabled}
                                        aria-label={t('settings.machines.tools.updateNamed', { name: tool.name })}
                                        className="shrink-0 rounded-md border border-[var(--app-border)] px-2 py-1 text-[var(--app-link)] disabled:opacity-50">
                                        {t('settings.machines.tools.update')}
                                    </button>
                                ) : null}
                            </div>
                        )
                    })}
                    {query.data && !tools.some(isVisibleTool) ? (
                        <p className="text-[var(--app-hint)]">{t('settings.machines.tools.empty')}</p>
                    ) : null}
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
