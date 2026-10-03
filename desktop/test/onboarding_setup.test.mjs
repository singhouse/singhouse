// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { OnboardingSetup, LOCAL_MODEL_IDS } from '../onboarding_setup.mjs'
import { RuntimeManager } from '../runtime_manager.mjs'
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
  runtime.launchProbe = (...args) => runtime.probe(...args)
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
  // Status (and its notifications) never carries the scope; the plan does.
  assert.equal('qualificationScope' in await full.setup.getStatus(), false)
  assert.equal((await full.setup.preflight()).qualificationScope, 'full')
  const smoke = fixture({ releaseChannel: 'private-test' })
  smoke.setup.catalog.qualification.scope = 'private-smoke'
  assert.equal('qualificationScope' in await smoke.setup.getStatus(), false)
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
    assert.equal((await unknown.setup.preflight()).qualificationScope, null)
  }
  const failed = fixture({ releaseChannel: 'private-test' })
  failed.setup.catalog.qualification.scope = 'private-smoke'; failed.setup.catalog.qualification.passed = false
  assert.match((await failed.setup.preflight()).reason, /required checks/)
  const broken = fixture({ releaseChannel: 'private-test', catalogError: 'The processing installation catalog could not be verified.' })
  broken.setup.catalog.qualification.scope = 'private-smoke'
  assert.equal((await broken.setup.preflight()).qualificationScope, null)
})

// ---- Archive-form runtime catalogs ----------------------------------------
const MiB = 1024 * 1024
const sha = value => createHash('sha256').update(value).digest('hex')
const archiveIdentity = { appVersion: '0.1.0', backendVersion: '0.1.0', lyricsyncVersion: '0.1.0', platform: 'linux', arch: 'x64' }
// A complete, lock-bound, functional-probe runtime delivered as two archive parts.
function archiveRuntime(entries) {
  const data = Buffer.concat(entries.map(entry => entry.data))
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(data) >>> 0, 0); trailer.writeUInt32LE(data.length, 4)
  const bytes = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]), deflateRawSync(data), trailer])
  const parts = [bytes.subarray(0, 40), bytes.subarray(40)]
  const urls = ['https://github.com/owner/repo/releases/download/v1/tools.pack.gz.001', 'https://github.com/owner/repo/releases/download/v1/tools.pack.gz.002']
  const manifest = { schema: 1, kind: 'processing', ...archiveIdentity, pythonVersion: '3.12.14', accelerator: 'cpu', python: 'python/bin/python3',
    probe: { schema: 2, type: 'python-functional-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    capabilities: ['transcription', 'separation'], models: [...LOCAL_MODEL_IDS],
    modelCapabilities: Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, id === 'heart-transcriptor' ? 'transcription' : 'separation'])),
    files: entries.map(({ path, data, executable }) => ({ path, size: data.length, sha256: sha(data), executable })) }
  const inputLock = { schema: 1, kind: 'processing-input', ...Object.fromEntries(
    ['appVersion', 'backendVersion', 'lyricsyncVersion', 'pythonVersion', 'platform', 'arch', 'accelerator', 'python', 'capabilities', 'models', 'modelCapabilities', 'probe', 'files']
      .map(key => [key, structuredClone(manifest[key])])), sourceCommit: 'a'.repeat(40),
  packages: [{ name: 'fixture', version: '1', license: 'MIT', sourceUrl: 'https://example.org/fixture.whl', sha256: 'c'.repeat(64), notices: ['NOTICE.fixture'] }] }
  manifest.provenance = { sourceCommit: inputLock.sourceCommit, lockSha256: sha(JSON.stringify(inputLock)),
    inputLock: JSON.stringify(inputLock), packages: structuredClone(inputLock.packages), qualification: 'UNTESTED' }
  manifest.archive = { format: 'concat-gzip-v1', parts: parts.map((part, i) => ({ url: urls[i], sha256: sha(part), size: part.length })) }
  return { manifest, parts, urls }
}
const archiveEntries = [
  { path: 'python/bin/python3', data: Buffer.from('fixture python'), executable: true },
  { path: 'NOTICE.fixture', data: Buffer.from('MIT notice'), executable: false },
  { path: 'lib/noise.bin', data: Buffer.concat(Array.from({ length: 40 }, (_, i) => createHash('sha256').update(String(i)).digest())), executable: false },
]

