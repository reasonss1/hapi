import { useEffect, useId, useRef, useState } from 'react'
import type { RunnerEnrollment as RunnerEnrollmentResponse } from '@/api/client'
import { Button } from '@/components/ui/button'
import { CheckIcon, CopyIcon, PlusIcon } from '@/components/icons'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/lib/use-translation'

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

function installCommand(hubUrl: string, code?: string): string {
    const steps = [
        'set -e',
        'work=$(mktemp -d)',
        `trap 'rm -rf -- "$work"' EXIT`,
        'script="$work/install-hapi-runner.cjs"',
        'curl -fsS -o "$script" -- "$1/install-hapi-runner.cjs"',
        'node "$script" "$@"',
    ].join('; ')

    return `bash -c ${shellQuote(steps)} hapi-install ${shellQuote(hubUrl)}${code ? ` ${shellQuote(code)}` : ''}`
}

type Command = { text: string; expiresAt?: number }
type Feedback = 'copied' | 'copyFailed' | 'generateFailed' | 'insecureHub' | 'expired'

export function RunnerEnrollment(props: {
    baseUrl: string
    createRunnerEnrollment?: () => Promise<RunnerEnrollmentResponse>
}) {
    const { t } = useTranslation()
    const panelId = useId()
    const commandField = useRef<HTMLTextAreaElement>(null)
    const [expanded, setExpanded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [command, setCommand] = useState<Command | null>(null)
    const [feedback, setFeedback] = useState<Feedback | null>(null)

    useEffect(() => {
        if (command?.expiresAt === undefined) return
        const timer = window.setTimeout(() => {
            setCommand(null)
            setFeedback('expired')
        }, Math.max(0, command.expiresAt - Date.now()))
        return () => window.clearTimeout(timer)
    }, [command])

    useEffect(() => {
        if (feedback === 'copyFailed') {
            commandField.current?.focus()
            commandField.current?.select()
        }
    }, [feedback])

    async function prepare(copy: boolean) {
        setExpanded(true)
        setFeedback(null)
        setBusy(true)

        try {
            const hub = new URL(props.baseUrl || window.location.origin)
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hub.hostname)
            if (hub.protocol !== 'https:' && !(hub.protocol === 'http:' && loopback)) {
                setFeedback('insecureHub')
                return
            }
            const reusable = copy && feedback !== 'copied' && command
                && (command.expiresAt === undefined || command.expiresAt > Date.now()) ? command : null
            if (!reusable) setCommand(null)

            const next = reusable ?? (props.createRunnerEnrollment
                ? props.createRunnerEnrollment().then(({ code, expiresAt }) => ({ text: installCommand(hub.origin, code), expiresAt }))
                : { text: installCommand(hub.origin) })
            const copying = copy ? safeCopyToClipboard(next instanceof Promise ? next.then(({ text }) => text) : next.text)
                .then(() => 'copied' as const, () => 'copyFailed' as const) : null

            setCommand(await next)
            if (copying) setFeedback(await copying)
        } catch {
            setFeedback('generateFailed')
        } finally {
            setBusy(false)
        }
    }

    function toggle() {
        if (expanded) {
            setExpanded(false)
            setCommand(null)
            setFeedback(null)
        } else {
            void prepare(false)
        }
    }

    const copyLabel = t('settings.machines.enrollment.copy')
    const error = feedback === 'copyFailed' || feedback === 'generateFailed' || feedback === 'insecureHub'

    return (
        <div className="px-3 py-3">
            <div className="flex items-center gap-2">
                <Button type="button" onClick={toggle} disabled={busy} aria-expanded={expanded} aria-controls={panelId} className="gap-2">
                    <PlusIcon className="h-4 w-4" />
                    {t('settings.machines.enrollment.add')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void prepare(true)} disabled={busy} aria-label={copyLabel} title={copyLabel} className="w-9 px-0">
                    {feedback === 'copied' ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                </Button>
            </div>
            <div id={panelId} hidden={!expanded} className="mt-3 space-y-2">
                <p className="text-sm text-[var(--app-hint)]">{t('settings.machines.enrollment.instructions')}</p>
                <p className="text-xs text-[var(--app-hint)]">
                    {t(props.createRunnerEnrollment ? 'settings.machines.enrollment.oneTime' : 'settings.machines.enrollment.manual')}
                </p>
                {command ? (
                    <textarea
                        ref={commandField}
                        aria-label={t('settings.machines.enrollment.command')}
                        rows={3}
                        readOnly
                        spellCheck={false}
                        value={command.text}
                        onFocus={(event) => event.currentTarget.select()}
                        className="block w-full resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 font-mono text-xs text-[var(--app-fg)]"
                    />
                ) : null}
                {busy ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('settings.machines.enrollment.preparing')}</p> : null}
                {feedback ? (
                    <p role={error ? 'alert' : 'status'} className={`text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-[var(--app-hint)]'}`}>
                        {t(`settings.machines.enrollment.${feedback}`)}
                    </p>
                ) : null}
            </div>
        </div>
    )
}
