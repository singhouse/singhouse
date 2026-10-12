// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectHardware } from '../hardware_inventory.mjs'

const osAdapter = { cpus: () => [{ model: 'Test CPU' }, { model: 'Test CPU' }], totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3 }
const base = { osAdapter, processAdapter: { platform: 'linux', arch: 'x64' }, runCommand: async () => { throw new Error('not installed') } }

test('reports observed CPU and RAM while missing GPU and probe remain unknown', async () => {
  const result = await collectHardware(base)
  assert.equal(result.cpu, 'Test CPU')
  assert.equal(result.cpuCount, 2)
  assert.equal(result.totalMemoryBytes, 16 * 1024 ** 3)
  assert.equal(result.availableMemoryBytes, 4 * 1024 ** 3)
  assert.equal(result.gpu, 'Unknown')
  assert.equal(result.videoMemoryBytes, null)
  assert.equal(result.memoryMinimumBytes, null)
})

test('Apple silicon identifies unified memory without claiming RAM as dedicated VRAM', async () => {
  let calls = 0
  const result = await collectHardware({ ...base, processAdapter: { platform: 'darwin', arch: 'arm64' },
    getGPUInfo: async () => ({ gpuDevice: [{ deviceString: 'Apple M4', videoMemory: 123456 }] }),
    runCommand: async () => { calls++; return 'Apple M4, 16384' } })
  assert.equal(calls, 0)
  assert.equal(result.unifiedMemory, true)
  assert.equal(result.gpu, 'Apple M4')
  assert.equal(result.videoMemoryBytes, null)
})

