// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateHardwarePolicy, assessHardwarePolicy, recoveryOptions } from '../hardware_policy.mjs'

const lock = 'a'.repeat(64)
const policy = () => ({ schema: 1, version: '1.0.0', recipes: [{ id: 'standard', label: 'Standard', modelIds: ['model'] }],
  variants: [{ id: 'standard-cuda', label: 'CUDA', recipeId: 'standard', platform: 'linux', arch: 'x64', accelerator: 'cuda',
    priority: 1, status: 'qualified', qualityTradeoff: 'Original precision.', settings: {},
    evidence: { runtimeLockSha256: lock, reference: 'test-only fixture', scope: 'full', workload: 'test-only workload',
      pipeline: { separation: true, transcription: true, alignment: true }, timings: { coldSeconds: 2, warmSeconds: 1 }, qualityComparison: 'Test fixture baseline comparison',
      headroomFraction: 0.25, peakRamBytes: 100, peakVramBytes: 100, workingDiskBytes: 10, downloadBytes: 20, installedBytes: 30, unifiedMemory: false } }] })
const options = () => ({ policy: policy(), hardware: { platform: 'linux', arch: 'x64', unifiedMemory: false,
  totalMemoryBytes: 200, availableMemoryBytes: 150, cudaDevices: [{ dedicatedMemoryBytes: 200, availableMemoryBytes: 150 }] },
  runtimeLockSha256: lock, diskFreeBytes: 100, installedModelIds: ['model'] })
const result = o => assessHardwarePolicy(o).variants[0]

test('shipped policy makes no unsupported qualification claims', async () => {
  const shipped = JSON.parse(await readFile(new URL('../hardware-policy.json', import.meta.url)))
  assert.ok(validateHardwarePolicy(shipped).variants.every(v => v.status !== 'qualified'))
  assert.equal(assessHardwarePolicy({ policy: shipped }).selectedVariantId, null)
})
test('qualified selection exposes measured headroom and does not authorize downloads', () => {
  const o = options(), a = assessHardwarePolicy(o)
  assert.equal(a.selectedVariantId, 'standard-cuda')
  assert.equal(a.variants[0].requirements.ramBytes, 125)
  assert.equal(a.downloadAuthorized, false)
  assert.throws(() => assessHardwarePolicy({ ...o, variantId: 'invented' }), /Unknown processing variant/)
})
test('available RAM is separate from total RAM; unknown data fails closed', () => {
  for (const [value, status] of [[124, 'insufficient'], [null, 'unknown'], [NaN, 'unknown']]) {
    const o = options(); o.hardware.availableMemoryBytes = value
    assert.equal(result(o).status, status)
  }
  const o = options(); o.hardware.totalMemoryBytes = 124
  assert.equal(result(o).status, 'insufficient')
})
test('CUDA requires one actual driver device, never summed VRAM or unified RAM', () => {
  for (const devices of [[], [{ dedicatedMemoryBytes: null }], [{ dedicatedMemoryBytes: 80 }, { dedicatedMemoryBytes: 80 }]]) {
    const o = options(); o.hardware.cudaDevices = devices; o.hardware.videoMemoryBytes = 1000
    assert.equal(result(o).status, 'unknown')
  }
  const o = options(); o.hardware.unifiedMemory = true
  assert.equal(result(o).status, 'unknown')
})
test('fresh execution assessment uses available VRAM and refuses missing models', () => {
  const o = options(); o.phase = 'execution'; o.hardware.cudaDevices[0].availableMemoryBytes = 124
  assert.equal(result(o).status, 'insufficient')
  delete o.hardware.cudaDevices[0].availableMemoryBytes
  assert.equal(result(o).status, 'unknown')
  o.hardware.cudaDevices[0].availableMemoryBytes = 150; o.installedModelIds = []
  assert.equal(result(o).status, 'setup-required')
  assert.equal(assessHardwarePolicy(o).downloadAuthorized, false)
})
test('runtime, release scope and target evidence must match', () => {
  const o = options(); o.runtimeLockSha256 = 'b'.repeat(64)
  assert.equal(result(o).status, 'unknown')
  o.runtimeLockSha256 = lock; o.policy.variants[0].evidence.scope = 'private-smoke'
  assert.equal(result(o).status, 'unqualified')
  o.releaseChannel = 'private-test'
  assert.equal(result(o).status, 'supported')
  o.hardware.platform = 'win32'
  assert.equal(result(o).status, 'unsupported')
})
test('storage accounts for downloads and installed files only when models are missing', () => {
  const o = options(); o.diskFreeBytes = 20
  assert.equal(result(o).status, 'supported')
  o.installedModelIds = []
  assert.equal(result(o).status, 'insufficient')
  o.diskFreeBytes = 60
  assert.equal(result(o).status, 'supported')
  assert.equal(result(o).downloadRequired, true)
})
test('manual override and recovery cannot promote unqualified variants', () => {
  const o = options(); o.policy.variants[0].status = 'unqualified'; o.policy.variants[0].reason = 'No measurements.'
  o.variantId = 'standard-cuda'
  assert.equal(assessHardwarePolicy(o).selectedVariantId, null)
  assert.deepEqual(recoveryOptions(o).alternatives, [])
  assert.equal(recoveryOptions(o).retryRequiresUserAction, true)
})
test('unified-memory MPS uses system headroom without fabricating dedicated VRAM', () => {
  const o = options(), v = o.policy.variants[0]
  Object.assign(v, { platform: 'darwin', arch: 'arm64', accelerator: 'metal' })
  Object.assign(v.evidence, { unifiedMemory: true, peakVramBytes: null })
  Object.assign(o.hardware, { platform: 'darwin', arch: 'arm64', unifiedMemory: true, cudaDevices: [] })
  assert.equal(result(o).status, 'supported')
  assert.equal(result(o).requirements.vramBytes, null)
})
test('validator rejects incomplete measurements, duplicate IDs, unsafe quantities', () => {
  const mutations = [p => { p.schema = 2 }, p => { p.variants.push(structuredClone(p.variants[0])) },
    p => { p.variants[0].evidence.headroomFraction = -0.1 }, p => { delete p.variants[0].evidence.reference },
    p => { p.variants[0].evidence.peakRamBytes = Number.MAX_SAFE_INTEGER }, p => { p.variants[0].evidence.downloadBytes = -1 }]
  for (const mutate of mutations) { const p = policy(); mutate(p); assert.throws(() => validateHardwarePolicy(p), /Invalid hardware policy/) }
})

