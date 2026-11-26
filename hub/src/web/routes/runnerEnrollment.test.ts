import { describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { signWebJwt } from '../authTokens'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createRunnerEnrollmentRoutes } from './runnerEnrollment'

const jwtSecret = new TextEncoder().encode('test-only-signing-secret')
const cliApiToken = 'fixture-cli-token'

function createApp() {
    const app = new Hono<WebAppEnv>()
    app.route('/api', createRunnerEnrollmentRoutes(cliApiToken, jwtSecret))
    app.use('/api/*', createAuthMiddleware(jwtSecret))
    return app
}

function post(app: Hono<WebAppEnv>, path: string, body: unknown, jwt?: string) {
    return app.request(`/api/runner-enrollment${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
        },
        body: JSON.stringify(body)
    })
}

describe('Runner enrollment', () => {
    it('requires a web JWT and the CLI token for its namespace', async () => {
        const app = createApp()
        const jwt = await signWebJwt(jwtSecret, 1, 'work')
        expect((await post(app, '', { accessToken: `${cliApiToken}:work` })).status).toBe(401)
        expect((await post(app, '', { accessToken: cliApiToken }, jwt)).status).toBe(403)
        expect((await post(app, '', { accessToken: 'wrong:work' }, jwt)).status).toBe(403)
    })

    it('redeems a code once without a web session and preserves its namespace', async () => {
        const app = createApp()
        const accessToken = `${cliApiToken}:work`
        const jwt = await signWebJwt(jwtSecret, 1, 'work')
        const issued = await post(app, '', { accessToken }, jwt)
        expect(issued.status).toBe(201)
        expect(issued.headers.get('Cache-Control')).toBe('no-store')
        const { code } = await issued.json() as { code: string }
        expect(code).not.toContain(cliApiToken)

        const attempts = await Promise.all([
            post(app, '/redeem', { code }),
            post(app, '/redeem', { code })
        ])
        expect(attempts.map((response) => response.status).sort()).toEqual([200, 401])
        const success = attempts.find((response) => response.ok)!
        expect(success.headers.get('Cache-Control')).toBe('no-store')
        expect(await success.json()).toEqual({ accessToken })
    })

    it('rejects an expired code', async () => {
        const app = createApp()
        const jwt = await signWebJwt(jwtSecret, 1, 'default')
        const issued = await post(app, '', { accessToken: cliApiToken }, jwt)
        expect(issued.status).toBe(201)
        const { code, expiresAt } = await issued.json() as { code: string; expiresAt: number }

        const now = spyOn(Date, 'now').mockReturnValue(expiresAt)
        try {
            expect((await post(app, '/redeem', { code })).status).toBe(401)
        } finally {
            now.mockRestore()
        }
    })
})