test('preflight plans an archive-form runtime from its parts: sources, transfer and installed sizes, disk reservation', async () => {
  const { manifest } = archiveRuntime(archiveEntries)
  const { setup } = fixture()
  setup.catalog.runtime = manifest
  setup.catalog.qualification.runtimeLockSha256 = manifest.provenance.lockSha256
  const plan = await setup.preflight()
  assert.equal(plan.available, true, plan.reason)
  const runtime = plan.components.find(component => component.label === 'Local processing runtime')
  const transfer = manifest.archive.parts.reduce((sum, part) => sum + part.size, 0)
  const installed = manifest.files.reduce((sum, file) => sum + file.size, 0)
  assert.notEqual(transfer, installed)
  assert.deepEqual(runtime.sources, ['https://github.com'])
  assert.equal(runtime.bytes, transfer)
  assert.equal(runtime.installedBytes, installed)
  // Every part not yet retrieved, plus the uncompressed tree, plus the margin:
  // exactly what RuntimeManager.install reserves for a fresh archive install.
  assert.equal(plan.diskRequiredBytes, transfer + installed + 30 * 2 + 128 * MiB)
  setup.diskFree = async () => plan.diskRequiredBytes - 1
  assert.match((await setup.preflight()).reason, /Not enough free disk space/)
  // Per-file runtimes keep their sources and reservation unchanged.
  const legacy = fixture()
  const legacyPlan = await legacy.setup.preflight()
  assert.deepEqual(legacyPlan.components[0].sources, ['https://example.org'])
  assert.equal(legacyPlan.components[0].bytes, 5)
  assert.equal(legacyPlan.components[0].installedBytes, 5)
})

test('full setup installs an archive-form runtime catalog through the runtime manager', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { manifest, parts, urls } = archiveRuntime(archiveEntries)
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push(String(url))
    assert.equal(options.redirect, 'manual')
    const bytes = parts[urls.indexOf(String(url))]
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 })
  }
  let reserved
  const runtime = new RuntimeManager(join(root, 'processing'), archiveIdentity, { fetchImpl,
    lockPython: process.platform === 'win32' ? 'python.exe' : 'python3',
    durabilityHelper: fileURLToPath(new URL('../backend.py', import.meta.url)),
    trustedLocks: [manifest.provenance.lockSha256], diskFree: async () => { reserved ??= true; return 1e12 } })
  runtime.probe = async () => ({ schema: 2, accelerator: 'cpu', hardwareAvailable: true, pythonVersion: '3.12.14', backendVersion: '0.1.0', lyricsyncVersion: '0.1.0',
    capabilities: manifest.capabilities, components: Object.fromEntries(manifest.probe.modules.map(module => [module, '1'])),
    capabilitiesReady: true, verifiedCapabilities: manifest.capabilities,
    checks: { deviceTensor: true, nativeAudio: true, transcription: true, separation: true } })
  const { setup, cache, calls } = fixture({ runtime })
  setup.catalog.runtime = manifest
  setup.catalog.qualification.runtimeLockSha256 = manifest.provenance.lockSha256
  const events = []
  setup.notify = state => { if (state.progress) events.push(state.progress) }
  const plan = await setup.preflight()
  assert.equal(plan.available, true, plan.reason)
  assert.deepEqual(plan.components[0].sources, ['https://github.com'])
  assert.equal(requests.length, 0, 'preflight retrieves nothing')
  const status = await start(setup, plan.planId)
  assert.equal(status.state, 'restart-required', status.error)
  assert.deepEqual(requests, urls)
  assert.deepEqual(calls, ['models'])
  assert.ok(reserved)
  const active = await runtime.active()
  assert.equal(active.id, hash(manifest))
  for (const entry of archiveEntries) assert.deepEqual(await readFile(join(active.directory, entry.path)), entry.data)
  assert.deepEqual(events.filter(event => event.phase === 'retrieve').map(event => [event.part, event.parts]).filter((v, i, a) => i === a.findIndex(o => o[0] === v[0])), [[1, 2], [2, 2]])
  assert.equal(events.at(-1).phase, 'extract')
  setup.loaded = { runtimeId: active.id, modelsId: cache.value.id }
  assert.equal((await setup.preflight()).ready, true)
})

// ---- Restored checkpoints ---------------------------------------------------
test('each restored checkpoint kind maps to its workflow state without proving readiness', async () => {
  for (const [saved, state, phase = 'paused'] of [['running', 'cancelled'], ['error', 'cancelled'], ['cancelled', 'cancelled'],
    ['restart-required', 'checking', 'complete'], ['error', 'checking', 'verification'], ['ready', 'idle'], ['idle', 'idle'], [undefined, 'idle']]) {
    const { setup, saved: writes } = fixture({ load: async () => saved && { schema: 1, state: saved, phase } })
    const status = await setup.getStatus()
    assert.equal(status.state, state, String(saved))
    if (state === 'cancelled') {
      assert.match(status.message, /interrupted/)
      assert.equal(status.retryable, true)
    }
    if (state === 'checking') {
      assert.equal(status.message, 'Checking your local processing setup…')
      assert.equal(status.retryable, false)
      assert.doesNotMatch(status.message, /cancel|interrupt/i)
    }
    assert.deepEqual(writes, [], 'restoring never rewrites the checkpoint')
  }
})

