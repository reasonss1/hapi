import { initializeToken } from '@/ui/tokenInit'
import { runHubTodoMcpServer } from '@/plugins/hubTodo'
import type { CommandDefinition } from './types'

export const todoMcpCommand: CommandDefinition = {
    name: 'todo-mcp',
    requiresRuntimeAssets: false,
    run: async () => {
        await initializeToken()
        await runHubTodoMcpServer()
    },
}
