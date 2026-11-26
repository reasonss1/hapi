import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { AgentToolsResponse, AgentToolStatus } from '@hapi/protocol/agentTools'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { I18nContext } from '@/lib/i18n-context'
import en from '@/lib/locales/en'
import { queryKeys } from '@/lib/query-keys'
import { MachineAgentTools } from './MachineAgentTools'

const getTools = vi.fn()
const updateTool = vi.fn()
const api = { getMachineAgentTools: getTools, updateMachineAgentTool: updateTool } as unknown as ApiClient
const clients: QueryClient[] = []

function machine(supported = true): Machine {
    return {
        id: 'device-1', active: true,
        metadata: {
            host: 'workstation', platform: 'linux', happyCliVersion: '0.36.0',
            capabilities: supported ? [MACHINE_CAPABILITIES.AgentToolUpdates] : [],
        },
    } as Machine
}

function tool(overrides: Partial<AgentToolStatus> = {}): AgentToolStatus {
    return {
        id: 'codex', name: 'Codex', installedVersion: '1.0.0', latestVersion: '1.1.0',
        canUpdate: true, state: 'idle', ...overrides,
    }
}

function response(tools: AgentToolStatus[] = [tool()]): AgentToolsResponse {
    return { tools, checkedAt: 1 }
}

function renderTools(options: { supported?: boolean; cached?: AgentToolsResponse } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    clients.push(queryClient)
    if (options.cached) queryClient.setQueryData(queryKeys.machineAgentTools('device-1'), options.cached)
    const rendered = render(
        <QueryClientProvider client={queryClient}>
            <I18nContext.Provider value={{
                locale: 'en', setLocale: () => {},
                t: (key, params) => (en as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match)) ?? key,
            }}>
                <MachineAgentTools api={api} machine={machine(options.supported)} />
            </I18nContext.Provider>
        </QueryClientProvider>,
    )
    return { ...rendered, queryClient }
}

