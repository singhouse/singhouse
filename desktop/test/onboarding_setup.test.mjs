// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { OnboardingSetup, LOCAL_MODEL_IDS } from '../onboarding_setup.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(overrides = {}) {
  const calls = [], saved = []
  const manifest = { schema: 1, kind: 'processing', platform: 'linux', arch: 'x64', accelerator: 'cpu',
    python: 'python', pythonVersion: '3', backendVersion: '1', lyricsyncVersion: '1',
    probe: { schema: 2, modules: ['module'] }, capabilities: ['transcription', 'separation'],
    models: LOCAL_MODEL_IDS, modelCapabilities: Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, id === 'heart-transcriptor' ? 'transcription' : 'separation'])),
    provenance: { lockSha256: 'locked', packages: [{ name: 'package', license: 'MIT', sourceUrl: 'https://example.org/package' }] },
    files: [{ path: 'python', size: 5, sha256: 'python-hash', url: 'https://example.org/python' }] }
  const policy = { models: LOCAL_MODEL_IDS.map(id => ({ id, files: [{ path: id, size: 10, url: `https://example.org/${id}` }] })) }
  const runtime = { active: async () => runtime.value, validate: value => value,
    install: async value => { calls.push('runtime'); runtime.value = { id: hash(value), directory: '/runtime', manifest: value } },
    probe: async () => ({ schema: 2, accelerator: 'cpu', components: { module: '1' }, capabilitiesReady: true,
      verifiedCapabilities: manifest.capabilities, capabilities: manifest.capabilities, hardwareAvailable: true,
      pythonVersion: '3', backendVersion: '1', lyricsyncVersion: '1', checks: { deviceTensor: true, nativeAudio: true, transcription: true, separation: true } }) }
  const cache = { active: async () => cache.value, validate: value => value,
    install: async value => { calls.push('models'); cache.value = { id: hash(value), manifest: value } } }
  const catalog = { schema: 1, runtime: manifest, qualification: { passed: true, runtimeLockSha256: 'locked', platform: 'linux', arch: 'x64', accelerator: 'cpu' },
    models: LOCAL_MODEL_IDS.map(id => ({ id, terms: [{ label: 'Fixture terms', url: 'https://example.org/terms' }] })) }
  const setup = new OnboardingSetup({ runtime, cache, policy, catalog, diskFree: async () => 1e10,
    save: async value => saved.push(value), ...overrides })
  return { setup, runtime, cache, calls, saved, catalog, manifest }
}
async function start(setup, planId) { await setup.start({ consent: true, planId }); await setup.operation; return setup.getStatus() }

test('missing release catalog and qualification fail closed without retrieving any bytes', async () => {
  const { setup, calls } = fixture({ catalog: null })
  assert.match((await setup.preflight()).reason, /authenticated.*catalog/)
  assert.equal((await start(setup)).state, 'error')
  assert.deepEqual(calls, [])
  const second = fixture()
  second.setup.catalog.qualification.passed = false
  assert.match((await second.setup.preflight()).reason, /qualification/)
})
test('preflight covers all components, storage, source and terms before explicit consent', async () => {
  const { setup, calls } = fixture()
  const plan = await setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.components.length, 4)
  assert.equal(plan.components.reduce((sum, item) => sum + item.bytes, 0), 35)
  assert.equal(plan.diskRequiredBytes, 70 + 128 * 1024 * 1024)
  assert.ok(plan.components.every(item => item.sources.length && item.terms.length))
  await setup.start({ planId: plan.planId })
  assert.deepEqual(calls, [])
  assert.equal((await start(setup, 'stale')).state, 'error')
  assert.deepEqual(calls, [])
})
test('low disk and missing weight terms block the complete setup', async () => {
  const { setup } = fixture({ diskFree: async () => 1 })
  assert.equal((await setup.preflight()).available, false)
  const other = fixture()
  other.setup.catalog.models[1].terms = []
  assert.match((await other.setup.preflight()).reason, /terms.*demucs/)
})
test('full setup requires reopening and subsequent verification of current loaded IDs', async () => {
  const { setup, calls, runtime, cache, saved } = fixture()
  const plan = await setup.preflight()
  assert.equal((await start(setup, plan.planId)).state, 'restart-required')
  assert.deepEqual(calls, ['runtime', 'models'])
  assert.equal(saved.at(-1).state, 'restart-required')
  assert.equal((await setup.preflight()).ready, false)
  setup.loaded = { runtimeId: runtime.value.id, modelsId: cache.value.id }
  assert.equal((await setup.preflight()).ready, true)
  assert.equal((await start(setup, (await setup.preflight()).planId)).state, 'ready')
  assert.deepEqual(calls, ['runtime', 'models'])
})
test('interruption resumes after complete runtime without retrieving it again', async () => {
  const { setup, calls, cache } = fixture()
  const install = cache.install
  cache.install = async () => { throw new Error('connection lost') }
  assert.equal((await start(setup, (await setup.preflight()).planId)).state, 'error')
  cache.install = install
  assert.equal((await start(setup, (await setup.preflight()).planId)).state, 'restart-required')
  assert.deepEqual(calls, ['runtime', 'models'])
})
test('cancellation and concurrent clicks retain one operation and a retryable checkpoint', async () => {
  const { setup, runtime } = fixture()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  runtime.install = async (_, { signal }) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }
  const plan = await setup.preflight()
  await setup.start({ consent: true, planId: plan.planId })
  const operation = setup.operation
  await setup.start({ consent: true, planId: plan.planId })
  assert.equal(setup.operation, operation)
  await started
  setup.cancel()
  await operation
  assert.equal((await setup.getStatus()).state, 'cancelled')
  assert.equal((await setup.getStatus()).retryable, true)
})
test('saved ready claims do not bypass verification and Heart alone never satisfies full readiness', async () => {
  const { setup, cache } = fixture({ load: async () => ({ state: 'ready', runtime: 'forged' }) })
  cache.value = { id: 'heart', manifest: { models: ['heart-transcriptor'] } }
  assert.equal((await setup.preflight()).ready, false)
  assert.equal((await setup.getStatus()).state, 'idle')
  const interrupted = fixture({ load: async () => ({ state: 'running' }) })
  assert.equal((await interrupted.setup.getStatus()).state, 'cancelled')
})

test('cancelling final functional verification aborts its probe and cannot report success', async () => {
  const { setup, runtime, saved } = fixture()
  let entered, probeAborted = false
  const started = new Promise(resolve => { entered = resolve })
  runtime.probe = async (_, { signal }) => {
    assert.ok(signal instanceof AbortSignal)
    entered()
    await new Promise((_, reject) => signal.addEventListener('abort', () => {
      probeAborted = true
      reject(new Error('probe aborted'))
    }, { once: true }))
  }
  const plan = await setup.preflight()
  await setup.start({ consent: true, planId: plan.planId })
  const operation = setup.operation
  await started
  setup.cancel()
  await operation
  assert.equal(probeAborted, true)
  assert.equal((await setup.getStatus()).state, 'cancelled')
  assert.equal(saved.some(value => ['ready', 'restart-required'].includes(value.state)), false)
})

test('cancellation remains authoritative when a final probe resolves after abort', async () => {
  const { setup, runtime } = fixture()
  const probe = runtime.probe
  runtime.probe = async (...args) => { setup.cancel(); return probe(...args) }
  const plan = await setup.preflight()
  assert.equal((await start(setup, plan.planId)).state, 'cancelled')
})