test('Intel Mac and ARM Linux do not imply unified Apple memory', async () => {
  for (const processAdapter of [{ platform: 'darwin', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
    assert.equal((await collectHardware({ ...base, processAdapter })).unifiedMemory, false)
  }
})

test('Apple silicon supplies an integrated GPU label when Electron omits names', async () => {
  for (const cpu of ['Apple M2', 'Apple M4 Pro', 'Apple M3 Max', 'Apple M2 Ultra']) {
    for (const gpuInfo of [null, { gpuDevice: [] }, { gpuDevice: [{ deviceString: '', vendorString: '' }] }]) {
      const result = await collectHardware({ ...base,
        processAdapter: { platform: 'darwin', arch: 'arm64' },
        osAdapter: { ...osAdapter, cpus: () => [{ model: cpu }] },
        getGPUInfo: async () => gpuInfo })
      assert.equal(result.gpu, `${cpu} GPU`)
      assert.deepEqual(result.gpuDevices, [{ name: `${cpu} GPU`, dedicatedMemoryBytes: null, availableMemoryBytes: null }])
      assert.equal(result.unifiedMemory, true)
      assert.equal(result.videoMemoryBytes, null)
      assert.equal(result.memoryMinimumBytes, null)
      assert.deepEqual(result.cudaDevices, [])
    }
  }
})

test('Apple GPU fallback preserves Electron labels and requires an observed Apple chip', async () => {
  const apple = { ...base, processAdapter: { platform: 'darwin', arch: 'arm64' },
    osAdapter: { ...osAdapter, cpus: () => [{ model: 'Apple M2' }] } }
  for (const device of [{ deviceString: 'Observed GPU' }, { vendorString: 'Observed Vendor' }]) {
    const result = await collectHardware({ ...apple, getGPUInfo: async () => ({ gpuDevice: [device] }) })
    assert.equal(result.gpu, device.deviceString || device.vendorString)
  }
  for (const options of [
    { processAdapter: { platform: 'darwin', arch: 'x64' } },
    { processAdapter: { platform: 'linux', arch: 'arm64' } },
    { osAdapter },
    { osAdapter: { ...osAdapter, cpus: () => null } },
  ]) {
    const result = await collectHardware({ ...apple, ...options, getGPUInfo: async () => ({ gpuDevice: [{}] }) })
    assert.equal(result.gpu, 'Unidentified GPU')
  }
})

test('NVIDIA probe uses bounded fixed execFile arguments on Windows and Linux', async () => {
  for (const platform of ['linux', 'win32']) {
    const result = await collectHardware({ ...base, processAdapter: { platform, arch: 'x64' },
      getGPUInfo: async () => ({ gpuDevice: [{ deviceString: 'NVIDIA Test GPU' }] }),
      runCommand: async (file, args, options) => {
        assert.equal(file, 'nvidia-smi')
        assert.deepEqual(args, ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])
        assert.equal(options.shell, false)
        assert.equal(options.timeout, 1500)
        assert.equal(options.maxBuffer, 65536)
        assert.equal(options.killSignal, 'SIGKILL')
        return 'NVIDIA Test GPU, 8192, 2048\n'
      } })
    assert.equal(result.videoMemoryBytes, 8 * 1024 ** 3)
    assert.equal(result.gpuDevices.length, 1)
    assert.equal(result.cudaDevices[0].availableMemoryBytes, 2 * 1024 ** 3)
  }
})

test('multiple adapters never add their VRAM into a fictional single GPU', async () => {
  const result = await collectHardware({ ...base, runCommand: async () => 'NVIDIA Test GPU, 8192, 2048\nNVIDIA Test GPU, 8192, 2048\n' })
  assert.equal(result.gpuDevices.length, 2)
  assert.equal(result.videoMemoryBytes, null)
  assert.equal(result.gpuDevices[0].dedicatedMemoryBytes, 8 * 1024 ** 3)
})

test('malformed or oversized probe data never becomes measured VRAM', async () => {
  for (const output of ['name, N/A', 'name, -1', 'name, 8 GB', 'name, 9007199254740991', 'name, 8\nbad', 'x'.repeat(65537), { stdout: 'name, 8' }]) {
    const result = await collectHardware({ ...base, runCommand: async () => output })
    assert.equal(result.videoMemoryBytes, null)
    assert.deepEqual(result.gpuDevices, [])
  }
})

test('optional adapter failures and malformed Electron records return safe unknown values', async () => {
  const result = await collectHardware({ ...base, osAdapter: { cpus: () => null, totalmem: () => -1, freemem: () => { throw Error('unavailable') } },
    getGPUInfo: async () => ({ gpuDevice: [null, { deviceString: {}, vendorString: 'Vendor\nName' }] }) })
  assert.equal(result.cpuCount, null)
  assert.equal(result.totalMemoryBytes, null)
  assert.equal(result.availableMemoryBytes, null)
  assert.equal(result.gpu, 'Vendor Name')
  assert.equal((await collectHardware({ ...base, getGPUInfo: async () => { throw Error('GPU failed') } })).gpu, 'Unknown')
})

test('unresponsive injected providers cannot indefinitely block onboarding', async () => {
  const result = await collectHardware({ ...base, getGPUInfo: () => new Promise(() => {}), runCommand: () => new Promise(() => {}) })
  assert.equal(result.gpu, 'Unknown')
  assert.equal(result.videoMemoryBytes, null)
})

test('CUDA inventory comes from NVIDIA driver results, not generic display names', async () => {
  const getGPUInfo = async () => ({ gpuDevice: [{ deviceString: 'AMD Display' }, { deviceString: 'NVIDIA Test GPU' }] })
  const noDriver = await collectHardware({ ...base, getGPUInfo })
  assert.deepEqual(noDriver.cudaDevices, [])
  const detected = await collectHardware({ ...base, getGPUInfo, runCommand: async () => 'NVIDIA Test GPU, 4096, 1024\n' })
  assert.equal(detected.gpuDevices.length, 2)
  assert.deepEqual(detected.cudaDevices, [{ name: 'NVIDIA Test GPU', dedicatedMemoryBytes: 4 * 1024 ** 3, availableMemoryBytes: 1024 ** 3 }])
  assert.equal(detected.videoMemoryBytes, null)
})

test('multiple NVIDIA cards remain distinct CUDA observations with no chosen adapter', async () => {
  const result = await collectHardware({ ...base,
    runCommand: async () => 'NVIDIA Small, 4096, 1024\nNVIDIA Large, 24576, 8192\n' })
  assert.deepEqual(result.cudaDevices.map(device => device.dedicatedMemoryBytes), [4 * 1024 ** 3, 24 * 1024 ** 3])
  assert.equal(result.videoMemoryBytes, null)
})

test('available VRAM is observed independently and impossible driver values stay unknown', async () => {
  for (const output of ['GPU, 8192, 8193', 'GPU, 8192, N/A', 'GPU, 8192', 'GPU, 8192, -1']) {
    assert.deepEqual((await collectHardware({ ...base, runCommand: async () => output })).cudaDevices, [])
  }
  const result = await collectHardware({ ...base, runCommand: async () => 'GPU, 8192, 0' })
  assert.equal(result.cudaDevices[0].availableMemoryBytes, 0)
  assert.equal(result.cudaDevices[0].dedicatedMemoryBytes, 8 * 1024 ** 3)
})
