import { z } from 'zod'

export const AgentToolIdSchema = z.enum(['codex', 'claude', 'pi', 'opencode', 'copilot', 'grok', 'cursor', 'kimi', 'agy', 'dsh'])
export type AgentToolId = z.infer<typeof AgentToolIdSchema>

export const AgentToolStatusSchema = z.object({
    id: AgentToolIdSchema,
    name: z.string(),
    installedVersion: z.string().nullable(),
    latestVersion: z.string().nullable(),
    canUpdate: z.boolean(),
    state: z.enum(['idle', 'installing', 'retrying', 'updated', 'failed']),
    reason: z.string().optional(),
})
export type AgentToolStatus = z.infer<typeof AgentToolStatusSchema>

export const AgentToolsResponseSchema = z.object({
    tools: z.array(AgentToolStatusSchema),
    checkedAt: z.number().nullable(),
})
export type AgentToolsResponse = z.infer<typeof AgentToolsResponseSchema>
export const UpdateAgentToolRequestSchema = z.object({ tool: AgentToolIdSchema }).strict()
