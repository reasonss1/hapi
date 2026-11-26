const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const fs = require('node:fs/promises')
const { homedir } = require('node:os')
const { basename, dirname, join, relative, resolve } = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { setTimeout: delay } = require('node:timers/promises')

const npmRegistry = 'https://registry.npmjs.org'
const lockStaleMs = 30_000
const customBuildPath = '/api/runner-builds/linux-x64'
const updateCapability = 'agent-tool-updates'

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

async function onlineMachine(hub, jwt, machineId, runnerPid) {
    if (typeof machineId !== 'string' || !machineId || !Number.isSafeInteger(runnerPid)) return null
    try {
        const { machines } = await request(hub, '/api/machines', undefined, jwt)
        return machines.find((machine) => machine.id === machineId && machine.active &&
            machine.runnerState?.status === 'running' && machine.runnerState.pid === runnerPid) ?? null
    } catch {
        return null
    }
}

function supportsAgentUpdates(machine) {
    return machine?.metadata?.capabilities?.includes(updateCapability) === true
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

async function hubHealth(hub) {
    let health
    try {
        health = await request(hub, '/health')
    } catch {
        throw new Error('Could not reach the HAPI Hub. Check the Hub address and your network connection.')
    }
    if (typeof health.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(health.appVersion)) {
        throw new Error('This Hub does not advertise a supported HAPI CLI version.')
    }
    return health
}

async function installNpmRunner(prefix, version, env) {
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

async function matchesBuild(runner, build) {
    try {
        if ((await fs.stat(runner)).size !== build.bytes) return false
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(runner)) hash.update(chunk)
        return hash.digest('hex') === build.sha256
    } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

async function installCustomRunner(prefix, hub, jwt, version) {
    const build = await request(hub, customBuildPath, undefined, jwt)
    if (build.version !== version || typeof build.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(build.sha256) ||
        !Number.isSafeInteger(build.bytes) || build.bytes <= 0 || build.bytes > 1024 ** 3) {
        throw new Error('The Hub returned an invalid custom Runner build.')
    }

    const directory = join(prefix, 'builds', build.sha256)
    const runner = join(directory, 'hapi')
    if (await matchesBuild(runner, build)) return runner
    await fs.mkdir(directory, { mode: 0o700, recursive: true })

    console.log('Downloading the Hub’s custom HAPI Runner ' + version + '…')
    const download = await fetch(hub + customBuildPath + '/' + build.sha256, {
        headers: { Authorization: 'Bearer ' + jwt },
        redirect: 'error',
        signal: AbortSignal.timeout(15 * 60_000)
    })
    if (!download.ok || !download.body) throw new Error('Could not download the custom Runner (HTTP ' + download.status + ').')

    const hash = createHash('sha256')
    let bytes = 0
    const verify = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length
            if (bytes > build.bytes) {
                callback(new Error('The custom Runner download has the wrong size.'))
                return
            }
            hash.update(chunk)
            callback(null, chunk)
        }
    })
    const temporary = join(directory, randomUUID() + '.download')
    try {
        await pipeline(Readable.fromWeb(download.body), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
        if (bytes !== build.bytes || hash.digest('hex') !== build.sha256) {
            throw new Error('The custom Runner download failed verification.')
        }
        await fs.chmod(temporary, 0o755)
        await fs.rename(temporary, runner)
        return runner
    } finally {
        await fs.rm(temporary, { force: true })
    }
}

async function activateCustomRunner(prefix, runner) {
    const directory = join(prefix, 'bin')
    const temp = join(directory, randomUUID() + '.link')
    await fs.mkdir(directory, { mode: 0o700, recursive: true })
    try {
        await fs.symlink(relative(directory, runner), temp)
        await fs.rename(temp, join(directory, 'hapi'))
    } finally {
        await fs.rm(temp, { force: true })
    }
}

async function runnerExecutable(pid) {
    try {
        return await fs.readlink('/proc/' + pid + '/exe')
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
        throw error
    }
}

async function managedExecutable(prefix, state) {
    if (!state?.pid || state.startedWithVersionHandoffDisabled) return null
    const executable = await runnerExecutable(state.pid)
    if (!executable || basename(executable) !== 'hapi') return null
    const path = relative(await fs.realpath(prefix), executable)
    return path.startsWith('lib/node_modules/@twsxtd/') || /^builds\/[a-f0-9]{64}\/hapi$/.test(path) ? executable : null
}

async function stopManagedRunner(hapiHome, state, executable) {
    const current = await runningRunner(hapiHome)
    if (current?.pid !== state.pid || await runnerExecutable(state.pid) !== executable ||
        !Number.isInteger(state.httpPort) || state.httpPort < 1 || state.httpPort > 65535) {
        throw new Error('The active Runner changed during setup. Copy a fresh command and retry.')
    }
    const response = await fetch('http://127.0.0.1:' + state.httpPort + '/stop', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000)
    })
    if (!response.ok || (await response.json()).status !== 'stopping') {
        throw new Error('The old Runner declined a graceful stop.')
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (!await runningRunner(hapiHome)) return
        await delay(200)
    }
    throw new Error('The old Runner did not stop gracefully. Setup did not force it to stop.')
}

