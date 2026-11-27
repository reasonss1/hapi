import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolveMcpConfigArg } from './mcpConfig'

describe('Hub Todo MCP credentials in Claude configuration', () => {
    it('uses a private temporary file, keeps the token out of argv, and cleans up', () => {
        const config = { 'hapi-todo': { type: 'stdio', command: 'hapi', args: ['todo-mcp'], env: { CLI_API_TOKEN: 'private-test-token' } } }
        const result = resolveMcpConfigArg(config, { useFile: false })
        try {
            expect(result.value).not.toContain('private-test-token')
            expect(JSON.parse(readFileSync(result.value, 'utf8'))).toEqual({ mcpServers: config })
            if (process.platform !== 'win32') expect(statSync(result.value).mode & 0o777).toBe(0o600)
        } finally { result.cleanup?.() }
        expect(existsSync(result.value)).toBe(false)
    })
})
