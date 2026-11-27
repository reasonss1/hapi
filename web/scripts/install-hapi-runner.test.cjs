const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../public/install-hapi-runner.cjs'), 'utf8')
const hub = 'https://hub.example.test'

async function setup(t, { running = true, roots = ['/old'], installed = true, saved = true } = {}) {
    const home = await fs.mkdtemp(join(tmpdir(), 'hapi-enroll-test-'))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const cwd = join(home, 'new project')
    await fs.mkdir(cwd)
    const settings = saved ? { apiUrl: hub, cliApiToken: 'saved-token', machineId: 'machine' } : {}
    await fs.writeFile(join(home, 'settings.json'), JSON.stringify(settings))
    const calls = []
    const state = {
        pid: 123, startedWithApiUrl: hub, startedWithMachineId: 'machine',
        startedWithArgv: ['runner', 'start-sync', ...roots.flatMap(root => ['--workspace-root', root])],
    }
    const sandbox = vm.createContext({
        require, console: { log() {}, error() {} }, URL, AbortSignal, fetch: async (url, options) => {
            calls.push(['request', url])
            if (url.endsWith('/api/machines?includeOffline=true')) return { ok: true, json: async () => ({ machines: [{ id: 'machine', metadata: { workspaceRoots: roots } }] }) }
            if (url.endsWith('/api/auth')) return { ok: true, json: async () => ({ token: 'jwt' }) }
            if (url.endsWith('/api/runner-enrollment/redeem')) return { ok: true, json: async () => ({ accessToken: 'saved-token' }) }
            throw new Error('Unexpected request: ' + url)
        },
        process: { platform: 'linux', arch: 'x64', versions: { node: '22.0.0' }, argv: ['node', 'installer', hub, 'expired-code'],
            env: { HAPI_HOME: home }, cwd: () => cwd, stdin: { isTTY: false } },
        setInterval, clearInterval, calls, state, roots, installed, isRunning: running,
    })
    vm.runInContext(source.slice(0, source.lastIndexOf('\nmain().catch')), sandbox)
    vm.runInContext(`
        globalThis.verifyStart = startAndVerify;
        globalThis.findExecutable = restartableExecutable;
        runningRunner = async () => isRunning ? state : null;
        onlineMachine = async () => ({ metadata: { workspaceRoots: roots } });
        restartableExecutable = async () => '/existing/hapi';
        installedRunner = async () => installed ? '/existing/hapi' : null;
        hubHealth = async () => { calls.push(['health']); return { appVersion: '0.36.5' }; };
        installNpmRunner = async () => { calls.push(['install']); return '/new/hapi'; };
        stopManagedRunner = async () => { calls.push(['stop']); isRunning = false; };
        startAndVerify = async (runner, context, flags) => { calls.push(['start', runner, flags]); isRunning = true; };
        globalThis.api = { main, workspaceFlags, authenticate, addWorkspaceToRunner };
    `, sandbox)
    return { home, cwd, calls, api: sandbox.api, sandbox }
}

test('first install passes the actual working directory to Runner and persists it', async t => {
    const h = await setup(t, { running: false, installed: false, saved: false, roots: [] })
    await h.api.main()
    assert.equal(h.calls.filter(c => c[0] === 'install').length, 1)
    const start = h.calls.find(c => c[0] === 'start')
    assert.deepEqual(Array.from(start[2]), ['--workspace-root', h.cwd])
    assert.deepEqual(JSON.parse(await fs.readFile(join(h.home, 'runner-enrollment.json'))).flags, ['--workspace-root', h.cwd])
})

test('existing device adds a directory with the same executable, without build/version requests', async t => {
    const h = await setup(t)
    await h.api.main()
    assert.deepEqual(h.calls.filter(c => c[0] !== 'request').map(c => c[0]), ['stop', 'start'])
    const start = h.calls.find(c => c[0] === 'start')
    assert.equal(start[1], '/existing/hapi')
    assert.deepEqual(Array.from(start[2]), ['--workspace-root', '/old', '--workspace-root', h.cwd])
    assert.deepEqual(h.calls.filter(c => c[0] === 'request').map(c => c[1]), [hub + '/api/auth'])
})

test('same directory (including symlink alias) does not restart or install', async t => {
    const h = await setup(t)
    const alias = join(h.home, 'alias')
    await fs.symlink(h.cwd, alias)
    h.sandbox.roots.push(alias)
    await h.api.main()
    await h.api.main()
    assert.ok(h.calls.every(c => c[0] === 'request'))
})

test('stopped installed device preserves saved directories without downloading a newer build', async t => {
    const h = await setup(t, { running: false })
    await fs.writeFile(join(h.home, 'runner-enrollment.json'), JSON.stringify({ flags: ['--workspace-root=/old'] }))
    await h.api.main()
    const actions = h.calls.filter(c => c[0] !== 'request')
    assert.equal(actions.length, 1)
    assert.equal(actions[0][0], 'start')
    assert.deepEqual(Array.from(actions[0][2]), ['--workspace-root=/old', '--workspace-root', h.cwd])
})