async function restartedFixture() {
  const first = fixture()
  assert.equal((await start(first.setup, (await first.setup.preflight()).planId)).state, 'restart-required')
  const checkpoint = first.saved.at(-1)
  const events = []
  const next = fixture({ load: async () => checkpoint, notify: state => events.push(state),
    loaded: { runtimeId: first.runtime.value.id, modelsId: first.cache.value.id } })
  next.runtime.value = first.runtime.value
  next.cache.value = first.cache.value
  return { ...next, events, checkpoint }
}

test('a restored verified setup is checked, then settles ready from live verification only', async () => {
  const { setup, saved, events, calls } = await restartedFixture()
  assert.equal((await setup.getStatus()).state, 'checking')
  const plan = await setup.preflight()
  assert.equal(plan.ready, true)
  const status = await setup.getStatus()
  assert.equal(status.state, 'ready')
  assert.equal(status.restartRequired, false)
  assert.equal(saved.at(-1).state, 'ready')
  assert.equal(events.at(-1).state, 'ready')
  assert.deepEqual(calls, [], 'checking retrieves nothing')
  // A second relaunch after a ready outcome does not check again.
  const again = fixture({ load: async () => saved.at(-1) })
  assert.equal((await again.setup.getStatus()).state, 'idle')
})

test('a restored check that fails verification lands on a retryable, non-cancelled error', async () => {
  for (const damage of [
    ({ runtime }) => { runtime.value = null },
    ({ cache }) => { cache.value = { ...cache.value, manifest: { models: ['heart-transcriptor'] } } },
    ({ runtime }) => { runtime.probe = async () => { throw new Error('probe failed') } },
  ]) {
    const restarted = await restartedFixture()
    damage(restarted)
    const plan = await restarted.setup.preflight()
    assert.equal(plan.ready, false)
    const status = await restarted.setup.getStatus()
    assert.equal(status.state, 'error')
    assert.equal(status.retryable, true)
    assert.equal(status.phase, 'verification')
    assert.doesNotMatch(status.message, /cancel|interrupt/i)
    assert.equal(status.message, 'Review setup to check and repair the installation.')
    assert.equal(restarted.saved.at(-1).state, 'error')
    assert.equal(restarted.events.at(-1).state, 'error')
    assert.deepEqual(restarted.calls, [])
  }
})

test('a restored check settles to an error when verification itself throws', async () => {
  const { setup, cache, saved } = await restartedFixture()
  // A malformed installed models manifest makes verification throw.
  cache.value = { id: 'malformed', manifest: {} }
  await assert.rejects(setup.preflight(), TypeError)
  const status = await setup.getStatus()
  assert.equal(status.state, 'error')
  assert.doesNotMatch(status.message, /cancel|interrupt/i)
  assert.equal(saved.at(-1).state, 'error')
})

test('a restored check that still needs reopening shows the restart step again', async () => {
  const { setup, saved } = await restartedFixture()
  setup.loaded = {}
  const plan = await setup.preflight()
  assert.equal(plan.restartRequired, true)
  const status = await setup.getStatus()
  assert.equal(status.state, 'restart-required')
  assert.equal(status.restartRequired, true)
  assert.equal(saved.at(-1).state, 'restart-required')
})

test('an exit while checking leaves the checkpoint to be checked again, never ready', async () => {
  const { setup, saved, checkpoint, runtime } = await restartedFixture()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  runtime.probe = () => { entered(); return new Promise(() => {}) }
  void setup.preflight()
  await started
  assert.equal((await setup.getStatus()).state, 'checking')
  assert.deepEqual(saved, [], 'nothing is saved before the check settles')
  // Relaunch from the unchanged checkpoint.
  const relaunched = fixture({ load: async () => checkpoint })
  assert.equal((await relaunched.setup.getStatus()).state, 'checking')
  assert.equal((await relaunched.setup.preflight()).ready, false)
  assert.equal((await relaunched.setup.getStatus()).state, 'error')
})

test('a setup started during a check takes precedence over the check outcome', async () => {
  const { setup, runtime } = await restartedFixture()
  const probe = runtime.probe
  let release
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  runtime.probe = async (...args) => { if (first) { first = false; await gate } return probe(...args) }
  const checking = setup.preflight()
  await new Promise(resolve => setImmediate(resolve))
  await setup.update({ state: 'running', phase: 'preflight' })
  release()
  await checking
  assert.equal((await setup.getStatus()).state, 'running')
})

