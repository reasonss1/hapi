import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { DEFAULT_NAMESPACE, parseAccessToken } from '../../utils/accessToken'
import { constantTimeEquals } from '../../utils/crypto'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'

const CODE_LIFETIME_MS = 10 * 60 * 1000
const MAX_PENDING_CODES = 256
const issueSchema = z.object({ accessToken: z.string().min(1).max(4096) })
const redeemSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_\-]{32}$/) })

export function createRunnerEnrollmentRoutes(cliApiToken: string, jwtSecret: Uint8Array): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    // A Hub restart invalidates all pending codes. Only the namespace needs to be retained.
    const pending = new Map<string, { namespace: string; expiresAt: number }>()
    const limitBody = bodyLimit({ maxSize: 8192 })

    app.post('/runner-enrollment', createAuthMiddleware(jwtSecret), limitBody, async (c) => {
        c.header('Cache-Control', 'no-store')
        const body = issueSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        // The web JWT alone must not grant access to the Hub-wide CLI secret.
        const token = parseAccessToken(body.data.accessToken)
        const namespace = c.get('namespace')
        if (!token || token.namespace !== namespace || !constantTimeEquals(token.baseToken, cliApiToken)) {
            return c.json({ error: 'Invalid access token for this namespace' }, 403)
        }

        const now = Date.now()
        for (const [code, { expiresAt }] of pending) {
            if (expiresAt <= now) pending.delete(code)
        }
        if (pending.size >= MAX_PENDING_CODES) {
            return c.json({ error: 'Too many pending setup codes' }, 429)
        }

        const code = randomBytes(24).toString('base64url')
        const expiresAt = now + CODE_LIFETIME_MS
        pending.set(code, { namespace, expiresAt })
        return c.json({ code, expiresAt }, 201)
    })

    app.post('/runner-enrollment/redeem', limitBody, async (c) => {
        c.header('Cache-Control', 'no-store')
        const body = redeemSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) {
            return c.json({ error: 'Invalid setup code' }, 400)
        }

        const { code } = body.data
        const enrollment = pending.get(code)
        pending.delete(code)
        if (!enrollment || enrollment.expiresAt <= Date.now()) {
            return c.json({ error: 'Setup code has expired or has already been used' }, 401)
        }

        const { namespace } = enrollment
        const accessToken = namespace === DEFAULT_NAMESPACE ? cliApiToken : `${cliApiToken}:${namespace}`
        return c.json({ accessToken })
    })

    return app
}
