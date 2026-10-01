// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OnboardingSetup, LOCAL_MODEL_IDS } from '../onboarding_setup.mjs'
import { collectHardware } from '../hardware_inventory.mjs'
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
  const catalog = { schema: 1, runtime: manifest, qualification: { passed: true, scope: 'full', runtimeLockSha256: 'locked', platform: 'linux', arch: 'x64', accelerator: 'cpu' },
    models: LOCAL_MODEL_IDS.map(id => ({ id, terms: [{ label: 'Fixture terms', url: 'https://example.org/terms' }] })) }
  const setup = new OnboardingSetup({ runtime, cache, policy, catalog, diskFree: async () => 1e10,
    save: async value => saved.push(value), ...overrides })
  return { setup, runtime, cache, calls, saved, catalog, manifest }
}
async function start(setup, planId) { await setup.start({ consent: true, planId }); await setup.operation; return setup.getStatus() }

test('missing release catalog and qualification fail closed without retrieving any bytes', async () => {
  const { setup, calls } = fixture({ catalog: null })
  assert.match((await setup.preflight()).reason, /Local song processing is not available in this version yet/)
  assert.equal((await start(setup)).state, 'error')
  assert.deepEqual(calls, [])
  const second = fixture()
  second.setup.catalog.qualification.passed = false
  assert.match((await second.setup.preflight()).reason, /processing tools still need to pass the required checks/)
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

test('CUDA device presence alone does not establish dedicated VRAM or override unified memory', async () => {
  const { setup } = fixture()
  measuredMemory(setup, { vram: true, accelerator: 'cuda' })
  for (const extra of [
    { cudaDevices: [{ name: 'NVIDIA GPU', dedicatedMemoryBytes: null }] },
    { cudaDevices: [{ name: 'NVIDIA GPU', dedicatedMemoryBytes: 24 * GiB }], unifiedMemory: true },
  ]) {
    setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: 64 * GiB, ...extra })
    const plan = await setup.preflight()
    assert.equal(plan.available, false)
    assert.equal(plan.memoryQualification.status, 'unknown')
  }
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

async function offlineFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-offline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = fixture()
  for (const model of result.setup.policy.models) {
    const content = Buffer.alloc(10, model.id.length)
    model.files[0].sha256 = createHash('sha256').update(content).digest('hex')
    await writeFile(join(directory, model.id), content)
  }
  result.setup.setOfflineModelsDirectory(directory)
  result.cache.installFromDirectory = async (manifest, selected, options) => {
    assert.equal(selected, directory)
    assert.equal(options.prefix, '')
    assert.ok(options.signal instanceof AbortSignal)
    result.calls.push('offline-models')
    result.cache.value = { id: hash(manifest), manifest }
  }
  return { ...result, directory }
}

test('offline preflight validates real files and discloses runtime transfer without exposing paths', async t => {
  const { setup, calls, directory } = await offlineFixture(t)
  const plan = await setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.modelSource, 'offline')
  assert.equal(plan.runtimeTransferRequired, true)
  assert.equal(plan.components.filter(item => item.sourceMode === 'offline').length, 3)
  assert.equal(JSON.stringify(plan).includes(directory), false)
  assert.equal((await start(setup, plan.planId)).state, 'restart-required')
  assert.deepEqual(calls, ['runtime', 'offline-models'])
  await rm(directory, { recursive: true })
  assert.equal((await setup.preflight()).available, true, 'verified installation does not require source folder')
})

test('offline setup verifies corruption before downloads; preflight rejects missing and linked files', async t => {
  const { setup, directory, calls } = await offlineFixture(t)
  const file = join(directory, LOCAL_MODEL_IDS[0])
  await writeFile(file, Buffer.alloc(10, 99))
  const plan = await setup.preflight()
  assert.equal(plan.available, true, 'chooser checks size, cancellable install checks content')
  assert.match((await start(setup, plan.planId)).message, /checksums/)
  await rm(file)
  assert.equal((await setup.preflight()).available, false)
  await symlink(join(directory, LOCAL_MODEL_IDS[1]), file)
  assert.equal((await setup.preflight()).available, false)
  assert.deepEqual(calls, [])
})

test('changing offline source invalidates consent and errors omit private paths', async t => {
  const { setup, directory, cache, calls } = await offlineFixture(t)
  const plan = await setup.preflight()
  setup.setOfflineModelsDirectory(null)
  assert.equal((await start(setup, plan.planId)).state, 'error')
  assert.deepEqual(calls, [])
  setup.setOfflineModelsDirectory(directory)
  cache.installFromDirectory = async () => { throw new Error(`secret path ${directory}`) }
  const status = await start(setup, (await setup.preflight()).planId)
  assert.equal(status.state, 'error')
  assert.match(status.message, /no model downloads/)
  assert.equal(JSON.stringify(status).includes(directory), false)
  assert.deepEqual(calls, ['runtime'])
})