test('concurrent preflights during a check share one live verification and each returns a plan', async () => {
  const { setup, runtime } = await restartedFixture()
  const probe = runtime.probe
  let probes = 0
  runtime.probe = async (...args) => { probes += 1; return probe(...args) }
  const plans = await Promise.all([setup.preflight(), setup.preflight(), setup.preflight()])
  assert.equal(probes, 1)
  for (const plan of plans) {
    assert.equal(plan.ready, true)
    assert.equal(plan.available, true)
    assert.equal(typeof plan.planId, 'string')
  }
  assert.equal((await setup.getStatus()).state, 'ready')
  // Once settled, a later preflight verifies afresh.
  await setup.preflight()
  assert.equal(probes, 2)
})

test('a failed check is checked again on the next launch, never shown as interrupted', async () => {
  const first = await restartedFixture()
  first.runtime.value = null
  await first.setup.preflight()
  const failed = first.saved.at(-1)
  assert.deepEqual(failed, { schema: 1, state: 'error', phase: 'verification' })
  const relaunched = fixture({ load: async () => failed, loaded: first.setup.loaded })
  relaunched.runtime.value = first.runtime.value
  const status = await relaunched.setup.getStatus()
  assert.equal(status.state, 'checking')
  assert.doesNotMatch(status.message, /cancel|interrupt/i)
  // The checkpoint never proves readiness: nothing is installed, so it fails again.
  await relaunched.setup.preflight()
  assert.equal((await relaunched.setup.getStatus()).state, 'error')
  assert.equal((await relaunched.setup.getStatus()).message, 'Review setup to check and repair the installation.')
  // A repaired installation settles ready from live verification on a later launch.
  const repaired = await restartedFixture()
  const again = fixture({ load: async () => failed, loaded: repaired.setup.loaded })
  again.runtime.value = repaired.runtime.value
  again.cache.value = repaired.cache.value
  assert.equal((await again.setup.preflight()).ready, true)
  assert.equal((await again.setup.getStatus()).state, 'ready')
})

test('callers overlapping the checkpoint read all see the restored state', async () => {
  const { checkpoint, runtime, cache, setup: reference } = await restartedFixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let loads = 0
  const { setup } = fixture({ load: async () => { loads += 1; await gate; return checkpoint }, loaded: reference.loaded })
  setup.runtime.value = runtime.value
  setup.cache.value = cache.value
  const early = [setup.getStatus(), setup.preflight(), setup.getStatus()]
  release()
  const [first, plan, second] = await Promise.all(early)
  assert.equal(loads, 1)
  assert.equal(first.state, 'checking', 'an early caller sees the restored check, never idle')
  assert.equal(second.state, 'checking')
  assert.equal(plan.ready, true)
  assert.equal((await setup.getStatus()).state, 'ready', 'the overlapping preflight settled the check')
})

test('an unreadable checkpoint is treated as none and does not wedge status', async () => {
  const { setup } = fixture({ load: async () => { throw new Error('unreadable') } })
  assert.equal((await setup.getStatus()).state, 'idle')
  assert.equal((await setup.preflight()).available, true)
  assert.equal((await setup.getStatus()).state, 'idle')
})

const CPU_PACK = { platform: 'linux', arch: 'x64', accelerator: 'cpu' }
const METAL_PACK = { platform: 'darwin', arch: 'arm64', accelerator: 'metal' }
const CUDA_PACK = { platform: 'linux', arch: 'x64', accelerator: 'cuda' }
const MEASURED_BASIS = 'This pack uses the CPU, even if your computer has a graphics card. Based on one measured run on a 16-core desktop processor; computers with fewer cores may take longer.'
const measured = measuredPeakBytes => ({ measuredPeakBytes, evidenceReference: 'measured-fixture',
  representativeHardware: { verified: true, description: 'Test measurement host' } })
// Matching measured memory evidence: 10 GiB RAM and 5 GiB VRAM after headroom.
const cudaMemory = (target = CUDA_PACK) => ({ runtimeLockSha256: 'locked', ...target, ram: measured(8 * GiB), vram: measured(4 * GiB) })
function estimateFixture(target, hardware, { memory = target.accelerator === 'cuda' ? cudaMemory(target) : undefined } = {}) {
  const { setup, runtime, cache } = fixture({ hardware: async () => hardware })
  Object.assign(setup.catalog.runtime, target)
  Object.assign(setup.catalog.qualification, target)
  if (memory) setup.catalog.memory = memory
  return { setup, runtime, cache }
}
function installEstimateFixture(target, hardware, options) {
  const result = estimateFixture(target, hardware, options)
  const { runtime, cache, setup } = result
  runtime.value = { id: hash(setup.catalog.runtime), directory: '/runtime', manifest: structuredClone(setup.catalog.runtime) }
  cache.value = { id: 'models', manifest: { models: [...LOCAL_MODEL_IDS] } }
  const probe = runtime.probe
  runtime.probe = async (...args) => ({ ...await probe(...args), accelerator: target.accelerator })
  return result
}
const cpuHost = extra => ({ platform: 'linux', arch: 'x64', cpuCount: 16, totalMemoryBytes: 32 * GiB, ...extra })
const appleHost = extra => ({ platform: 'darwin', arch: 'arm64', cpu: 'Apple M2', cpuCount: 10,
  totalMemoryBytes: 16 * GiB, unifiedMemory: true, ...extra })
