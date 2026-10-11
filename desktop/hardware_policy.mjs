// SPDX-License-Identifier: AGPL-3.0-only
// Release-owned selection data only. No discovery, downloads, or execution occurs here.
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const positive = value => count(value) && value > 0
const duration = value => Number.isFinite(value) && value > 0
const fail = message => { throw new Error(`Invalid hardware policy: ${message}`) }
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const unique = values => new Set(values).size === values.length

export function validateHardwarePolicy(value) {
  if (!value || value.schema !== 1 || !id(value.version) || !Array.isArray(value.recipes) || !Array.isArray(value.variants)) fail('schema or version')
  if (!value.recipes.length || value.recipes.length > 64 || value.variants.length > 256) fail('catalog size')
  for (const recipe of value.recipes) {
    if (!id(recipe.id) || !nonempty(recipe.label) || !Array.isArray(recipe.modelIds) || !recipe.modelIds.length || !recipe.modelIds.every(id) || !unique(recipe.modelIds)) fail('recipe')
  }
  if (!unique(value.recipes.map(r => r.id)) || !unique(value.variants.map(v => v.id))) fail('duplicate IDs')
  for (const v of value.variants) {
    if (!id(v.id) || !nonempty(v.label) || !value.recipes.some(r => r.id === v.recipeId)
        || !['linux', 'win32', 'darwin'].includes(v.platform) || !['x64', 'arm64'].includes(v.arch)
        || !['cpu', 'cuda', 'metal'].includes(v.accelerator) || !count(v.priority)) fail('variant target')
    if (v.accelerator === 'metal' && (v.platform !== 'darwin' || v.arch !== 'arm64')) fail('Metal target')
    if (!['qualified', 'unqualified'].includes(v.status) || !nonempty(v.qualityTradeoff)) fail('variant status or quality')
    if (!v.settings || typeof v.settings !== 'object' || Array.isArray(v.settings)
        || Object.values(v.settings).some(x => !['string', 'number', 'boolean'].includes(typeof x) || (typeof x === 'number' && !Number.isFinite(x)))) fail('settings')
    if (v.status === 'unqualified') {
      if (!nonempty(v.reason)) fail('unqualified reason')
      continue
    }
    const e = v.evidence
    if (!e || !/^[a-f0-9]{64}$/.test(e.runtimeLockSha256) || !nonempty(e.reference)
        || !['full', 'private-smoke'].includes(e.scope) || !nonempty(e.workload)
        || !Number.isFinite(e.headroomFraction) || e.headroomFraction < 0 || e.headroomFraction > 10) fail('qualification evidence')
    for (const key of ['peakRamBytes', 'workingDiskBytes', 'downloadBytes', 'installedBytes']) if (!positive(e[key])) fail(key)
    if (!Number.isSafeInteger(Math.ceil(e.peakRamBytes * (1 + e.headroomFraction)))) fail('RAM overflow')
    if (v.accelerator === 'cuda' && (!positive(e.peakVramBytes) || !Number.isSafeInteger(Math.ceil(e.peakVramBytes * (1 + e.headroomFraction))))) fail('VRAM evidence')
    if (v.accelerator !== 'cuda' && e.peakVramBytes !== null) fail('dedicated VRAM for non-CUDA target')
    if (!e.pipeline || !['separation', 'transcription', 'alignment'].every(key => e.pipeline[key] === true)
        || !e.timings || !duration(e.timings.coldSeconds) || !duration(e.timings.warmSeconds)
        || !nonempty(e.qualityComparison)) fail('end-to-end timing and quality evidence')
    if (typeof e.unifiedMemory !== 'boolean' || e.unifiedMemory !== (v.platform === 'darwin' && v.arch === 'arm64')) fail('memory architecture')
  }
  return structuredClone(value)
}

