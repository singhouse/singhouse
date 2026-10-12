// SPDX-License-Identifier: AGPL-3.0-only
import * as os from 'node:os'
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 1500
const MAX_OUTPUT = 64 * 1024
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : ''
const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const safely = (fn, fallback = null) => { try { return fn() } catch { return fallback } }

// No renderer-supplied executable, arguments, or environment overrides.
function runProbe(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function bounded(fn) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), TIMEOUT_MS) }),
    ])
  } catch { return null } finally { clearTimeout(timer) }
}

function electronDevices(info, integratedGpu = '') {
  const devices = Array.isArray(info?.gpuDevice)
    ? info.gpuDevice.slice(0, 32).filter(device => device && typeof device === 'object') : []
  if (!devices.length && integratedGpu) devices.push({})
  return devices.map(device => ({
    name: label(device.deviceString) || label(device.vendorString) || integratedGpu || 'Unidentified GPU',
    dedicatedMemoryBytes: null, availableMemoryBytes: null,
  }))
}

function nvidiaDevices(output) {
  if (typeof output !== 'string' || output.length > MAX_OUTPUT) return []
  const lines = output.trim().split(/\r?\n/)
  if (!output.trim() || lines.length > 32) return []
  const result = []
  for (const line of lines) {
    // Reject malformed/unsupported data instead of guessing units or memory.
    const match = /^([^,]+),\s*(\d+),\s*(\d+)\s*$/.exec(line)
    if (!match) return []
    const memory = bytes(Number(match[2]) * 1024 * 1024)
    const available = bytes(Number(match[3]) * 1024 * 1024)
    if (!memory || available === null || available > memory || !label(match[1])) return []
    result.push({ name: label(match[1]), dedicatedMemoryBytes: memory, availableMemoryBytes: available })
  }
  return result
}

/** Observed hardware only: no capability promises, minimums, or inference work.
 * getGPUInfo is a zero-argument function returning Electron's basic GPU info.
 * runCommand receives (executable, fixedArguments, execFileOptions), returns stdout.
 * osAdapter supplies cpus/totalmem/freemem; processAdapter supplies platform/arch.
 */
export async function collectHardware({ getGPUInfo = async () => null, osAdapter = os,
  processAdapter = process, runCommand = runProbe } = {}) {
  const platform = label(processAdapter.platform) || 'unknown'
  const arch = label(processAdapter.arch) || 'unknown'
  const cpus = safely(() => osAdapter.cpus(), [])
  const cpu = Array.isArray(cpus) ? label(cpus[0]?.model) || 'Unknown' : 'Unknown'
  const unifiedMemory = platform === 'darwin' && arch === 'arm64'
  // Apple M-series chips include an integrated GPU. Its model is a label only:
  // it does not establish available Metal support, core count, or GPU memory.
  const integratedGpu = unifiedMemory && /^Apple M\d+(?: Pro| Max| Ultra)?$/.test(cpu) ? `${cpu} GPU` : ''
  const [gpuInfo, nvidiaOutput] = await Promise.all([
    bounded(getGPUInfo),
    ['linux', 'win32'].includes(platform) ? bounded(() => runCommand('nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, shell: false, windowsHide: true, killSignal: 'SIGKILL' })) : null,
  ])
  const gpuDevices = electronDevices(gpuInfo, integratedGpu)
  // Keep the NVIDIA driver inventory separate from Chromium's display list.
  // Display names (and other vendors' VRAM) do not establish a CUDA device.
  const cudaDevices = nvidiaDevices(nvidiaOutput)
  for (const detected of cudaDevices) {
    // A model name alone cannot identify repeated physical devices; consume each
    // unmatched Electron record once and keep distinct adapters distinct.
    const existing = gpuDevices.find(device => device.dedicatedMemoryBytes === null && device.name.toLowerCase() === detected.name.toLowerCase())
    if (existing) Object.assign(existing, detected)
    else gpuDevices.push({ ...detected })
  }
  return {
    platform, arch,
    cpu,
    cpuCount: Array.isArray(cpus) && cpus.length ? cpus.length : null,
    totalMemoryBytes: bytes(safely(() => osAdapter.totalmem())),
    availableMemoryBytes: bytes(safely(() => osAdapter.freemem())),
    gpu: gpuDevices.map(device => device.name).join(', ') || 'Unknown',
    gpuDevices,
    cudaDevices,
    videoMemoryBytes: !unifiedMemory && gpuDevices.length === 1 ? gpuDevices[0].dedicatedMemoryBytes : null,
    unifiedMemory,
    memoryMinimumBytes: null,
  }
}
