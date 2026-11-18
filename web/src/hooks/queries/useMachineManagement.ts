import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export type ManagedMachine = Machine & {
    sessionOnly?: boolean
    sessionCount?: number
}

export function useMachineManagement(api: ApiClient | null): {
    machines: ManagedMachine[]
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        // Keep offline machines out of queries used to launch new sessions.
        queryKey: [...queryKeys.machines, 'management'],
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getMachines({ includeOffline: true })
        },
        enabled: Boolean(api),
    })

    return {
        machines: query.data?.machines ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machines' : null,
    }
}
