import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
    DEFAULT_SESSION_LIST_MACHINE_FILTER,
    getInitialSessionListMachineFilter,
    forgetSessionListMachineFilter,
    useSessionListMachineFilter,
} from './useSessionListMachineFilter'

describe('useSessionListMachineFilter helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to null (all machines) for missing or blank storage values', () => {
        expect(getInitialSessionListMachineFilter()).toBe(DEFAULT_SESSION_LIST_MACHINE_FILTER)
        expect(getInitialSessionListMachineFilter()).toBeNull()

        window.localStorage.setItem('hapi-session-list-machine-filter', '')
        expect(getInitialSessionListMachineFilter()).toBeNull()

        window.localStorage.setItem('hapi-session-list-machine-filter', '   ')
        expect(getInitialSessionListMachineFilter()).toBeNull()
    })

    it('reads a stored machine id', () => {
        window.localStorage.setItem('hapi-session-list-machine-filter', 'machine-1')

        expect(getInitialSessionListMachineFilter()).toBe('machine-1')
    })

    it('clears a deleted machine filter in storage and in the mounted sidebar', () => {
        window.localStorage.setItem('hapi-session-list-machine-filter', 'machine-1')
        const { result } = renderHook(() => useSessionListMachineFilter())

        act(() => forgetSessionListMachineFilter('machine-1'))

        expect(getInitialSessionListMachineFilter()).toBeNull()
        expect(result.current.machineFilter).toBeNull()
    })

    it('preserves a filter for another machine', () => {
        window.localStorage.setItem('hapi-session-list-machine-filter', 'machine-2')

        forgetSessionListMachineFilter('machine-1')

        expect(getInitialSessionListMachineFilter()).toBe('machine-2')
    })
})
