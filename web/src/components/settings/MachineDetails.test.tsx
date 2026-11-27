import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { Machine } from '@/types/api'
import { MachineDetails } from './MachineDetails'

function show(overrides: Partial<Machine> = {}) {
    const machine = {
        id: 'test', active: true,
        metadata: { host: 'host', platform: 'linux', happyCliVersion: '1', workspaceRoots: ['/work/project one', '/work/project one', '/work/' + 'long-project/'.repeat(20)] },
        health: { collectedAt: 1_795_700_000_000, cpuCount: 8, cpuPercent: 0, memoryPercent: 72, load1m: 1.2, uptimeSeconds: 90000 },
        ...overrides,
    } as Machine
    return render(<I18nProvider><MachineDetails machine={machine} /></I18nProvider>)
}

describe('MachineDetails', () => {
    beforeEach(() => window.localStorage.setItem('hapi-lang', 'en'))
    afterEach(cleanup)

    it('shows CPU/RAM meters, CPU capacity, load, uptime and the report timestamp', () => {
        const view = show()
        expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('0')
        expect(screen.getByRole('meter', { name: 'RAM' }).getAttribute('aria-valuenow')).toBe('72')
        expect(screen.getByText('CPU cores')).toBeTruthy()
        expect(screen.getByText('8')).toBeTruthy()
        expect(screen.getByText('1.2/8')).toBeTruthy()
        expect(screen.getByText('1d 1h')).toBeTruthy()
        expect(view.container.querySelector('time')?.dateTime).toBe(new Date(1_795_700_000_000).toISOString())
    })

    it('shows all registered directories once, including long paths and spaces', () => {
        show()
        const directories = within(screen.getByRole('region', { name: 'Added work directories' }))
        expect(directories.getByText('Added work directories (2)')).toBeTruthy()
        expect(directories.getAllByRole('listitem')).toHaveLength(2)
        expect(directories.getByText('/work/project one')).toBeTruthy()
        expect(directories.getByText('/work/' + 'long-project/'.repeat(20))).toBeTruthy()
    })

    it('identifies offline metrics as the last report and keeps registered paths visible', () => {
        show({ active: false })
        expect(screen.getByText('Offline · last reported:')).toBeTruthy()
        expect(screen.getByRole('meter', { name: 'RAM' })).toBeTruthy()
        expect(screen.getByText('/work/project one')).toBeTruthy()
    })

    it('explains missing data without inventing metrics or registered directories', () => {
        show({ health: null, metadata: null })
        expect(screen.getByText('No performance data reported by this device yet.')).toBeTruthy()
        expect(screen.getByText(/No work directories registered/)).toBeTruthy()
        expect(screen.queryByRole('meter')).toBeNull()
        expect(screen.queryByRole('list')).toBeNull()
    })

    it('shows CPU capacity even before usage samples arrive', () => {
        show({ health: { collectedAt: 1_795_700_000_000, cpuCount: 4 } })
        expect(screen.getByText('4')).toBeTruthy()
        expect(screen.queryByRole('meter')).toBeNull()
        expect(screen.queryByText('No performance data reported by this device yet.')).toBeNull()
    })

    it('localizes the details and empty state in Chinese', () => {
        window.localStorage.setItem('hapi-lang', 'zh-CN')
        show({ health: null })
        expect(screen.getByRole('region', { name: '设备性能' })).toBeTruthy()
        expect(screen.getByRole('region', { name: '已添加的工作目录' })).toBeTruthy()
        expect(screen.getByText('设备尚未上报性能数据。')).toBeTruthy()
    })
})