test('unsupported settings and mismatched accelerator never become selectable', () => {
  const o = options()
  o.accelerator = 'cpu'
  assert.equal(result(o).status, 'unsupported')
  delete o.accelerator
  o.policy.variants[0].settings = { precision: 'int8' }
  assert.equal(result(o).status, 'unsupported')
})

const candidateOptions = () => {
  const o = options(), v = o.policy.variants[0]
  const e = v.evidence
  v.status = 'candidate'
  v.admission = { runtimeLockSha256: lock, reference: 'pending-final-acceptance',
    basisReferences: ['original-resource-budget'], ramBytes: 125, vramBytes: 125,
    workingDiskBytes: e.workingDiskBytes, downloadBytes: e.downloadBytes,
    installedBytes: e.installedBytes, unifiedMemory: false }
  delete v.evidence
  o.releaseChannel = 'private-test'
  return o
}

test('candidate budgets admit normal private setup and execution without qualification claims', () => {
  const o = candidateOptions()
  for (const phase of ['setup', 'execution']) {
    const a = assessHardwarePolicy({ ...o, phase })
    assert.equal(a.selectedVariantId, 'standard-cuda')
    assert.equal(a.downloadAuthorized, false)
    assert.equal(a.variants[0].requirements.ramBytes, 125)
    assert.equal(a.variants[0].requirements.vramBytes, 125)
    assert.equal(a.variants[0].requirements.headroomFraction, null)
    assert.equal(a.variants[0].requirements.acceptancePending, true)
    assert.deepEqual(a.variants[0].requirements.basisReferences, ['original-resource-budget'])
    assert.match(a.reason, /final acceptance remains pending/)
    assert.equal(o.policy.variants[0].status, 'candidate')
    assert.equal(o.policy.variants[0].evidence, undefined)
  }
})

test('candidate cannot be admitted outside private-test or with stale identity or unsupported settings', () => {
  for (const releaseChannel of [undefined, 'public', 'stable', 'private-smoke']) {
    const o = candidateOptions(); o.releaseChannel = releaseChannel
    assert.equal(result(o).status, 'unqualified')
    assert.equal(assessHardwarePolicy({ ...o, variantId: 'standard-cuda' }).selectedVariantId, null)
  }
  const mutations = [o => { o.runtimeLockSha256 = 'b'.repeat(64) },
    o => { o.hardware.platform = 'win32' }, o => { o.hardware.arch = 'arm64' },
    o => { o.accelerator = 'cpu' }, o => { o.policy.variants[0].settings = { precision: 'int8' } }]
  for (const mutate of mutations) {
    const o = candidateOptions(); mutate(o)
    assert.equal(assessHardwarePolicy(o).selectedVariantId, null)
  }
})

test('candidate retains fresh RAM, GPU inventory, execution VRAM, storage and model checks', () => {
  const mutations = [o => { o.hardware.totalMemoryBytes = 124 },
    o => { o.hardware.availableMemoryBytes = 124 }, o => { o.hardware.availableMemoryBytes = null },
    o => { o.hardware.cudaDevices = [] }, o => { o.hardware.cudaDevices = [{ dedicatedMemoryBytes: 80 }, { dedicatedMemoryBytes: 80 }] },
    o => { o.hardware.cudaDevices[0].dedicatedMemoryBytes = 124 },
    o => { o.hardware.unifiedMemory = true },
    o => { o.phase = 'execution'; o.hardware.cudaDevices[0].availableMemoryBytes = 124 },
    o => { o.phase = 'execution'; delete o.hardware.cudaDevices[0].availableMemoryBytes },
    o => { o.diskFreeBytes = null }, o => { o.diskFreeBytes = 9 },
    o => { o.installedModelIds = []; o.diskFreeBytes = 59 },
    o => { o.phase = 'execution'; o.installedModelIds = [] }]
  for (const mutate of mutations) {
    const o = candidateOptions(); mutate(o)
    assert.equal(assessHardwarePolicy(o).selectedVariantId, null)
  }
  const o = candidateOptions(); o.installedModelIds = []; o.diskFreeBytes = 60
  assert.equal(result(o).supported, true)
  assert.equal(result(o).requirements.diskRequiredBytes, 60)
  assert.equal(result(o).downloadRequired, true)
})