test('failed restart restores previous start flags', async t => {
    const h = await setup(t)
    vm.runInContext(`startAndVerify = async (runner, context, flags) => {
        calls.push(['start', runner, flags]);
        if (calls.filter(c => c[0] === 'start').length === 1) throw new Error('offline');
    }`, h.sandbox)
    await assert.rejects(h.api.main(), /previous Runner was restored/)
    assert.deepEqual(Array.from(h.calls.filter(c => c[0] === 'start')[1][2]), ['--workspace-root', '/old'])
    await assert.rejects(fs.access(join(h.home, 'runner-enrollment.json')))
})

test('another Hub is rejected before authentication, installation or stop', async t => {
    const h = await setup(t)
    await fs.writeFile(join(h.home, 'settings.json'), JSON.stringify({ apiUrl: 'https://other.example.test' }))
    await assert.rejects(h.api.main(), /another Hub/)
    assert.equal(h.calls.length, 0)
})

test('unmanaged Runner fails without installing or stopping it', async t => {
    const h = await setup(t)
    vm.runInContext('restartableExecutable = async () => null', h.sandbox)
    await assert.rejects(h.api.main(), /supervised|restarted safely/)
    assert.ok(h.calls.every(c => c[0] === 'request'))
})

test('invalid saved credentials fall back to a fresh pairing code', async t => {
    const h = await setup(t)
    vm.runInContext(`let authCalls = 0; request = async (hub, path) => {
        calls.push([path]);
        if (path === '/api/auth' && authCalls++ === 0) throw new Error('expired');
        return path.endsWith('/redeem') ? { accessToken: 'new-token' } : { token: 'jwt' };
    }`, h.sandbox)
    const result = await h.api.authenticate(hub, 'new-code', 'old-token')
    assert.equal(result.accessToken, 'new-token')
    assert.deepEqual(h.calls.map(c => c[0]), ['/api/auth', '/api/runner-enrollment/redeem', '/api/auth'])
})


test('stopped legacy install recovers old workspace roots from Hub metadata', async t => {
    const h = await setup(t, { running: false })
    await h.api.main()
    const start = h.calls.find(c => c[0] === 'start')
    assert.deepEqual(Array.from(start[2]), ['--workspace-root', '/old', '--workspace-root', h.cwd])
})

test('start verification waits for workspace metadata before reporting success', async t => {
    const h = await setup(t)
    vm.runInContext(`
        let checks = 0;
        runningRunner = async () => checks++ === 0 ? null : state;
        run = async () => {};
        onlineMachine = async () => ({ metadata: { workspaceRoots: ['/new'] } });
    `, h.sandbox)
    await h.sandbox.verifyStart('/existing/hapi', {
        hapiHome: h.home, settingsPath: join(h.home, 'settings.json'), hub, jwt: 'jwt', env: {},
    }, ['--workspace-root', '/new'])
})


test('global/manual installation works when runner-cli directory does not exist', async t => {
    const h = await setup(t)
    const binary = join(h.home, 'global', 'hapi')
    await fs.mkdir(join(h.home, 'global'))
    await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    h.sandbox.binary = binary
    vm.runInContext('runnerExecutable = async () => binary; restartableExecutable = findExecutable', h.sandbox)
    await h.api.main()
    assert.equal(h.calls.find(call => call[0] === 'start')[1], binary)
    assert.equal(h.calls.some(call => call[0] === 'install'), false)
    await assert.rejects(fs.access(join(h.home, 'runner-cli')))
})

test('setup failure after code redemption can retry with the same consumed code', async t => {
    const h = await setup(t, { running: false, installed: false, saved: false })
    vm.runInContext(`installNpmRunner = async () => { throw new Error('download interrupted'); }`, h.sandbox)
    await assert.rejects(h.api.main(), /download interrupted/)
    const credentials = JSON.parse(await fs.readFile(join(h.home, 'runner-enrollment-auth.json')))
    assert.equal(credentials.hub, hub)
    assert.equal(credentials.accessToken, 'saved-token')
    assert.equal((await fs.stat(join(h.home, 'runner-enrollment-auth.json'))).mode & 0o777, 0o600)
    vm.runInContext(`installNpmRunner = async () => '/new/hapi';`, h.sandbox)
    await h.api.main()
    assert.equal(h.calls.filter(call => call[0] === 'request' && call[1].endsWith('/redeem')).length, 1)
})

test('supervised Runner is never stopped by the installer', async t => {
    const h = await setup(t)
    vm.runInContext('onlineMachine = async () => ({ metadata: { supervisedRestart: true } })', h.sandbox)
    await assert.rejects(h.api.main(), /supervised/)
    assert.ok(h.calls.every(call => call[0] === 'request'))
})
