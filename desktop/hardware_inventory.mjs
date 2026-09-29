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

function electronDevices(info) {
  if (!Array.isArray(info?.gpuDevice)) return []
  return info.gpuDevice.slice(0, 32).filter(device => device && typeof device === 'object').map(device => ({
    name: label(device.deviceString) || label(device.vendorString) || 'Unidentified GPU',
    dedicatedMemoryBytes: null,
  }))
}

function nvidiaDevices(output) {
  if (typeof output !== 'string' || output.length > MAX_OUTPUT) return []
  const lines = output.trim().split(/\r?\n/)
  if (!output.trim() || lines.length > 32) return []
  const result = []
  for (const line of lines) {
    // Reject malformed/unsupported data instead of guessing units or memory.
    const match = /^([^,]+),\s*(\d+)\s*$/.exec(line)
    if (!match) return []
    const memory = bytes(Number(match[2]) * 1024 * 1024)
    if (!memory || !label(match[1])) return []
    result.push({ name: label(match[1]), dedicatedMemoryBytes: memory })
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
  const unifiedMemory = platform === 'darwin' && arch === 'arm64'
  const [gpuInfo, nvidiaOutput] = await Promise.all([
    bounded(getGPUInfo),
    ['linux', 'win32'].includes(platform) ? bounded(() => runCommand('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, shell: false, windowsHide: true, killSignal: 'SIGKILL' })) : null,
  ])
  const gpuDevices = electronDevices(gpuInfo)
  for (const detected of nvidiaDevices(nvidiaOutput)) {
    // A model name alone cannot identify repeated physical devices; consume each
    // unmatched Electron record once and keep distinct adapters distinct.
    const existing = gpuDevices.find(device => device.dedicatedMemoryBytes === null && device.name.toLowerCase() === detected.name.toLowerCase())
    if (existing) existing.dedicatedMemoryBytes = detected.dedicatedMemoryBytes
    else gpuDevices.push(detected)
  }
  return {
    platform, arch,
    cpu: Array.isArray(cpus) ? label(cpus[0]?.model) || 'Unknown' : 'Unknown',
    cpuCount: Array.isArray(cpus) && cpus.length ? cpus.length : null,
    totalMemoryBytes: bytes(safely(() => osAdapter.totalmem())),
    availableMemoryBytes: bytes(safely(() => osAdapter.freemem())),
    gpu: gpuDevices.map(device => device.name).join(', ') || 'Unknown',
    gpuDevices,
    videoMemoryBytes: !unifiedMemory && gpuDevices.length === 1 ? gpuDevices[0].dedicatedMemoryBytes : null,
    unifiedMemory,
    memoryMinimumBytes: null,
  }
}
