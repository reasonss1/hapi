import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentFlavor } from '@hapi/protocol'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { resolveCodexCommand } from '@/codex/utils/codexExecutable'
import { resolveCodexAppServerCommand } from '@/codex/codexAppServerClient'
import { resolveSharedCodex } from '@/codex/shared/launch'
import { getAgentLaunchCommand } from './agentLaunchCommand'
import { getManagedAgentLaunchPolicy } from './managedAgentLaunchPolicy'

const homes: string[] = []

async function newHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
    homes.push(home)
    return home
}

async function activate(home: string, agent: AgentFlavor, version: string): Promise<string> {
    const directory = join(home, 'agent-tools', agent)
    const bin = join(directory, `${version}-fixture`, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const command = join(bin, agent)
    await writeFile(command, '#!/bin/sh\necho codex-cli 0.160.0\n')
    await chmod(command, 0o755)
    await writeFile(join(directory, 'active.json'), JSON.stringify({ version, command }))
    return command
}

afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('managed launch selection', () => {
    it.each(['claude', 'codex', 'pi', 'opencode', 'copilot'] as const)(
        'keeps an existing %s execution on its initial version while fresh probes see activation',
        async agent => {
            const home = await newHome()
            const env = { HAPI_HOME: home, PATH: '' }
            const first = await activate(home, agent, '1.0.0')
            const resolveCommand = (freshManaged = false) => agent === 'claude'
                ? getDefaultClaudeCodePath(env, { freshManaged })
                : agent === 'codex'
                    ? resolveCodexCommand(env, process.platform, { freshManaged }).command
                    : getAgentLaunchCommand(agent, env, { freshManaged })

            expect(resolveCommand()).toBe(first)
            const second = await activate(home, agent, '2.0.0')
            expect(resolveCommand()).toBe(first)
            expect(resolveCommand(true)).toBe(second)
        },
    )

    it('keeps a running PATH execution on PATH after its first managed installation', async () => {
        const home = await newHome()
        const env = { HAPI_HOME: home, PATH: '' }
        expect(getAgentLaunchCommand('pi', env)).toBe('pi')
        const command = await activate(home, 'pi', '1.0.0')
        expect(getAgentLaunchCommand('pi', env)).toBe('pi')
        expect(getAgentLaunchCommand('pi', env, { freshManaged: true })).toBe(command)
    })

    it('honors explicit Claude and Copilot paths ahead of managed versions', async () => {
        const home = await newHome()
        await activate(home, 'claude', '1.0.0')
        await activate(home, 'copilot', '1.0.0')
        expect(getDefaultClaudeCodePath({ HAPI_HOME: home, HAPI_CLAUDE_PATH: '/custom/claude' })).toBe('/custom/claude')
        expect(getAgentLaunchCommand('copilot', { HAPI_HOME: home, COPILOT_CLI_PATH: '/custom/copilot' })).toBe('/custom/copilot')
    })

    it('disables native auto-update for retained managed versions without changing the caller environment', async () => {
        const home = await newHome()
        const env = { HAPI_HOME: home, DISABLE_AUTOUPDATER: '0' }
        const claude = await activate(home, 'claude', '1.0.0')
        const copilot = await activate(home, 'copilot', '1.0.0')
        await activate(home, 'claude', '2.0.0')
        await activate(home, 'copilot', '2.0.0')

        expect(getManagedAgentLaunchPolicy('claude', claude, env).env.DISABLE_AUTOUPDATER).toBe('1')
        expect(env.DISABLE_AUTOUPDATER).toBe('0')
        expect(getManagedAgentLaunchPolicy('copilot', copilot, env).extraArgs).toEqual(['--no-auto-update'])
    })

    it('preserves native auto-update settings for explicit and unmanaged commands', async () => {
        const home = await newHome()
        const claude = await activate(home, 'claude', '1.0.0')
        const copilot = await activate(home, 'copilot', '1.0.0')
        const env = { HAPI_HOME: home, DISABLE_AUTOUPDATER: '0', HAPI_CLAUDE_PATH: claude, COPILOT_CLI_PATH: copilot }

        expect(getManagedAgentLaunchPolicy('claude', claude, env).env).toBe(env)
        expect(getManagedAgentLaunchPolicy('copilot', copilot, env).extraArgs).toEqual([])
        expect(getManagedAgentLaunchPolicy('claude', '/custom/claude', env).env).toBe(env)
        expect(getManagedAgentLaunchPolicy('copilot', '/custom/copilot', env).extraArgs).toEqual([])
    })

    it('uses fresh managed Codex for machine probes and preserves an explicit runner override', async () => {
        const home = await newHome()
        vi.stubEnv('HAPI_HOME', home)
        vi.stubEnv('HAPI_CODEX_APP_SERVER_BIN', '')
        const first = await activate(home, 'codex', '1.0.0')
        expect(resolveCodexAppServerCommand()).toBe(first)
        const second = await activate(home, 'codex', '2.0.0')
        expect(resolveCodexAppServerCommand()).toBe(first)
        expect(resolveCodexAppServerCommand({ freshManaged: true })).toBe(second)

        vi.stubEnv('HAPI_CODEX_APP_SERVER_BIN', second)
        expect(resolveSharedCodex({ startedBy: 'runner' }).command).toBe(second)
        expect(resolveSharedCodex({ startedBy: 'terminal' }).command).toBe(first)
        expect(resolveCodexAppServerCommand()).toBe(second)
    })
})