test('candidate CPU and Metal use direct system budgets with no dedicated VRAM', () => {
  for (const target of [{ platform: 'linux', arch: 'x64', accelerator: 'cpu', unifiedMemory: false },
    { platform: 'darwin', arch: 'arm64', accelerator: 'metal', unifiedMemory: true }]) {
    const o = candidateOptions(), v = o.policy.variants[0]
    Object.assign(v, target); delete v.unifiedMemory
    Object.assign(v.admission, { vramBytes: null, unifiedMemory: target.unifiedMemory })
    Object.assign(o.hardware, target, { cudaDevices: [] })
    assert.equal(result(o).supported, true)
    assert.equal(result(o).requirements.vramBytes, null)
  }
})

test('candidate admission rejects missing provenance, unsafe budgets, ambiguous qualification and unknown fields', () => {
  const mutations = [v => { delete v.admission }, v => { v.evidence = {} },
    v => { v.admission.basisReferences = [] }, v => { v.admission.basisReferences = ['same', 'same'] },
    v => { v.admission.basisReferences = [' '] }, v => { v.admission.reference = '' },
    v => { v.admission.runtimeLockSha256 = 'stale' }, v => { v.admission.runtimeLockSha256 = [lock] }, v => { v.admission.extra = true },
    v => { delete v.admission.downloadBytes }, v => { v.admission.ramBytes = Number.MAX_SAFE_INTEGER + 1 },
    v => { v.admission.ramBytes = 0 }, v => { v.admission.vramBytes = null },
    v => { v.admission.unifiedMemory = true }, v => { v.admission.installedBytes = -1 }]
  for (const mutate of mutations) {
    const o = candidateOptions(); mutate(o.policy.variants[0])
    assert.throws(() => validateHardwarePolicy(o.policy), /Invalid hardware policy/)
  }
})


test('candidate can separately require physical RAM capacity and fresh available RAM', () => {
  const gib = 1024 ** 3
  const o = candidateOptions(), v = o.policy.variants[0]
  Object.assign(v, { platform: 'darwin', arch: 'arm64', accelerator: 'metal' })
  Object.assign(v.admission, { ramBytes: 4 * gib, totalRamBytes: 16 * gib, vramBytes: null, unifiedMemory: true })
  Object.assign(o.hardware, { platform: 'darwin', arch: 'arm64', unifiedMemory: true,
    totalMemoryBytes: 16 * gib, availableMemoryBytes: 5 * gib, cudaDevices: [] })
  for (const phase of ['setup', 'execution']) {
    o.phase = phase
    assert.equal(result(o).supported, true)
    assert.equal(result(o).requirements.totalRamBytes, 16 * gib)
    assert.equal(result(o).requirements.ramBytes, 4 * gib)
  }
  o.hardware.totalMemoryBytes = 8 * gib
  assert.equal(result(o).status, 'insufficient')
  o.hardware.totalMemoryBytes = null
  assert.equal(result(o).status, 'unknown')
  o.hardware.totalMemoryBytes = 16 * gib
  o.hardware.availableMemoryBytes = 4 * gib - 1
  assert.equal(result(o).status, 'insufficient')
  o.hardware.availableMemoryBytes = null
  assert.equal(result(o).status, 'unknown')
  o.hardware.availableMemoryBytes = 5 * gib
  o.releaseChannel = 'public'
  assert.equal(result(o).status, 'unqualified')
  o.releaseChannel = 'private-test'; o.runtimeLockSha256 = 'b'.repeat(64)
  assert.equal(result(o).status, 'unknown')
})

test('optional physical RAM floor must be safe, positive and at least the available floor', () => {
  for (const totalRamBytes of [undefined, null, 0, -1, 124, 125.5, Number.MAX_SAFE_INTEGER + 1, '200']) {
    const o = candidateOptions(); o.policy.variants[0].admission.totalRamBytes = totalRamBytes
    assert.throws(() => validateHardwarePolicy(o.policy), /candidate total RAM budget/)
  }
  const o = candidateOptions()
  assert.equal(result(o).supported, true)
  assert.equal(Object.hasOwn(result(o).requirements, 'totalRamBytes'), false)
  o.hardware.totalMemoryBytes = 124
  assert.equal(result(o).status, 'insufficient')
  const qualified = options()
  assert.equal(Object.hasOwn(result(qualified).requirements, 'totalRamBytes'), false)
})