const cudaHost = (name, vramGiB = 12, extra) => cpuHost({ cudaDevices: [{ name, dedicatedMemoryBytes: Math.round(vramGiB * GiB) }], ...extra })

test('processing planning estimate follows the selected pack, never the display GPU', async () => {
  const hardware = cudaHost('NVIDIA GeForce RTX 4090', 24, { gpu: 'NVIDIA GeForce RTX 4090' })
  const plan = await estimateFixture(CPU_PACK, hardware).setup.preflight()
  assert.deepEqual(plan.processingEstimate, { level: 2, label: 'Moderate', minutes: [9, 16], evidence: 'measured', basis: MEASURED_BASIS })
  hardware.cpuCount = 4
  const slow = (await estimateFixture(CPU_PACK, hardware).setup.preflight()).processingEstimate
  assert.deepEqual(slow.minutes, [25, 45])
  assert.match(slow.basis, /uses the CPU/)
  assert.equal(slow.evidence, 'extrapolated')
})

const ESTIMATE_CASES = [
  // CPU packs: logical processors, then less than 15 GiB RAM moves one tier slower.
  [CPU_PACK, cpuHost({ cpuCount: 32 }), [9, 16], 'measured'],
  [CPU_PACK, cpuHost({ cpuCount: 16 }), [9, 16], 'measured'],
  [CPU_PACK, cpuHost({ cpuCount: 15 }), [12, 20]],
  [CPU_PACK, cpuHost({ cpuCount: 12 }), [12, 20]],
  [CPU_PACK, cpuHost({ cpuCount: 11 }), [15, 28]],
  [CPU_PACK, cpuHost({ cpuCount: 8 }), [15, 28]],
  [CPU_PACK, cpuHost({ cpuCount: 7 }), [25, 45]],
  [CPU_PACK, cpuHost({ cpuCount: 1 }), [25, 45]],
  [CPU_PACK, cpuHost({ cpuCount: 16, totalMemoryBytes: 15 * GiB }), [9, 16], 'measured'],
  [CPU_PACK, cpuHost({ cpuCount: 16, totalMemoryBytes: Math.round(15.6 * GiB) }), [9, 16], 'measured'],
  [CPU_PACK, cpuHost({ cpuCount: 16, totalMemoryBytes: 15 * GiB - 1 }), [12, 20]],
  [CPU_PACK, cpuHost({ cpuCount: 12, totalMemoryBytes: 15 * GiB - 1 }), [15, 28]],
  [CPU_PACK, cpuHost({ cpuCount: 8, totalMemoryBytes: 15 * GiB - 1 }), [25, 45]],
  [CPU_PACK, cpuHost({ cpuCount: 7, totalMemoryBytes: 8 * GiB }), [25, 45]],
  // A CPU pack on an NVIDIA host stays a CPU estimate.
  [CPU_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24, { cpuCount: 12 }), [12, 20]],
  // Apple Metal packs.
  [METAL_PACK, appleHost({ cpu: 'Apple M1' }), [8, 20]],
  [METAL_PACK, appleHost({ cpu: 'Apple M3' }), [8, 20]],
  [METAL_PACK, appleHost({ cpu: 'Apple M1 Pro' }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple M2 Max' }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple M3 Ultra' }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple M4' }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple M4 Pro' }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple' }), [8, 20]],
  [METAL_PACK, appleHost({ cpu: undefined }), [8, 20]],
  [METAL_PACK, appleHost({ cpu: 'Apple M2 Max', totalMemoryBytes: 15 * GiB }), [5, 12]],
  [METAL_PACK, appleHost({ cpu: 'Apple M2 Max', totalMemoryBytes: 15 * GiB - 1 }), [15, 35]],
  [METAL_PACK, appleHost({ cpu: 'Apple M1', totalMemoryBytes: 8 * GiB }), [15, 35]],
  // CUDA packs classify the single CUDA device (12 GiB unless stated).
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090 D', 24), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 5090 D', 32), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080 Ti'), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4070 SUPER'), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4070 Ti SUPER', 16), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3060'), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3060 12GB'), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 2080 Ti', 11), [2, 5]],
  [CUDA_PACK, cudaHost('Tesla T4', 15), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA T4', 15), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3050', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 5050', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce GTX 1660 SUPER', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3060', 12, { platform: 'win32' }), [2, 5], 'extrapolated', { platform: 'win32' }],
  // Dedicated VRAM: 7.5 GiB up to (not including) 9.5 GiB demotes one tier; entry is the floor.
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080', 10), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080', 9.4), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080', 9.5), [1, 3]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4070', 8), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4070', 7.5), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4060 Ti', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4060 Ti', 16), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), [1, 3]],
  // Laptop and Max-Q parts demote one tier and stack with the VRAM demotion.
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090 Laptop GPU', 16), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080 Laptop GPU', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 2080 with Max-Q Design', 8), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3080 Laptop GPU with Max-Q Design', 16), [2, 5]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3060 Laptop GPU', 12), [5, 12]],
  [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3050 8GB Laptop GPU', 8), [5, 12]],
]

