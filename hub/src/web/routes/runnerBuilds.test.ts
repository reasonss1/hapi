import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_VERSION } from '@hapi/protocol/buildInfo'
import { Hono } from 'hono'
import { signWebJwt } from '../authTokens'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createRunnerBuildRoutes } from './runnerBuilds'

const jwtSecret = new TextEncoder().encode('test-only-signing-secret')
const manifestPath = '/api/runner-builds/linux-x64'

function createApp(binary: string | null) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(jwtSecret))
    app.route('/api', createRunnerBuildRoutes(binary))
    return app
}

describe('custom Runner downloads', () => {
    it('requires authentication and serves only the binary matching the manifest hash', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-runner-build-test-'))
        try {
            const content = 'fixture binary'
            const binary = join(directory, 'hapi')
            await writeFile(binary, content)
            const app = createApp(binary)
            const sha256 = createHash('sha256').update(content).digest('hex')
            const url = manifestPath + '/' + sha256

            expect((await app.request(manifestPath)).status).toBe(401)
            expect((await app.request(url)).status).toBe(401)
            const jwt = await signWebJwt(jwtSecret, 1, 'default')
            const headers = { Authorization: 'Bearer ' + jwt }
            const manifest = await app.request(manifestPath, { headers })
            expect(await manifest.json()).toEqual({ version: APP_VERSION, sha256, bytes: content.length })
            expect((await app.request(manifestPath + '/' + '0'.repeat(64), { headers })).status).toBe(404)
            const download = await app.request(url, { headers })
            expect(download.status).toBe(200)
            expect(download.headers.get('Cache-Control')).toBe('private, no-store')
            expect(await download.text()).toBe(content)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it('has no build when running from source', async () => {
        const jwt = await signWebJwt(jwtSecret, 1, 'default')
        expect((await createApp(null).request(manifestPath, { headers: { Authorization: 'Bearer ' + jwt } })).status).toBe(404)
    })
})