describe('MachineAgentTools', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
        getTools.mockResolvedValue(response())
        updateTool.mockResolvedValue(response([tool({ state: 'installing', canUpdate: false })]))
    })

    afterEach(() => {
        for (const client of clients.splice(0)) client.clear()
        vi.restoreAllMocks()
    })

    it('shows the runner version and explains the one-time bootstrap for older runners', () => {
        renderTools({ supported: false })
        expect(screen.getByText('HAPI runner 0.36.0')).toBeTruthy()
        expect(screen.getByText('This Runner lacks remote agent updates. If your platform has a custom HAPI build with this capability, install it using “Add new device”.')).toBeTruthy()
        expect(getTools).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
    })

    it('checks versions automatically and only offers updates for installed supported tools', async () => {
        getTools.mockResolvedValue(response([
            tool(),
            tool({ id: 'claude', name: 'Claude Code', installedVersion: '2.0.0', latestVersion: '2.0.0', canUpdate: false }),
            tool({ id: 'pi', name: 'Pi', installedVersion: null, latestVersion: null, canUpdate: false, reason: 'not_installed' }),
        ]))
        renderTools()
        expect(await screen.findByRole('button', { name: 'Update Codex' })).toBeEnabled()
        expect(getTools).toHaveBeenCalledWith('device-1', true)
        expect(screen.getByText('1.0.0')).toBeTruthy()
        expect(screen.getByText('Latest 1.1.0')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Update Claude Code' })).toBeNull()
        expect(screen.getByText('Up to date')).toBeTruthy()
        expect(screen.queryByText('Pi')).toBeNull()
        expect(screen.getByText('Existing sessions keep running. New sessions use the updated version.')).toBeTruthy()
    })

    it('keeps detected tools visible when checking their version would interrupt a session', async () => {
        getTools.mockResolvedValue(response([
            tool({ id: 'cursor', name: 'Cursor', installedVersion: null, latestVersion: null, canUpdate: false, reason: 'manual_version' }),
        ]))
        renderTools()
        expect(await screen.findByText('Cursor')).toBeTruthy()
        expect(screen.getByText('Check this tool’s version on the device.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Update Cursor' })).toBeNull()
        expect(screen.queryByText('No supported agents detected on this device.')).toBeNull()
    })

    it('accepts one update despite repeated clicks, then shows background status', async () => {
        let resolveUpdate!: (data: AgentToolsResponse) => void
        updateTool.mockImplementation(() => new Promise<AgentToolsResponse>((resolve) => { resolveUpdate = resolve }))
        renderTools()
        const button = await screen.findByRole('button', { name: 'Update Codex' })
        fireEvent.click(button)
        fireEvent.click(button)
        await waitFor(() => expect(updateTool).toHaveBeenCalledTimes(1))
        expect(updateTool).toHaveBeenCalledWith('device-1', 'codex')
        expect(button).toBeDisabled()
        resolveUpdate(response([tool({ state: 'installing', canUpdate: false })]))
        expect(await screen.findByText('Updating… You can keep working.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Update Codex' })).toBeNull()
    })

    it('updates every available tool even if one update request fails', async () => {
        const claude = tool({ id: 'claude', name: 'Claude Code', installedVersion: '2.0.0', latestVersion: '2.1.0' })
        getTools.mockResolvedValue(response([tool(), claude]))
        updateTool.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response([
            tool(), { ...claude, state: 'installing', canUpdate: false },
        ]))
        renderTools()
        fireEvent.click(await screen.findByRole('button', { name: 'Update all' }))
        await waitFor(() => expect(updateTool).toHaveBeenCalledTimes(2))
        expect(updateTool.mock.calls.map((call) => call[1])).toEqual(['codex', 'claude'])
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm the update.')
    })

    it('keeps the current version visible when an update fails', async () => {
        getTools.mockResolvedValue(response([tool({ state: 'failed', reason: 'install_failed' })]))
        renderTools()
        expect(await screen.findByText('Update not applied. Your current version is still available.')).toBeTruthy()
        expect(screen.getByText('1.0.0')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Update Codex' })).toBeEnabled()
    })

    it('explains a low-space update failure while preserving the installed version', async () => {
        getTools.mockResolvedValue(response([tool({ state: 'failed', reason: 'disk_space' })]))
        renderTools()
        expect(await screen.findByText(en['settings.machines.tools.insufficientSpace'])).toBeTruthy()
        expect(screen.getByText('1.0.0')).toBeTruthy()
        expect(screen.queryByText('Updated. Ready for new sessions.')).toBeNull()
    })

    it('keeps a detected tool visible when its version probe fails', async () => {
        getTools.mockResolvedValue(response([tool({ installedVersion: null, latestVersion: null, canUpdate: false, reason: 'check_failed' })]))
        renderTools()
        expect(await screen.findByText('Codex')).toBeTruthy()
        expect(screen.getByText(en['settings.machines.tools.checkFailed'])).toBeTruthy()
        expect(screen.queryByText('No supported agents detected on this device.')).toBeNull()
    })

    it('resumes polling a cached update after navigating back', async () => {
        getTools.mockResolvedValue(response([tool({ installedVersion: '1.1.0', canUpdate: false, state: 'updated' })]))
        renderTools({ cached: response([tool({ canUpdate: false, state: 'retrying' })]) })
        expect(screen.getByText('Retrying automatically. You can keep working.')).toBeTruthy()
        expect(getTools).not.toHaveBeenCalled()
        await waitFor(() => expect(getTools).toHaveBeenCalledWith('device-1', false), { timeout: 4_000 })
        expect(await screen.findByText('Updated. Ready for new sessions.')).toBeTruthy()
        expect(screen.getByText('1.1.0')).toBeTruthy()
    })

    it('refreshes machine model and availability caches after an update, retaining session caches', async () => {
        let resolveCheck!: (data: AgentToolsResponse) => void
        getTools.mockImplementation(() => new Promise<AgentToolsResponse>((resolve) => { resolveCheck = resolve }))
        const { queryClient } = renderTools()
        queryClient.setQueryData(queryKeys.machineCodexModels('device-1'), { models: ['old-model'] })
        queryClient.setQueryData(queryKeys.machineAgentAvailability('device-1'), { agents: [] })
        queryClient.setQueryData(queryKeys.sessionCodexModels('existing-session'), { models: ['old-model'] })
        resolveCheck(response([tool({ installedVersion: '1.1.0', canUpdate: false, state: 'updated' })]))
        await waitFor(() => expect(queryClient.getQueryState(queryKeys.machineCodexModels('device-1'))?.isInvalidated).toBe(true))
        expect(queryClient.getQueryState(queryKeys.machineAgentAvailability('device-1'))?.isInvalidated).toBe(true)
        expect(queryClient.getQueryState(queryKeys.sessionCodexModels('existing-session'))?.isInvalidated).toBe(false)
    })

    it('does not send requests while offline', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        renderTools()
        expect(screen.getByText('Device offline. Updates will be available when it reconnects.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
        expect(getTools).not.toHaveBeenCalled()
    })

    it('lets a failed version check be retried', async () => {
        getTools.mockRejectedValueOnce(new Error('timeout'))
        renderTools()
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not check versions.')
        fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
        expect(await screen.findByRole('button', { name: 'Update Codex' })).toBeEnabled()
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
