import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const legacyVersion = '0.36.5'
const internalPrefix = 'internal-v'

function components(version) {
    if (!versionPattern.test(version)) throw new Error(`Invalid HAPI version: ${version}`)
    return version.split('.').map(BigInt)
}

function isNewer(candidate, previous) {
    const before = components(previous)
    for (let index = 0; index < candidate.length; index++) {
        if (candidate[index] !== before[index]) return candidate[index] > before[index]
    }
    return false
}

try {
    const [tag, ...deployedVersions] = process.argv.slice(2)
    if (!tag?.startsWith(internalPrefix)) {
        throw new Error('Usage: check-internal-release-version.mjs internal-vMAJOR.MINOR.PATCH [deployed-version ...]')
    }
    const version = tag.slice(internalPrefix.length)
    const candidate = components(version)
    const cli = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8')).version
    const shared = readFileSync(new URL('../shared/src/buildInfo.ts', import.meta.url), 'utf8')
        .match(/^export const APP_VERSION = ['"]([^'"]+)['"]/m)?.[1]
    if (cli !== version || shared !== version) {
        throw new Error(`${tag} requires CLI and shared versions ${version}; found ${cli} and ${shared ?? 'missing'}.`)
    }

    const otherTags = execFileSync('git', ['tag', '--list', 'internal-v*'], { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(existing => existing && existing !== tag)
        .map(existing => existing.slice(internalPrefix.length))
        .filter(version => versionPattern.test(version))
    for (const previous of [legacyVersion, ...otherTags, ...deployedVersions]) {
        if (!isNewer(candidate, previous)) {
            throw new Error(`HAPI ${version} must be newer than ${previous}. Increment the release version.`)
        }
    }
    console.log(`Verified HAPI release version ${version}.`)
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
