// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateMeasurementLaunch, assertPrivateMeasurementRelease, assertPrivateMeasurementRuntime,
  assertPrivateMeasurementMarker, privateMeasurementHandshake } from '../private_measurement.mjs'

const flag = '--private-test-resource-measurement'
const profile = resolve(tmpdir(), 'isolated-measurement-profile')
const identity = { appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', pythonVersion: '3.12.14', platform: 'linux', arch: 'x64', runtimeId: 'a'.repeat(64) }
const launch = () => ({ origin: 'http://127.0.0.1:12345', password: 'p'.repeat(32), nonce: 'n'.repeat(32), controlToken: 't'.repeat(48), identity,
  resourceMeasurement: { mode: 'private-test', qualified: false, recommendationsEnabled: false } })
function runtime() {
  const models = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']
  const capabilities = ['transcription', 'separation']
  return [{ id: 'a'.repeat(64), manifest: { schema: 2, capabilities, models } },
    { id: 'b'.repeat(64), manifest: { models } },
    { runtimeManifestId: 'a'.repeat(64), probePassed: true, capabilitiesReady: true, probeSchema: 2,
      verifiedCapabilities: capabilities, checks: { deviceTensor: true, nativeAudio: true, transcription: true, separation: true } }]
}

test('private measurement explicitly selects its absolute packaged profile', () => {
  assert.deepEqual(privateMeasurementLaunch(['app'], true), { enabled: false, profile: null })
  assert.deepEqual(privateMeasurementLaunch(['app', flag, `--user-data-dir=${profile}`], true), { enabled: true, profile })
  assert.deepEqual(privateMeasurementLaunch(['app', flag, '--user-data-dir', profile], true), { enabled: true, profile })
  for (const args of [[flag], [flag, '--user-data-dir=relative'], [flag, `--user-data-dir=${profile}`, '--demo'],
    [flag, `--user-data-dir=${profile}`, '--recovery-anchor'], [flag, flag, `--user-data-dir=${profile}`],
    [flag, `--user-data-dir=${profile}`, `--user-data-dir=${profile}`]]) assert.throws(() => privateMeasurementLaunch(args, true))
  assert.throws(() => privateMeasurementLaunch([flag, `--user-data-dir=${profile}`], false), /packaged/)
})

test('the measurement exception is private-test only and requires already verified inputs', () => {
  assertPrivateMeasurementRelease(true, true, { channel: 'private-test' })
  assertPrivateMeasurementRuntime(true, ...runtime())
  assertPrivateMeasurementRelease(false, false, null)
  assertPrivateMeasurementRuntime(false, null, null, null)
  for (const [packaged, policy] of [[false, { channel: 'private-test' }], [true, { channel: 'stable' }], [true, null]]) {
    assert.throws(() => assertPrivateMeasurementRelease(true, packaged, policy), /private-test/)
  }
  for (const mutate of [values => { values[0].manifest.schema = 1 }, values => { values[1].manifest.models = [] },
    values => { values[2].checks.nativeAudio = false }, values => { values[2].capabilitiesReady = false },
    values => { values[2].runtimeManifestId = 'c'.repeat(64) }, values => { values[0].id = 'short' }]) {
    const values = structuredClone(runtime()); mutate(values)
    assert.throws(() => assertPrivateMeasurementRuntime(true, ...values), /already verified/)
  }
})

test('both handshake and readiness require the exact unqualified marker', () => {
  assert.equal(privateMeasurementHandshake(JSON.stringify(launch()), identity, true).origin, launch().origin)
  assertPrivateMeasurementMarker(launch(), true)
  for (const marker of [undefined, {}, { mode: 'private-test', qualified: true, recommendationsEnabled: false },
    { mode: 'private-test', qualified: false, recommendationsEnabled: true },
    { mode: 'private-test', qualified: false, recommendationsEnabled: false, inventedThreshold: 1 }]) {
    const value = { ...launch(), resourceMeasurement: marker }
    assert.throws(() => privateMeasurementHandshake(JSON.stringify(value), identity, true), /marker mismatch/)
    assert.throws(() => assertPrivateMeasurementMarker(value, true), /marker mismatch/)
  }
  const ordinary = launch(); delete ordinary.resourceMeasurement
  assert.equal(privateMeasurementHandshake(JSON.stringify(ordinary), identity, false).origin, ordinary.origin)
  const foreign = { ...launch(), origin: 'http://example.org:12345' }
  assert.throws(() => privateMeasurementHandshake(JSON.stringify(foreign), identity, true), /invalid launch/)
})

test('the packaged Electron application includes its measurement admission helper', async t => {
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const native = await mkdtemp(join(tmpdir(), 'measurement-installer-'))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  const previousPolicy = process.env.SINGHOUSE_RELEASE_POLICY
  t.after(async () => {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD; else process.env.KARAOKE_NATIVE_PAYLOAD = previous
    if (previousPolicy === undefined) delete process.env.SINGHOUSE_RELEASE_POLICY; else process.env.SINGHOUSE_RELEASE_POLICY = previousPolicy
    await rm(native, { recursive: true, force: true })
  })
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  process.env.SINGHOUSE_RELEASE_POLICY = join(desktop, 'release.json')
  const pkg = JSON.parse(await readFile(join(desktop, 'package.json')))
  await writeFile(join(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
  await writeFile(join(native, 'files.json'), '{}\n')
  await writeFile(join(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core', payloadDigest: 'a'.repeat(64) }))
  await writeFile(join(native, 'backend.py'), '# fixture\n')
  for (const policy of ['models.json', 'processing-locks.json', 'hardware-policy.json']) await writeFile(join(native, policy), await readFile(join(desktop, policy)))
  const { default: config } = await import(`../build/installer.mjs?measurement=${Date.now()}`)
  assert.ok(config.files.includes('main.mjs'))
  assert.ok(config.files.includes('private_measurement.mjs'))
  assert.ok(config.files.includes('policy.mjs'))
})