test('processing estimate tiers cover every hardware boundary', async () => {
  for (const [pack, hardware, minutes, evidence = 'extrapolated', packOverride = {}] of ESTIMATE_CASES) {
    const estimate = (await estimateFixture({ ...pack, ...packOverride }, hardware).setup.preflight()).processingEstimate
    const name = `${pack.accelerator} ${hardware.cpu ?? hardware.cudaDevices?.[0]?.name ?? ''} ${hardware.cpuCount} ${hardware.totalMemoryBytes}`
    const level = minutes[1] <= 12 ? 3 : minutes[1] <= 30 ? 2 : 1
    assert.deepEqual(estimate.minutes, minutes, name)
    assert.equal(estimate.level, level, name)
    assert.equal(estimate.label, ['Slower', 'Moderate', 'Faster'][level - 1], name)
    assert.equal(estimate.evidence, evidence, name)
    if (evidence === 'measured') assert.equal(estimate.basis, MEASURED_BASIS, name)
    else {
      assert.match(estimate.basis, { cpu: /uses the CPU/, metal: /uses Apple Metal/, cuda: /uses your NVIDIA graphics card/ }[pack.accelerator], name)
      assert.match(estimate.basis, /extrapolated from published component timings/, name)
    }
  }
})

test('CUDA estimates require an admitted, recognized single CUDA device with enough VRAM', async () => {
  const unqualified = setup => { setup.catalog.qualification.passed = false }
  for (const [pack, hardware, change = () => {}, options] of [
    [CUDA_PACK, cudaHost('NVIDIA RTX A5000', 24)],
    [CUDA_PACK, cudaHost('NVIDIA GeForce MX450', 8)],
    [CUDA_PACK, cudaHost('NVIDIA A100-SXM4-40GB', 40)],
    [CUDA_PACK, cudaHost('AMD Radeon RX 7900 XTX', 24)],
    [CUDA_PACK, cudaHost('NVIDIA GeForce GTX 1080 Ti', 11)],
    [CUDA_PACK, cudaHost('NVIDIA GeForce GTX 1060 6GB', 8)],
    [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090 Mystery Edition', 24)],
    [CUDA_PACK, cudaHost('', 12)],
    [CUDA_PACK, cudaHost(undefined, 12)],
    // Dedicated VRAM unknown, at most 6 GB, or below 7.5 GiB.
    [CUDA_PACK, cpuHost({ cudaDevices: [{ name: 'NVIDIA GeForce RTX 4090' }] })],
    [CUDA_PACK, cpuHost({ cudaDevices: [{ name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: null }] })],
    [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3060 Laptop GPU', 6)],
    [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 3050 6GB Laptop GPU', 6)],
    [CUDA_PACK, cpuHost({ cudaDevices: [{ name: 'NVIDIA GeForce RTX 4070', dedicatedMemoryBytes: 7.5 * GiB - 1 }] })],
    // Ambiguous or unsupported targets.
    [CUDA_PACK, cpuHost({ cudaDevices: [{ name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: 24 * GiB },
      { name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: 24 * GiB }] })],
    [CUDA_PACK, cpuHost({ cudaDevices: [] })],
    [CUDA_PACK, cpuHost({ gpuDevices: [{ name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: 24 * GiB }] })],
    [{ ...CUDA_PACK, platform: 'darwin', arch: 'arm64' }, appleHost({ unifiedMemory: false,
      cudaDevices: [{ name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: 24 * GiB }] })],
    [{ ...CUDA_PACK, arch: 'arm64' }, cudaHost('NVIDIA GeForce RTX 4090', 24, { arch: 'arm64' })],
    // Missing admission: no measured memory evidence, or an unqualified catalog.
    [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), () => {}, { memory: null }],
    [CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), unqualified],
  ]) {
    const { setup } = estimateFixture(pack, hardware, options)
    change(setup)
    const estimate = (await setup.preflight()).processingEstimate
    assert.equal(estimate.minutes, null, JSON.stringify(hardware.cudaDevices))
    assert.equal(estimate.level, null)
  }
  // Withholding the advisory range never blocks an otherwise available plan.
  const { setup } = estimateFixture(CUDA_PACK, cudaHost('NVIDIA RTX A5000', 24))
  const plan = await setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.memoryQualification.status, 'meets-measured-requirements')
  assert.equal(plan.processingEstimate.minutes, null)
  const unmeasured = estimateFixture(CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), { memory: null })
  assert.equal((await unmeasured.setup.preflight()).available, true)
})

