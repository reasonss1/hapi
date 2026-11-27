import type { Machine } from '@/types/api'
import { MACHINE_HEALTH_BAR_FILL_CLASS, presentMachineHealth } from '@/lib/machineHealth'
import { useTranslation } from '@/lib/use-translation'

export function MachineDetails({ machine }: { machine: Machine }) {
    const { t, locale } = useTranslation()
    const health = machine.health
    const presentation = presentMachineHealth(health, machine.metadata?.platform)
    const roots = [...new Set(machine.metadata?.workspaceRoots?.filter(root => root.trim().length > 0) ?? [])]
    const reportedAt = health ? new Date(health.collectedAt) : null
    const hasTimestamp = reportedAt && Number.isFinite(reportedAt.getTime())
    const hasMetrics = Boolean(presentation?.metrics.length || health?.cpuCount || presentation?.loadDetail || presentation?.uptimeDetail)

    return (
        <div className="mt-3 space-y-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 p-3 text-xs">
            <section aria-label={t('settings.machines.performance')}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="font-medium text-[var(--app-fg)]">{t('settings.machines.performance')}</h3>
                    {hasTimestamp ? (
                        <span className="text-[var(--app-hint)]">
                            {t(machine.active ? 'settings.machines.lastReported' : 'settings.machines.offlineReport')}{' '}
                            <time dateTime={reportedAt.toISOString()}>{reportedAt.toLocaleString(locale)}</time>
                        </span>
                    ) : null}
                </div>
                {hasMetrics ? (
                    <>
                        <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                            {presentation?.metrics.map(metric => (
                                <div key={metric.id}>
                                    <div className="mb-1 flex justify-between gap-2">
                                        <span className="text-[var(--app-hint)]">{t(`machine.health.metric.${metric.id}`)}</span>
                                        <span className="tabular-nums text-[var(--app-fg)]">{metric.percent}%</span>
                                    </div>
                                    <div
                                        role="meter"
                                        aria-label={t(`machine.health.metric.${metric.id}`)}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={metric.percent}
                                        className="h-1.5 overflow-hidden rounded-full bg-[var(--app-border)]"
                                    >
                                        <div className={`h-full rounded-full ${MACHINE_HEALTH_BAR_FILL_CLASS[metric.tone]}`} style={{ width: `${metric.percent}%` }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[var(--app-hint)]">
                            {health?.cpuCount ? (
                                <div className="flex gap-2">
                                    <dt>{t('settings.machines.cpuCores')}</dt>
                                    <dd className="tabular-nums text-[var(--app-fg)]">{health.cpuCount}</dd>
                                </div>
                            ) : null}
                            {presentation?.loadDetail ? (
                                <div className="flex gap-2">
                                    <dt>{t('machine.health.tooltip.loadShort')}</dt>
                                    <dd className="tabular-nums text-[var(--app-fg)]">{presentation.loadDetail}</dd>
                                </div>
                            ) : null}
                            {presentation?.uptimeDetail ? (
                                <div className="flex gap-2">
                                    <dt>{t('machine.health.tooltip.uptimeShort')}</dt>
                                    <dd className="tabular-nums text-[var(--app-fg)]">{presentation.uptimeDetail}</dd>
                                </div>
                            ) : null}
                        </dl>
                    </>
                ) : <p className="text-[var(--app-hint)]">{t('settings.machines.noPerformance')}</p>}
            </section>
            <section aria-label={t('settings.machines.workspaces')} className="border-t border-[var(--app-border)] pt-3">
                <h3 className="mb-2 font-medium text-[var(--app-fg)]">
                    {t('settings.machines.workspaces')}{roots.length > 0 ? ` (${roots.length})` : ''}
                </h3>
                {roots.length > 0 ? (
                    <ul className="space-y-1.5">
                        {roots.map(root => <li key={root}><code className="block break-all text-[var(--app-fg)]">{root}</code></li>)}
                    </ul>
                ) : <p className="text-[var(--app-hint)]">{t('settings.machines.noWorkspaces')}</p>}
            </section>
        </div>
    )
}