async function startAndVerify(runner, context, flags = [], custom = false) {
    const { hapiHome, hub, jwt, env, settingsPath } = context
    if (await runningRunner(hapiHome)) throw new Error('Another Runner started while setup was in progress.')
    await run(runner, ['runner', 'start', ...flags], env, 20_000)

    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
        const started = await runningRunner(hapiHome)
        const { machineId } = await readSettings(settingsPath)
        const machine = await onlineMachine(hub, jwt, machineId, started?.pid)
        if (machine && (!custom || supportsAgentUpdates(machine))) return
        await delay(1000)
    }
    throw new Error('The Runner did not register with the expected capabilities. Check ' + join(hapiHome, 'logs') + ' for details.')
}

async function replaceManagedRunner(runner, previous, state, context, activate) {
    const args = state.startedWithArgv
    if (!Array.isArray(args) || args[0] !== 'runner' || args[1] !== 'start-sync') {
        throw new Error('Could not preserve the existing Runner’s start options.')
    }
    const flags = args.slice(2)
    const { hapiHome, settingsPath, accessToken } = context
    const settings = await readSettings(settingsPath)
    if (settings.machineId !== state.startedWithMachineId || typeof settings.cliApiToken !== 'string' ||
        settings.cliApiToken.replace(/:default$/, '') !== accessToken.replace(/:default$/, '')) {
        throw new Error('The active Runner’s saved Hub credentials differ from this setup command.')
    }

    console.log('Switching the existing Runner to the custom build…')
    await stopManagedRunner(hapiHome, state, previous)
    try {
        await startAndVerify(runner, context, flags, true)
        await activate()
    } catch (error) {
        try {
            const replacement = await runningRunner(hapiHome)
            if (replacement && await runnerExecutable(replacement.pid) === runner) {
                await stopManagedRunner(hapiHome, replacement, runner)
            }
            await startAndVerify(previous, context, flags)
        } catch {
            throw new Error(error.message + ' The previous Runner could not be restarted automatically.')
        }
        throw new Error(error.message + ' The previous Runner was restored.')
    }
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
    delete env.HAPI_CLI_EXECUTABLE
    delete env.HAPI_RUNNER_HANDOFF_FROM_PID

    const settingsPath = join(hapiHome, 'settings.json')
    const prefix = join(hapiHome, 'runner-cli')
    checkExistingHub(await readSettings(settingsPath), hub)
    await fs.mkdir(hapiHome, { recursive: true, mode: 0o700 })
    await exclusive(join(hapiHome, 'runner-enrollment.lock'), async () => {
        const settings = await readSettings(settingsPath)
        checkExistingHub(settings, hub)
        const running = await runningRunner(hapiHome)
        if (running?.startedWithApiUrl && running.startedWithApiUrl !== hub) {
            throw new Error('A HAPI runner is already active for another Hub. Use a separate HAPI_HOME to add this device.')
        }
        const { accessToken, jwt } = await authenticate(hub, code)
        const context = { hapiHome, hub, jwt, env, settingsPath, accessToken }
        const { appVersion, capabilities } = await hubHealth(hub)
        const custom = capabilities?.customLinuxX64Runner === true && process.platform === 'linux' &&
            process.arch === 'x64' && Boolean(process.report?.getReport().header.glibcVersionRuntime)

        if (running) {
            const machine = await onlineMachine(hub, jwt, running.startedWithMachineId ?? settings.machineId, running.pid)
            if (!machine) throw new Error('A HAPI Runner is already active in this profile. Check its Hub before retrying.')
            if (!custom || supportsAgentUpdates(machine)) {
                console.log('This HAPI device is already online.')
                return
            }
            const previous = await managedExecutable(prefix, running)
            if (!previous) {
                throw new Error('An unmanaged HAPI Runner is active. Stop it normally before installing the custom build.')
            }
            const runner = await installCustomRunner(prefix, hub, jwt, appVersion)
            await replaceManagedRunner(runner, previous, running, context, () => activateCustomRunner(prefix, runner))
        } else {
            const runner = custom
                ? await installCustomRunner(prefix, hub, jwt, appVersion)
                : await installNpmRunner(prefix, appVersion, env)
            await saveSettings(hapiHome, settingsPath, hub, accessToken)
            await startAndVerify(runner, context, [], custom)
            if (custom) await activateCustomRunner(prefix, runner)
        }

        console.log('HAPI device connected. It is now online in the Devices page.')
        if (custom) console.log('Remote Agent updates are available on this device.')
        console.log('HAPI CLI: ' + join(prefix, 'bin', 'hapi'))
    })
}

main().catch((error) => {
    console.error(`HAPI setup failed: ${error.message}`)
    process.exitCode = 1
})