test('memory-blocked plans never get a speed estimate', async () => {
  for (const hardware of [
    cudaHost('NVIDIA GeForce RTX 4090', 24, { totalMemoryBytes: 9 * GiB }),
    cudaHost('NVIDIA GeForce RTX 4090', 24, { cudaDevices: [{ name: 'NVIDIA GeForce RTX 4090', dedicatedMemoryBytes: 4 * GiB }] }),
  ]) {
    const plan = await estimateFixture(CUDA_PACK, hardware).setup.preflight()
    assert.equal(plan.available, false)
    assert.equal(plan.processingEstimate.minutes, null)
  }
  const cpu = estimateFixture(CPU_PACK, cpuHost({ totalMemoryBytes: 9 * GiB }),
    { memory: { runtimeLockSha256: 'locked', ...CPU_PACK, ram: measured(8 * GiB) } })
  const plan = await cpu.setup.preflight()
  assert.equal(plan.available, false)
  assert.equal(plan.processingEstimate.minutes, null)
})

test('installed runtimes matching the catalog keep their CUDA and Metal tiers', async () => {
  const cuda = installEstimateFixture(CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24))
  let plan = await cuda.setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.components.length, 0, 'the installed path answered')
  assert.deepEqual(plan.processingEstimate.minutes, [1, 3])
  const unqualified = installEstimateFixture(CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24))
  unqualified.setup.catalog.qualification.passed = false
  plan = await unqualified.setup.preflight()
  assert.equal(plan.available, true)
  assert.equal(plan.components.length, 0)
  assert.equal(plan.processingEstimate.minutes, null)
  const unmeasured = installEstimateFixture(CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24), { memory: null })
  assert.equal((await unmeasured.setup.preflight()).processingEstimate.minutes, null)
  const drifted = installEstimateFixture(CUDA_PACK, cudaHost('NVIDIA GeForce RTX 4090', 24))
  drifted.setup.catalog.runtime = { ...drifted.setup.catalog.runtime, id: `${drifted.setup.catalog.runtime.id}-other` }
  plan = await drifted.setup.preflight()
  assert.equal(plan.components.length, 0, 'the installed path answered')
  assert.equal(plan.processingEstimate.minutes, null, 'an installed manifest that differs from the catalog gets no estimate')
  const metal = installEstimateFixture(METAL_PACK, appleHost({ cpu: 'Apple M4 Pro', totalMemoryBytes: 24 * GiB }))
  plan = await metal.setup.preflight()
  assert.equal(plan.components.length, 0)
  assert.deepEqual(plan.processingEstimate.minutes, [5, 12])
  assert.equal(plan.processingEstimate.label, 'Faster')
})

test('unknown, mismatched, incomplete, and blocked plans never get a speed estimate', async () => {
  const hardware = { platform: 'linux', arch: 'x64', cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3 }
  for (const change of [
    setup => { setup.catalog = null },
    setup => { setup.catalog.qualification.passed = false },
    setup => { setup.catalog.runtime.models = ['heart-transcriptor'] },
    setup => { setup.catalog.runtime.models = [...LOCAL_MODEL_IDS, 'unknown-model'] },
    setup => { setup.hardware = async () => ({ ...hardware, arch: 'arm64' }) },
    setup => { setup.hardware = async () => ({ ...hardware, cpuCount: null }) },
    setup => { setup.diskFree = async () => 0 },
    setup => { setup.catalog.runtime.provenance.lockSha256 = ''; setup.catalog.qualification.runtimeLockSha256 = '' },
  ]) {
    const { setup } = fixture({ hardware: async () => hardware })
    change(setup)
    assert.equal((await setup.preflight()).processingEstimate.minutes, null)
  }
})

