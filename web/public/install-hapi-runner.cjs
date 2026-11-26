const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const npmRegistry = 'https://registry.npmjs.org'
const lockStaleMs = 30_000

function hubOrigin(value) {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Use the HTTPS address of your HAPI Hub.')
    }
    return url.origin
}

async function readOptionalFile(path) {
    try {
        return await fs.readFile(path, 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

async function readSettings(path) {
    const contents = await readOptionalFile(path)
    if (contents === null) return {}
    try {
        const settings = JSON.parse(contents)
        if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings
    } catch {
        // Keep malformed settings available for the user to fix.
    }
    throw new Error(`Invalid HAPI settings file: ${path}`)
}

function namespaceForToken(token) {
    const value = token.trim()
    const separator = value.lastIndexOf(':')
    return separator === -1 ? 'default' : value.slice(separator + 1)
}

function checkExistingHub(settings, hub, accessToken) {
    const configuredHub = settings.apiUrl || settings.serverUrl
    if ((configuredHub && String(configuredHub).replace(/\/+$/, '') !== hub) ||
        (accessToken && settings.cliApiToken && settings.cliApiToken !== accessToken &&
            (settings.listenHost || settings.listenPort || settings.publicUrl))) {
        throw new Error('This HAPI profile is configured for another Hub. Use a separate HAPI_HOME to add this device.')
    }
    if (accessToken && settings.machineId && typeof settings.cliApiToken === 'string' &&
        namespaceForToken(settings.cliApiToken) !== namespaceForToken(accessToken)) {
        throw new Error('This HAPI profile is registered to a different namespace. Use a separate HAPI_HOME to add this device.')
    }
}

async function runningRunner(hapiHome) {
    const lock = await readOptionalFile(join(hapiHome, 'runner.state.json.lock'))
    let state
    try {
        state = JSON.parse(await readOptionalFile(join(hapiHome, 'runner.state.json')))
    } catch {
        // The lock still protects a starting runner while it writes its state.
    }
    for (const pid of [Number(lock), state?.pid]) {
        if (!Number.isSafeInteger(pid) || pid < 1) continue
        try {
            process.kill(pid, 0)
            return state ?? {}
        } catch (error) {
            if (error.code !== 'ESRCH') return state ?? {}
        }
    }
    return null
}

async function exclusive(path, work) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.mkdir(path, { mode: 0o700 })
            break
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
            try {
                const stat = await fs.stat(path)
                if (Date.now() - stat.mtimeMs > lockStaleMs) {
                    await fs.rmdir(path)
                    continue
                }
            } catch (statError) {
                if (statError.code === 'ENOENT') continue
                throw statError
            }
            if (attempt === 50) throw new Error('HAPI settings are busy. Close the other setup process and try again.')
            await delay(100)
        }
    }
    const keepLock = setInterval(() => {
        const now = new Date()
        void fs.utimes(path, now, now).catch(() => {})
    }, 10_000)
    try {
        return await work()
    } finally {
        clearInterval(keepLock)
        await fs.rmdir(path)
    }
}

async function saveSettings(hapiHome, path, hub, accessToken) {
    await exclusive(`${path}.hapi.lock`, async () => {
        const settings = await readSettings(path)
        checkExistingHub(settings, hub, accessToken)
        if (await runningRunner(hapiHome)) {
            throw new Error('A HAPI runner started while setup was in progress. Check the device from the Hub before retrying.')
        }
        const temp = `${path}.${randomUUID()}.tmp`
        try {
            await fs.writeFile(temp, JSON.stringify({ ...settings, apiUrl: hub, cliApiToken: accessToken }, null, 2) + '\n', {
                flag: 'wx',
                mode: 0o600
            })
            await fs.rename(temp, path)
        } finally {
            await fs.rm(temp, { force: true })
        }
    })
}

function readAccessToken() {
    const input = process.stdin
    if (!input.isTTY) throw new Error('Run this command in a terminal to enter the Hub access token.')
    return new Promise((onToken, onError) => {
        const previousRawMode = input.isRaw
        const characters = []
        function finish(error) {
            input.off('data', onData)
            input.setRawMode(previousRawMode)
            input.pause()
            process.stderr.write('\n')
            if (error) onError(error)
            else onToken(characters.join('').trim())
        }
        function onData(data) {
            for (const character of data) {
                if (character === '\r' || character === '\n') return finish()
                if (character === '\x03' || character === '\x04') return finish(new Error('Setup cancelled.'))
                if (character === '\x7f' || character === '\b') characters.pop()
                else if (character >= ' ') characters.push(character)
            }
        }
        input.setEncoding('utf8')
        input.setRawMode(true)
        process.stderr.write('HAPI Hub access token (hidden): ')
        input.on('data', onData)
        input.resume()
    })
}