test('offline setup locks source selection and cancellation reaches folder installer', async t => {
  const { setup, cache } = await offlineFixture(t)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  cache.installFromDirectory = async (_, __, { signal }) => {
    entered()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  await setup.start({ consent: true, planId: (await setup.preflight()).planId })
  const operation = setup.operation
  assert.throws(() => setup.setOfflineModelsDirectory(null), /current setup/)
  await started
  setup.cancel()
  await operation
  assert.equal((await setup.getStatus()).state, 'cancelled')
})

const GiB = 1024 ** 3
function measuredMemory(setup, { vram = false, accelerator = 'cpu' } = {}) {
  const measure = measuredPeakBytes => ({ measuredPeakBytes, evidenceReference: 'measured-fixture',
    representativeHardware: { verified: true, description: 'Test measurement host' } })
  setup.catalog.runtime.accelerator = accelerator
  setup.catalog.qualification.accelerator = accelerator
  setup.catalog.memory = { runtimeLockSha256: 'locked', platform: 'linux', arch: 'x64', accelerator,
    ram: measure(8 * GiB), ...(vram ? { vram: measure(4 * GiB) } : {}) }
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: 16 * GiB,
    availableMemoryBytes: 12 * GiB, unifiedMemory: false })
}

test('RAM requirements derive only from matching measured peak plus 25 percent and block insufficient RAM', async () => {
  const { setup, calls } = fixture()
  measuredMemory(setup)
  let plan = await setup.preflight()
  assert.equal(plan.memoryRequirements.ramBytes, 10 * GiB)
  assert.equal(plan.memoryQualification.status, 'meets-measured-requirements')
  assert.equal(plan.available, true)
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: 9 * GiB })
  plan = await setup.preflight()
  assert.equal(plan.available, false)
  assert.equal(plan.memoryQualification.status, 'insufficient')
  assert.match(plan.reason, /total RAM/)
  assert.equal((await start(setup, plan.planId)).state, 'error')
  assert.deepEqual(calls, [])
})

test('unknown measured RAM or dedicated VRAM fails honest verification', async () => {
  const { setup } = fixture()
  measuredMemory(setup)
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64' })
  assert.match((await setup.preflight()).reason, /Total RAM could not be verified/)
  measuredMemory(setup, { vram: true })
  const plan = await setup.preflight()
  assert.equal(plan.memoryRequirements.dedicatedVideoMemoryBytes, 5 * GiB)
  assert.equal(plan.memoryQualification.status, 'unknown')
  assert.equal(plan.available, false)
  assert.match(plan.reason, /Dedicated video memory could not be verified/)
})

test('VRAM does not sum adapters or count unified RAM as dedicated memory', async () => {
  const { setup } = fixture()
  measuredMemory(setup, { vram: true })
  const hardware = { platform: 'linux', arch: 'x64', totalMemoryBytes: 64 * GiB,
    videoMemoryBytes: 8 * GiB, gpuDevices: [{ dedicatedMemoryBytes: 4 * GiB }, { dedicatedMemoryBytes: 4 * GiB }] }
  setup.hardware = async () => hardware
  assert.equal((await setup.preflight()).memoryQualification.status, 'unknown')
  hardware.gpuDevices[1].dedicatedMemoryBytes = 5 * GiB
  assert.equal((await setup.preflight()).available, false)
  hardware.gpuDevices.shift()
  assert.equal((await setup.preflight()).available, true)
  hardware.unifiedMemory = true
  const plan = await setup.preflight()
  assert.equal(plan.memoryRequirements.unifiedMemory, true)
  assert.equal(plan.available, false)
  assert.match(plan.reason, /Unified system memory/)
})

test('low available RAM warns without blocking installation on sufficient total RAM', async () => {
  const { setup } = fixture()
  measuredMemory(setup)
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: 16 * GiB, availableMemoryBytes: GiB })
  const plan = await setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.memoryQualification.warnings.length, 1)
  assert.match(plan.memoryQualification.warnings[0], /Close other applications/)
})

test('missing evidence stays unknown and mismatched evidence cannot supply a requirement', async () => {
  const { setup } = fixture()
  let plan = await setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.memoryRequirements.ramBytes, null)
  assert.equal(plan.memoryRequirements.evidenceAvailable, false)
  assert.equal(plan.memoryQualification.status, 'unknown')
  measuredMemory(setup)
  setup.catalog.memory.runtimeLockSha256 = 'different'
  plan = await setup.preflight()
  assert.equal(plan.available, false)
  assert.equal(plan.memoryRequirements.ramBytes, null)
  assert.match(plan.reason, /do not match/)
  measuredMemory(setup)
  setup.hardware = async () => ({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 64 * GiB })
  assert.equal((await setup.preflight()).available, false)
})

test('installed playback readiness remains usable while memory qualification is explicit', async () => {
  const { setup, runtime, cache } = fixture()
  await start(setup, (await setup.preflight()).planId)
  setup.loaded = { runtimeId: runtime.value.id, modelsId: cache.value.id }
  measuredMemory(setup)
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: GiB })
  const plan = await setup.preflight()
  assert.equal(plan.ready, true)
  assert.equal(plan.available, true)
  assert.equal(plan.memoryQualification.status, 'insufficient')
})