test('Metal planning range requires an Apple silicon unified-memory target', async () => {
  const hardware = { platform: 'darwin', arch: 'arm64', cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, unifiedMemory: true }
  const { setup } = fixture({ hardware: async () => hardware })
  Object.assign(setup.catalog.runtime, { platform: 'darwin', arch: 'arm64', accelerator: 'metal' })
  Object.assign(setup.catalog.qualification, { platform: 'darwin', arch: 'arm64', accelerator: 'metal' })
  const plan = await setup.preflight()
  assert.deepEqual(plan.processingEstimate.minutes, [8, 20])
  assert.match(plan.processingEstimate.basis, /uses Apple Metal/)
  hardware.unifiedMemory = false
  assert.equal((await setup.preflight()).processingEstimate.minutes, null)
})

test('hardware-test requires private channel and false status, and cannot skip functional verification', async () => {
  for (const releaseChannel of ['private-test', 'stable', undefined]) {
    const candidate = fixture({ releaseChannel })
    candidate.setup.catalog.qualification.scope = 'hardware-test'
    candidate.setup.catalog.qualification.passed = false
    const plan = await candidate.setup.preflight()
    assert.equal(plan.available, releaseChannel === 'private-test')
    if (plan.available) {
      assert.equal(plan.qualificationScope, 'hardware-test')
      candidate.runtime.probe = async () => { throw new Error('CUDA device unavailable') }
      assert.equal((await start(candidate.setup, plan.planId)).state, 'error')
      assert.equal((await candidate.setup.preflight()).ready, false)
    } else {
      assert.equal((await start(candidate.setup, plan.planId)).state, 'error')
      assert.deepEqual(candidate.calls, [])
    }
  }
  const misleading = fixture({ releaseChannel: 'private-test' })
  misleading.setup.catalog.qualification.scope = 'hardware-test'
  assert.equal((await misleading.setup.preflight()).available, false)
})

test('navigation reuses launch verification while consent still requires full verification', async () => {
  const { setup, runtime, cache } = fixture()
  await start(setup, (await setup.preflight()).planId)
  setup.loaded = { runtimeId: runtime.value.id, modelsId: cache.value.id }
  const modes = []
  runtime.active = async options => { modes.push(['runtime', options?.launch]); return runtime.value }
  cache.active = async options => { modes.push(['models', options?.launch]); return cache.value }
  const accepted = await runtime.probe()
  runtime.launchProbe = async () => { modes.push(['cached']); return accepted }
  runtime.probe = async () => { modes.push(['fresh']); throw new Error('native check failed') }
  const plan = await setup.preflight()
  assert.equal(plan.ready, true)
  assert.deepEqual(modes, [['runtime', true], ['models', true], ['cached']])
  modes.length = 0
  assert.equal((await start(setup, plan.planId)).state, 'error')
  assert.ok(modes.some(([kind, launch]) => kind === 'runtime' && launch === false))
  assert.ok(modes.some(([kind]) => kind === 'fresh'))
})

test('a usable CPU installation offers the selected CUDA upgrade and reuses models', async () => {
  const { setup, runtime, cache, calls } = fixture()
  await start(setup, (await setup.preflight()).planId)
  setup.loaded = { runtimeId: runtime.value.id, modelsId: cache.value.id }
  setup.catalog.runtime = structuredClone(setup.catalog.runtime)
  setup.catalog.runtime.accelerator = 'cuda'
  setup.catalog.qualification.accelerator = 'cuda'
  const probe = runtime.probe
  runtime.probe = async active => ({ ...await probe(), accelerator: active.manifest.accelerator })
  calls.length = 0
  const plan = await setup.preflight()
  assert.equal(plan.ready, false)
  assert.equal(plan.restartRequired, false)
  assert.equal(plan.runtimeTransferRequired, true)
  assert.equal(plan.components[0].label, 'Local processing runtime')
  assert.ok(plan.components.slice(1).every(component => component.bytes === 0))
  assert.deepEqual(calls, [])
  assert.equal((await start(setup, plan.planId)).state, 'restart-required')
  assert.deepEqual(calls, ['runtime'])
  assert.equal(runtime.value.manifest.accelerator, 'cuda')
  setup.loaded.runtimeId = runtime.value.id
  assert.equal((await setup.preflight()).ready, true)
})

test('falling back to CPU after a CUDA installation never completes the upgrade', async () => {
  const { setup, runtime, cache } = fixture()
  await start(setup, (await setup.preflight()).planId)
  setup.loaded = { runtimeId: runtime.value.id, modelsId: cache.value.id }
  setup.catalog.runtime = structuredClone(setup.catalog.runtime)
  setup.catalog.runtime.accelerator = 'cuda'
  setup.catalog.qualification.accelerator = 'cuda'
  runtime.install = async () => {} // The manager returned the older usable pointer.
  assert.equal((await start(setup, (await setup.preflight()).planId)).state, 'error')
  assert.equal((await setup.preflight()).ready, false)
})
