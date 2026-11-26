import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { APP_VERSION } from '@hapi/protocol/buildInfo'
import { Hono } from 'hono'
import { isBunCompiled } from '../../utils/bunCompiled'
import type { WebAppEnv } from '../middleware/auth'

export function resolveRunnerBuildPath(): string | null {
    return process.platform === 'linux' && process.arch === 'x64' && isBunCompiled() ? process.execPath : null
}

async function describeBinary(path: string) {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk)
        bytes += chunk.length
    }
    return { version: APP_VERSION, sha256: hash.digest('hex'), bytes }
}

export function createRunnerBuildRoutes(path: string | null) {
    const app = new Hono<WebAppEnv>()
    let description: ReturnType<typeof describeBinary> | undefined

    function describe(path: string) {
        description ??= describeBinary(path).catch((error) => {
            description = undefined
            throw error
        })
        return description
    }

    app.get('/runner-builds/linux-x64', async (c) => {
        if (!path) return c.notFound()
        c.header('Cache-Control', 'no-store')
        return c.json(await describe(path))
    })

    app.get('/runner-builds/linux-x64/:sha256', async (c) => {
        if (!path || !/^[a-f0-9]{64}$/.test(c.req.param('sha256'))) return c.notFound()
        const { sha256, bytes } = await describe(path)
        if (c.req.param('sha256') !== sha256) return c.notFound()

        return new Response(Bun.file(path), {
            headers: {
                'Cache-Control': 'private, no-store',
                'Content-Disposition': 'attachment; filename="hapi-linux-x64"',
                'Content-Length': String(bytes),
                'Content-Type': 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff'
            }
        })
    })

    return app
}