async function request(hub, path, body, jwt) {
    const response = await fetch(hub + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body !== undefined
            ? { 'Content-Type': 'application/json' }
            : jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
}

async function authenticate(hub, code) {
    let accessToken
    if (code) {
        try {
            accessToken = (await request(hub, '/api/runner-enrollment/redeem', { code })).accessToken
        } catch {
            throw new Error('Pairing code could not be used. Copy a new command from the HAPI Devices page and try again.')
        }
    } else {
        accessToken = await readAccessToken()
    }
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('No HAPI Hub access token was provided.')
    try {
        const { token: jwt } = await request(hub, '/api/auth', { accessToken })
        if (typeof jwt === 'string' && jwt) return { accessToken, jwt }
    } catch {
        // Never include credentials or server response bodies in error output.
    }
    throw new Error('Could not sign in to the HAPI Hub. Check the Hub address and access token.')
}

async function machineIsOnline(hub, jwt, machineId, runnerPid) {
    if (typeof machineId !== 'string' || !machineId) return false
    try {
        const { machines } = await request(hub, '/api/machines', undefined, jwt)
        return machines.some((machine) => machine.id === machineId && machine.active &&
            machine.runnerState?.status === 'running' && (!runnerPid || machine.runnerState.pid === runnerPid))
    } catch {
        return false
    }
}

function run(command, args, env, timeout) {
    return new Promise((success, failure) => {
        const process = spawn(command, args, { env, stdio: 'inherit', timeout })
        process.once('error', failure)
        process.once('exit', (status, signal) => {
            if (status === 0) success()
            else failure(new Error(`${command} exited with ${signal || `status ${status}`}.`))
        })
    })
}

async function installRunner(hapiHome, hub, env) {
    let version
    try {
        const health = await request(hub, '/health')
        version = health.appVersion
    } catch {
        throw new Error('Could not reach the HAPI Hub. Check the Hub address and your network connection.')
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error('This Hub does not advertise a supported HAPI CLI version.')
    }

    const prefix = join(hapiHome, 'runner-cli')
    const runner = join(prefix, 'bin', 'hapi')
    const installedPackage = join(prefix, 'lib', 'node_modules', '@twsxtd', 'hapi', 'package.json')
    try {
        await fs.access(runner)
        const info = JSON.parse(await fs.readFile(installedPackage, 'utf8'))
        if (info.version === version) return runner
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    console.log(`Installing HAPI CLI ${version}…`)
    await run('npm', [
        'install', '--global', '--prefix', prefix, '--registry', npmRegistry, '--no-audit', '--no-fund', `@twsxtd/hapi@${version}`
    ], env, 8 * 60_000)
    return runner
}

async function main() {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Use this command on macOS or Linux.')
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 or newer and npm are required.')
    const [url, code] = process.argv.slice(2)
    if (!url) throw new Error('Provide the HAPI Hub URL. Copy the command from the HAPI Devices page.')
    const hub = hubOrigin(url)
    if (!code && !process.stdin.isTTY) throw new Error('Run this command in a terminal to enter the Hub access token.')
    const hapiHome = resolve(process.env.HAPI_HOME?.replace(/^~/, homedir()) || join(homedir(), '.hapi'))
    const env = { ...process.env, HAPI_HOME: hapiHome }
    delete env.CLI_API_TOKEN
    delete env.HAPI_API_URL

    const settingsPath = join(hapiHome, 'settings.json')
    checkExistingHub(await readSettings(settingsPath), hub)
    await fs.mkdir(hapiHome, { recursive: true, mode: 0o700 })
    await exclusive(join(hapiHome, 'runner-enrollment.lock'), async () => {
        const settings = await readSettings(settingsPath)
        checkExistingHub(settings, hub)
        const running = await runningRunner(hapiHome)
        if (running?.startedWithApiUrl && running.startedWithApiUrl !== hub) {
            throw new Error('A HAPI runner is already active for another Hub. Use a separate HAPI_HOME to add this device.')
        }
        const runner = running ? null : await installRunner(hapiHome, hub, env)
        const { accessToken, jwt } = await authenticate(hub, code)

        if (running) {
            if (await machineIsOnline(hub, jwt, running.startedWithMachineId ?? settings.machineId, running.pid)) {
                console.log('This HAPI device is already online.')
                return
            }
            throw new Error('A HAPI runner is already active in this profile. Use a separate HAPI_HOME to add this device.')
        }

        await saveSettings(hapiHome, settingsPath, hub, accessToken)
        if (await runningRunner(hapiHome)) {
            throw new Error('A HAPI runner has started in this profile. Check the device from the Hub before retrying.')
        }
        await run(runner, ['runner', 'start'], env, 20_000)

        const deadline = Date.now() + 45_000
        while (Date.now() < deadline) {
            const startedRunner = await runningRunner(hapiHome)
            const { machineId } = await readSettings(settingsPath)
            if (startedRunner?.pid && await machineIsOnline(hub, jwt, machineId, startedRunner.pid)) {
                console.log('HAPI device connected. It is now online in the Devices page.')
                console.log(`HAPI CLI: ${runner}`)
                return
            }
            await delay(1000)
        }
        throw new Error(`The runner started but the Hub did not report it online. Check ${join(hapiHome, 'logs')} for details.`)
    })
}

main().catch((error) => {
    console.error(`HAPI setup failed: ${error.message}`)
    process.exitCode = 1
})
