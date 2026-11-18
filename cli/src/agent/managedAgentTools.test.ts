import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    getManagedAgentCommand,
    getManagedAgentDirectory,
    getManagedAgentManifestPath,
    getPinnedManagedAgentCommand,
} from './managedAgentTools'

const temporaryHomes: string[] = []
afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-managed-tools-'))
    temporaryHomes.push(home)
    const env = { HAPI_HOME: home }
    await mkdir(getManagedAgentDirectory('codex', env), { recursive: true })
    async function activate(version: string) {
        const directory = join(getManagedAgentDirectory('codex', env), version)
        await mkdir(directory, { recursive: true })
        const command = join(directory, 'codex')
        await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        await writeFile(getManagedAgentManifestPath('codex', env), JSON.stringify({ version, command }))
        return command
    }
    return { env, home, activate }
}

describe('managed agent selection', () => {
    it('keeps an existing session on its original immutable version', async () => {
        const f = await fixture()
        const old = await f.activate('1.0.0')
        expect(getPinnedManagedAgentCommand('codex', f.env)).toBe(old)
        const next = await f.activate('2.0.0')
        expect(getManagedAgentCommand('codex', f.env)).toBe(next)
        expect(getPinnedManagedAgentCommand('codex', f.env)).toBe(old)
    })

    it('pins the absence of managed tools for a process that started before an update', async () => {
        const f = await fixture()
        expect(getPinnedManagedAgentCommand('codex', f.env)).toBeNull()
        const next = await f.activate('2.0.0')
        expect(getManagedAgentCommand('codex', f.env)).toBe(next)
        expect(getPinnedManagedAgentCommand('codex', f.env)).toBeNull()
    })

    it('rejects manifests that point to another tool or escape through a symlink', async () => {
        const f = await fixture()
        const outside = join(f.home, 'outside')
        await writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        const linked = join(getManagedAgentDirectory('codex', f.env), 'escaped')
        await symlink(outside, linked)
        for (const command of [outside, linked, 'relative/codex']) {
            await writeFile(getManagedAgentManifestPath('codex', f.env), JSON.stringify({ version: '1.0.0', command }))
            expect(getManagedAgentCommand('codex', f.env)).toBeNull()
        }
    })
})