test('offline installation retains measured memory qualification and blocks before installs', async t => {
  const { setup, calls } = await offlineFixture(t)
  measuredMemory(setup)
  let plan = await setup.preflight()
  assert.equal(plan.modelSource, 'offline')
  assert.equal(plan.available, true)
  setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: GiB })
  plan = await setup.preflight()
  assert.equal(plan.available, false)
  await start(setup, plan.planId)
  assert.deepEqual(calls, [])
})

test('CUDA memory uses its single observed NVIDIA device, never a larger mixed display adapter', async () => {
  const { setup } = fixture()
  measuredMemory(setup, { vram: true, accelerator: 'cuda' })
  const inventory = async output => collectHardware({
    processAdapter: { platform: 'linux', arch: 'x64' },
    osAdapter: { cpus: () => [], totalmem: () => 64 * GiB, freemem: () => 32 * GiB },
    getGPUInfo: async () => ({ gpuDevice: [{ deviceString: 'AMD Display' }, { deviceString: 'NVIDIA GPU' }] }),
    runCommand: async () => output,
  })
  const observed = await inventory('NVIDIA GPU, 4096\n')
  observed.gpuDevices[0].dedicatedMemoryBytes = 24 * GiB
  observed.videoMemoryBytes = 24 * GiB
  setup.hardware = async () => observed
  assert.equal((await setup.preflight()).memoryQualification.status, 'insufficient')
  setup.hardware = async () => inventory('NVIDIA GPU, 8192\n')
  assert.equal((await setup.preflight()).memoryQualification.status, 'meets-measured-requirements')
})

test('CUDA memory stays unknown for missing, generic-only, or ambiguous CUDA device selection', async () => {
  const { setup, calls } = fixture()
  measuredMemory(setup, { vram: true, accelerator: 'cuda' })
  const sufficient = { name: 'NVIDIA GPU', dedicatedMemoryBytes: 24 * GiB }
  for (const cudaDevices of [undefined, [], [sufficient, sufficient],
    [{ name: 'small', dedicatedMemoryBytes: GiB }, sufficient]]) {
    setup.hardware = async () => ({ platform: 'linux', arch: 'x64', totalMemoryBytes: 64 * GiB,
      gpuDevices: [sufficient], videoMemoryBytes: 48 * GiB, cudaDevices })
    const plan = await setup.preflight()
    assert.equal(plan.available, false)
    assert.equal(plan.memoryQualification.status, 'unknown')
    assert.match(plan.reason, /unambiguous CUDA device/)
    assert.equal((await start(setup, plan.planId)).state, 'error')
  }
  assert.deepEqual(calls, [])
})

test('private-smoke qualification is selectable only on the private-test channel and is surfaced for labeling', async () => {
  const full = fixture()
  assert.equal((await full.setup.getStatus()).qualificationScope, 'full')
  assert.equal((await full.setup.preflight()).qualificationScope, 'full')
  const smoke = fixture({ releaseChannel: 'private-test' })
  smoke.setup.catalog.qualification.scope = 'private-smoke'
  assert.equal((await smoke.setup.getStatus()).qualificationScope, 'private-smoke')
  const plan = await smoke.setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.qualificationScope, 'private-smoke')
  assert.equal((await start(smoke.setup, plan.planId)).state, 'restart-required')
  assert.deepEqual(smoke.calls, ['runtime', 'models'])
  for (const releaseChannel of [undefined, 'stable', 'core-private-test']) {
    const other = fixture({ releaseChannel })
    other.setup.catalog.qualification.scope = 'private-smoke'
    const refused = await other.setup.preflight()
    assert.equal(refused.available, false)
    assert.equal(refused.qualificationScope, null)
    assert.match(refused.reason, /processing tools still need to pass the required checks/)
    assert.throws(() => other.setup.selection(null), /required checks/)
    assert.equal((await start(other.setup, refused.planId)).state, 'error')
    assert.deepEqual(other.calls, [])
  }
  for (const scope of [undefined, 'smoke']) {
    const unknown = fixture({ releaseChannel: 'private-test' })
    unknown.setup.catalog.qualification.scope = scope
    assert.equal((await unknown.setup.preflight()).available, false)
    assert.equal((await unknown.setup.getStatus()).qualificationScope, null)
  }
  const failed = fixture({ releaseChannel: 'private-test' })
  failed.setup.catalog.qualification.scope = 'private-smoke'; failed.setup.catalog.qualification.passed = false
  assert.match((await failed.setup.preflight()).reason, /required checks/)
  const broken = fixture({ releaseChannel: 'private-test', catalogError: 'The processing installation catalog could not be verified.' })
  broken.setup.catalog.qualification.scope = 'private-smoke'
  assert.equal((await broken.setup.preflight()).qualificationScope, null)
})
