import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import SettingsMachinesPage from '@/routes/settings/machines'

const renameMachineMock = vi.fn()
const deleteMachineMock = vi.fn()
const machinesMock = vi.fn()
const createRunnerEnrollmentMock = vi.fn()
const canCreateRunnerEnrollment = vi.fn()
const copyToClipboardMock = vi.fn()
const baseUrlMock = vi.fn()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { renameMachine: renameMachineMock, deleteMachine: deleteMachineMock },
        baseUrl: baseUrlMock(),
        createRunnerEnrollment: canCreateRunnerEnrollment() ? createRunnerEnrollmentMock : undefined,
    }),
}))

vi.mock('@/lib/clipboard', () => ({ safeCopyToClipboard: async (text: string | Promise<string>) => copyToClipboardMock(await text) }))

vi.mock('@/hooks/queries/useMachineManagement', () => ({
    useMachineManagement: () => ({ machines: machinesMock(), isLoading: false, error: null }),
}))

function makeMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'workstation.local',
            platform: 'linux',
            happyCliVersion: '1.0.0',
        },
        ...overrides,
    } as Machine
}

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SettingsMachinesPage />
            </I18nProvider>
        </QueryClientProvider>,
    )
    return { ...view, queryClient }
}

function startEditing(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Rename ${name}` }))
    return screen.getByRole('textbox')
}

describe('SettingsMachinesPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.localStorage.setItem('hapi-lang', 'en')
        renameMachineMock.mockResolvedValue(undefined)
        deleteMachineMock.mockResolvedValue({ ok: true, deletedSessions: 2 })
        machinesMock.mockReturnValue([makeMachine()])
        canCreateRunnerEnrollment.mockReturnValue(true)
        createRunnerEnrollmentMock.mockResolvedValue({ code: 'test-enrollment-code', expiresAt: Date.now() + 600_000 })
        copyToClipboardMock.mockResolvedValue(undefined)
        baseUrlMock.mockReturnValue('https://hub.example.test')
    })

    afterEach(() => {
        cleanup()
    })

    it('opens the localized installation instructions even when the device list is empty', async () => {
        window.localStorage.setItem('hapi-lang', 'zh-CN')
        machinesMock.mockReturnValue([])
        renderPage()

        fireEvent.click(screen.getByRole('button', { name: '一键添加新设备' }))

        const command = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'HAPI 安装命令' })
        expect(command.value).toContain('https://hub.example.test')
        expect(command.value).toContain('test-enrollment-code')
        expect(screen.getByText(/10 分钟内有效/)).toBeTruthy()
        expect(createRunnerEnrollmentMock).toHaveBeenCalledOnce()
        expect(copyToClipboardMock).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: '复制安装命令' }))
        await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith(command.value))
        expect(createRunnerEnrollmentMock).toHaveBeenCalledOnce()
    })

    it('copies a fresh connection command directly, including on another copy', async () => {
        createRunnerEnrollmentMock.mockResolvedValueOnce({ code: 'another-code', expiresAt: Date.now() + 600_000 })
        renderPage()

        const copy = screen.getByRole('button', { name: 'Copy install command' })
        fireEvent.click(copy)

        expect(await screen.findByText('Install command copied.')).toBeTruthy()
        expect(copyToClipboardMock).toHaveBeenLastCalledWith(expect.stringContaining("'https://hub.example.test' 'another-code'"))

        fireEvent.click(copy)
        await waitFor(() => expect(copyToClipboardMock).toHaveBeenLastCalledWith(expect.stringContaining("'https://hub.example.test' 'test-enrollment-code'")))
        expect(createRunnerEnrollmentMock).toHaveBeenCalledTimes(2)
    })

    it('provides a token prompt on the new device and selects the command if copy fails', async () => {
        canCreateRunnerEnrollment.mockReturnValue(false)
        copyToClipboardMock.mockRejectedValueOnce(new Error('Clipboard unavailable'))
        renderPage()

        fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }))

        expect((await screen.findByRole('alert')).textContent).toMatch(/copy the selected command manually/i)
        expect(screen.getByText('Enter your server access token when prompted in Terminal.')).toBeTruthy()
        const command = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'HAPI install command' })
        expect(document.activeElement).toBe(command)
        expect(command.selectionEnd).toBe(command.value.length)
        expect(command.value).toMatch(/'https:\/\/hub\.example\.test'$/)
        expect(createRunnerEnrollmentMock).not.toHaveBeenCalled()
    })

    it('does not generate a command that downloads an installer over network HTTP', async () => {
        baseUrlMock.mockReturnValue('http://hub.example.test')
        renderPage()

        fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }))

        expect((await screen.findByRole('alert')).textContent).toMatch(/Open this Hub over HTTPS/)
        expect(createRunnerEnrollmentMock).not.toHaveBeenCalled()
        expect(copyToClipboardMock).not.toHaveBeenCalled()
    })

    it('falls back to the hostname and always shows host and platform', () => {
        renderPage()

        expect(screen.getByRole('button', { name: 'Rename workstation.local' })).toBeTruthy()
        expect(screen.getByText('workstation.local · linux')).toBeTruthy()
        expect(screen.getByText('HAPI runner 1.0.0')).toBeTruthy()
    })

    it('shows performance and registered work directories on each device row', () => {
        machinesMock.mockReturnValue([makeMachine({
            health: { collectedAt: Date.now(), cpuCount: 8, cpuPercent: 25, memoryPercent: 60 },
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', workspaceRoots: ['/projects/first', '/projects/second'] },
        })])
        renderPage()

        expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('25')
        expect(screen.getByText('/projects/first')).toBeTruthy()
        expect(screen.getByText('/projects/second')).toBeTruthy()
    })

    it('shows the custom name while keeping the hostname visible', () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])

        renderPage()

        expect(screen.getByRole('button', { name: 'Rename Workstation' })).toBeTruthy()
        expect(screen.getByText('workstation.local · linux')).toBeTruthy()
    })

    it('seeds the input with the current custom name, not the hostname', () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])
        renderPage()

        expect((startEditing('Workstation') as HTMLInputElement).value).toBe('Workstation')
    })

    it('leaves the input empty when no custom name is set', () => {
        renderPage()

        expect((startEditing('workstation.local') as HTMLInputElement).value).toBe('')
    })

    it('saves a trimmed name on Enter', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: '  Workstation  ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', 'Workstation'))
    })

    it('saves on blur', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.blur(input)

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', 'Workstation'))
    })

    it('submits once when Enter is followed by a blur', async () => {
        // Disabling a focused control forces it to blur, so a real browser fires
        // blur right after Enter starts the save. jsdom does not reproduce that,
        // so the sequence is driven explicitly here.
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.blur(input)

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalled())
        expect(renameMachineMock).toHaveBeenCalledTimes(1)
    })

    it('clears the name with an empty string', async () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])
        renderPage()
        const input = startEditing('Workstation')

        fireEvent.change(input, { target: { value: '   ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', ''))
    })

    it('does not call the API when the name is unchanged', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
        expect(renameMachineMock).not.toHaveBeenCalled()
    })

    it('cancels on Escape without calling the API', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Escape' })

        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
        expect(renameMachineMock).not.toHaveBeenCalled()
    })

    it('surfaces an error and keeps the editor open when the save fails', async () => {
        renameMachineMock.mockRejectedValue(new Error('HTTP 409'))
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(screen.getByText('Could not rename this machine.')).toBeTruthy())
        expect(screen.getByRole('textbox')).toBeTruthy()
    })

    it('renders an empty state when no machines or machine sessions remain', () => {
        machinesMock.mockReturnValue([])
        renderPage()

        expect(screen.getByText('No machines or saved machine sessions.')).toBeTruthy()
    })

    it('shows offline machines and session-only machines without offering to rename a missing machine', () => {
        machinesMock.mockReturnValue([
            makeMachine({ active: false }),
            { ...makeMachine({ id: 'ghost', metadata: { host: 'old-device' } as Machine['metadata'] }), sessionOnly: true, sessionCount: 2 },
        ])
        renderPage()

        expect(screen.getByText('Offline')).toBeTruthy()
        expect(screen.getByText('Saved sessions only · 2 Hub sessions')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Rename old-device' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Delete old-device' })).toBeTruthy()
    })

    it('explains the deletion scope and allows cancelling before any request', () => {
        renderPage()
        fireEvent.click(screen.getByRole('button', { name: 'Delete workstation.local' }))

        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/HAPI sessions and Runner, then permanently delete its Hub registration/)).toBeTruthy()
        expect(within(dialog).getByText(/Original Codex/)).toBeTruthy()
        expect(within(dialog).getByText(/shared connection token is not revoked/)).toBeTruthy()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(deleteMachineMock).not.toHaveBeenCalled()
    })

    it('deletes the requested machine, clears only its browser cache, and refreshes machines and sessions', async () => {
        const { queryClient } = renderPage()
        const machines = [makeMachine(), makeMachine({ id: 'machine-2' })]
        queryClient.setQueryData(queryKeys.machines, { machines })
        queryClient.setQueryData([...queryKeys.machines, 'management'], { machines })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'machine-1': 'Old device', 'machine-2': 'Keep device' }))
        window.localStorage.setItem('hapi-session-list-machine-filter', 'machine-1')
        window.localStorage.setItem('test-auth-token', 'keep-token')

        fireEvent.click(screen.getByRole('button', { name: 'Delete workstation.local' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete machine and Hub history' }))

        await waitFor(() => expect(deleteMachineMock).toHaveBeenCalledWith('machine-1'))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(JSON.parse(window.localStorage.getItem('hapi-machine-labels')!)).toEqual({ 'machine-2': 'Keep device' })
        expect(window.localStorage.getItem('hapi-session-list-machine-filter')).toBeNull()
        expect(window.localStorage.getItem('test-auth-token')).toBe('keep-token')
        expect(queryClient.getQueryData(queryKeys.machines)).toEqual({ machines: [machines[1]] })
        expect(queryClient.getQueryData([...queryKeys.machines, 'management'])).toEqual({ machines: [machines[1]] })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.machines })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
    })

    it('keeps the confirmation and cached machine information when the server refuses deletion', async () => {
        deleteMachineMock.mockRejectedValue(new Error('Stop the Runner before deleting this machine.'))
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'machine-1': 'Keep device' }))
        renderPage()
        fireEvent.click(screen.getByRole('button', { name: 'Delete workstation.local' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete machine and Hub history' }))

        await waitFor(() => expect(screen.getByText('Stop the Runner before deleting this machine.')).toBeTruthy())
        expect(screen.getByRole('dialog')).toBeTruthy()
        expect(JSON.parse(window.localStorage.getItem('hapi-machine-labels')!)).toEqual({ 'machine-1': 'Keep device' })
    })

    it('links to the corresponding source archive of the deployed build', () => {
        renderPage()

        expect(screen.getByRole('link', { name: 'View source' }).getAttribute('href')).toBe('/hapi-local-source.tar.gz')
    })
})