function assessVariant(v, recipe, options) {
  const { hardware = {}, runtimeLockSha256, diskFreeBytes, phase = 'setup', releaseChannel = 'public' } = options
  const installed = new Set(options.installedModelIds || [])
  const missingModelIds = recipe.modelIds.filter(model => !installed.has(model))
  const result = { id: v.id, label: v.label, recipeId: v.recipeId, status: 'unknown', supported: false,
    reason: '', requirements: null, missingModelIds, downloadRequired: missingModelIds.length > 0,
    qualityTradeoff: v.qualityTradeoff, settings: structuredClone(v.settings) }
  const deny = (status, reason) => ({ ...result, status, reason })
  if (Object.keys(v.settings).length) return deny('unsupported', 'This processing variant requests settings that this version cannot apply.')
  if (options.accelerator && v.accelerator !== options.accelerator) return deny('unsupported', 'This variant requires a different processing accelerator.')
  if (v.status !== 'qualified') return deny('unqualified', v.reason)
  if (v.platform !== hardware.platform || v.arch !== hardware.arch) return deny('unsupported', 'This variant was qualified for a different platform or architecture.')
  const e = v.evidence
  if (e.runtimeLockSha256 !== runtimeLockSha256) return deny('unknown', 'Memory evidence does not match the selected processing runtime.')
  if (e.scope !== 'full' && releaseChannel !== 'private-test') return deny('unqualified', 'This variant has not passed public release qualification.')
  if (e.unifiedMemory !== hardware.unifiedMemory) return deny('unknown', 'The observed memory architecture does not match the evidence.')
  const ramBytes = Math.ceil(e.peakRamBytes * (1 + e.headroomFraction))
  const vramBytes = v.accelerator === 'cuda' ? Math.ceil(e.peakVramBytes * (1 + e.headroomFraction)) : null
  result.requirements = { ramBytes, vramBytes, unifiedMemory: e.unifiedMemory, headroomFraction: e.headroomFraction,
    transferBytes: e.downloadBytes, installedBytes: e.installedBytes, workingDiskBytes: e.workingDiskBytes,
    evidenceReference: e.reference, workload: e.workload }
  if (!count(hardware.totalMemoryBytes)) return deny('unknown', 'Total system memory could not be measured.')
  if (hardware.totalMemoryBytes < ramBytes) return deny('insufficient', 'Total system memory is below the measured requirement including headroom.')
  if (!count(hardware.availableMemoryBytes)) return deny('unknown', 'Currently available system memory could not be measured.')
  if (hardware.availableMemoryBytes < ramBytes) return deny('insufficient', 'Currently available system memory is below the measured requirement. Close other applications and retry.')
  if (v.accelerator === 'cuda') {
    const devices = hardware.cudaDevices
    if (hardware.unifiedMemory || !Array.isArray(devices) || devices.length !== 1 || !count(devices[0].dedicatedMemoryBytes)) return deny('unknown', 'An unambiguous CUDA device and its dedicated memory could not be measured.')
    if (devices[0].dedicatedMemoryBytes < vramBytes) return deny('insufficient', 'Dedicated GPU memory is below the measured requirement including headroom.')
    if (phase === 'execution') {
      if (!count(devices[0].availableMemoryBytes)) return deny('unknown', 'Currently available CUDA memory could not be measured.')
      if (devices[0].availableMemoryBytes < vramBytes) return deny('insufficient', 'Currently available CUDA memory is below the measured requirement. Close GPU applications and retry.')
    }
  }
  if (!count(diskFreeBytes)) return deny('unknown', 'Available storage could not be measured.')
  const diskRequired = e.workingDiskBytes + (missingModelIds.length ? e.installedBytes + e.downloadBytes : 0)
  if (!Number.isSafeInteger(diskRequired)) return deny('unknown', 'Storage requirements exceed supported accounting limits.')
  result.requirements.diskRequiredBytes = diskRequired
  if (diskFreeBytes < diskRequired) return deny('insufficient', 'Available storage is below the required installation and processing space.')
  if (phase === 'execution' && missingModelIds.length) return deny('setup-required', 'Required models are missing. Review setup and consent before downloading them.')
  return { ...result, status: 'supported', supported: true, reason: 'Observed resources meet the measured requirements for this variant.' }
}

/** Manual overrides select only qualified, resource-supported variants. Caller must
 * obtain fresh observations for execution and separately enforce setup consent. */
export function assessHardwarePolicy(options) {
  const policy = validateHardwarePolicy(options.policy)
  if (!['setup', 'execution'].includes(options.phase || 'setup')) throw new Error('Invalid assessment phase')
  const recipeId = options.recipeId || policy.recipes[0].id
  const recipe = policy.recipes.find(r => r.id === recipeId)
  if (!recipe) throw new Error('Unknown processing recipe')
  const variants = policy.variants.filter(v => v.recipeId === recipeId)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map(v => assessVariant(v, recipe, options))
  if (options.variantId && !variants.some(v => v.id === options.variantId)) throw new Error('Unknown processing variant')
  const selected = options.variantId ? variants.find(v => v.id === options.variantId && v.supported) : variants.find(v => v.supported)
  return { policyVersion: policy.version, recipeId, mode: options.variantId ? 'manual' : 'automatic',
    selectedVariantId: selected?.id || null, status: selected ? 'supported' : 'unavailable', variants,
    reason: selected?.reason || (options.variantId ? 'The selected variant is not currently supported. Choose a supported variant or review setup.' : 'No qualified variant meets the observed resources. Playback remains available.'),
    downloadAuthorized: false }
}

/** Suggestions only: never silently change quality, start downloads, or retry jobs. */
export function recoveryOptions(options) {
  const assessment = assessHardwarePolicy({ ...options, phase: 'execution', variantId: undefined })
  return { policyVersion: assessment.policyVersion, retryRequiresUserAction: true, downloadAuthorized: false,
    actions: ['close-other-applications', 'free-storage', 'review-setup', 'use-playback'],
    alternatives: assessment.variants.filter(v => v.supported && v.id !== options.variantId)
      .map(v => ({ variantId: v.id, qualityTradeoff: v.qualityTradeoff, requiresConfirmation: true })) }
}
