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
  assert.deepEqual(validateHardwarePolicy(shipped).variants, [])
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
