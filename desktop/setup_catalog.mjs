// SPDX-License-Identifier: AGPL-3.0-only
import { validateProcessingManifest, validateModelManifest } from './runtime_manager.mjs'

export const SETUP_MODEL_IDS = Object.freeze(['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer'])
const targetKeys = ['platform', 'arch', 'accelerator']
const evidenceReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const nonempty = value => typeof value === 'string' && Boolean(value.trim())
function source(value, local = false) {
  let url
  try { url = new URL(value) } catch { throw new Error('Setup catalog source must be a credential-free HTTPS URL') }
  if (url.username || url.password || url.hash || url.search
      || !(url.protocol === 'https:' || (local && url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')))) {
    throw new Error('Setup catalog source must be credential-free HTTPS without query or fragment; local files require explicit private-test mode')
  }
}

// Memory recommendations are evidence-bound, never inferred from model size or
// successful imports. The release owner supplies measured, representative runs.
export function validateSetupMemory(memory, runtime) {
  if (memory === undefined) return undefined
  if (!memory || memory.runtimeLockSha256 !== runtime.provenance.lockSha256
      || targetKeys.some(key => memory[key] !== runtime[key]) || !memory.ram) {
    throw new Error('Setup memory evidence requires RAM measurements bound to this runtime target')
  }
  const result = Object.fromEntries(['runtimeLockSha256', ...targetKeys].map(key => [key, memory[key]]))
  for (const kind of ['ram', 'vram']) {
    const evidence = memory[kind]
    if (kind === 'vram' && evidence === undefined) continue
    if (!evidence || !Number.isSafeInteger(evidence.measuredPeakBytes) || evidence.measuredPeakBytes <= 0
        || evidence.representativeHardware?.verified !== true || !nonempty(evidence.representativeHardware.description)
        || !evidenceReference(evidence.evidenceReference)) {
      throw new Error(`Setup ${kind} evidence requires a measured peak, verified representative hardware, and opaque evidence reference`)
    }
    const recommendedBytes = Math.ceil(evidence.measuredPeakBytes * 1.25)
    if (!Number.isSafeInteger(recommendedBytes)
        || (evidence.recommendedBytes !== undefined && evidence.recommendedBytes !== recommendedBytes)) {
      throw new Error('Setup memory recommendation must be the measured peak plus 25%')
    }
    result[kind] = { measuredPeakBytes: evidence.measuredPeakBytes, recommendedBytes,
      representativeHardware: { verified: true, description: evidence.representativeHardware.description },
      evidenceReference: evidence.evidenceReference }
  }
  return result
}

// `full` means the complete release qualification passed. `private-smoke`
// means only single-track real-processing smoke evidence passed; it is never
// release qualification and is accepted only by private-test channel builds.
export const QUALIFICATION_SCOPES = Object.freeze(['full', 'private-smoke'])
export const PRIVATE_TEST_CHANNEL = 'private-test'

// Returns the reason a qualification scope is unacceptable for the given
// release channel, or null when it is acceptable. Channels are the validated
// release policy's `channel`; anything other than exactly `private-test`
// (including a missing channel) cannot accept private-smoke evidence.
export function qualificationScopeError(scope, releaseChannel) {
  if (!QUALIFICATION_SCOPES.includes(scope)) {
    return 'Processing setup qualification must state its scope as "full" or "private-smoke"'
  }
  if (scope === 'private-smoke' && releaseChannel !== PRIVATE_TEST_CHANNEL) {
    const channel = typeof releaseChannel === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(releaseChannel) ? `"${releaseChannel}"` : 'missing'
    return `Private-smoke processing qualification is accepted only by "${PRIVATE_TEST_CHANNEL}" channel builds; this build's release channel is ${channel}`
  }
  return null
}

export function validateSetupCatalog(catalog, { identity, trustedLocks, modelPolicy, privateTestLocalSources = false, releaseChannel } = {}) {
  if (!catalog || catalog.schema !== 1 || !catalog.runtime) {
    throw new Error('Processing setup catalog is missing; prepare it with an explicit runtime manifest, qualification evidence, and model terms')
  }
  if (!identity) throw new Error('Setup catalog validation requires the application target identity')
  const runtime = validateProcessingManifest(catalog.runtime, identity, trustedLocks)
  const q = catalog.qualification
  if (runtime.probe.schema !== 2 || !['transcription', 'separation'].every(id => runtime.capabilities.includes(id))
      || !SETUP_MODEL_IDS.every(id => runtime.models.includes(id)
        && runtime.modelCapabilities[id] === (id === 'heart-transcriptor' ? 'transcription' : 'separation'))
      || q?.passed !== true || !evidenceReference(q.evidenceReference) || q.runtimeLockSha256 !== runtime.provenance.lockSha256
      || targetKeys.some(key => q[key] !== runtime[key])) {
    throw new Error('Processing setup requires explicit passed qualification evidence matching the complete runtime lock and target')
  }
  const scopeError = qualificationScopeError(q.scope, releaseChannel)
  if (scopeError) throw new Error(scopeError)
  for (const file of runtime.files) source(file.url, privateTestLocalSources)
  for (const entry of runtime.provenance.packages) source(entry.sourceUrl)
  if (!Array.isArray(catalog.models) || catalog.models.length !== SETUP_MODEL_IDS.length
      || new Set(catalog.models.map(entry => entry?.id)).size !== SETUP_MODEL_IDS.length) {
    throw new Error('Setup catalog must provide model terms for every local processing model exactly once')
  }
  const files = []
  for (const id of SETUP_MODEL_IDS) {
    const entry = catalog.models.find(entry => entry?.id === id)
    if (!entry || !Array.isArray(entry.terms) || !entry.terms.length
        || entry.terms.some(term => !term || !nonempty(term.label))) {
      throw new Error(`Setup catalog requires explicit model terms for ${id}`)
    }
    entry.terms.forEach(term => source(term.url))
    const models = modelPolicy?.models?.filter(model => model.id === id)
    if (models?.length !== 1 || !Array.isArray(models[0].files)) throw new Error(`Application model policy is missing ${id}`)
    files.push(...models[0].files)
  }
  validateModelManifest({ schema: 1, kind: 'models', models: [...SETUP_MODEL_IDS], files }, modelPolicy)
  files.forEach(file => source(file.url))
  const memory = validateSetupMemory(catalog.memory, runtime)
  return { schema: 1, runtime: structuredClone(runtime),
    qualification: Object.fromEntries(['passed', 'scope', 'runtimeLockSha256', ...targetKeys, 'evidenceReference'].map(key => [key, q[key]])),
    models: catalog.models.map(({ id, terms }) => ({ id, terms: terms.map(({ label, url }) => ({ label, url })) })),
    ...(memory ? { memory } : {}) }
}

// This validates the structure of an explicit release-owner attestation, not
// proof that tests actually ran. Evidence references are opaque IDs, not paths.
// This consumes an explicit release-owner attestation. It does not qualify a
// runtime, contact upstreams, retrieve model weights, or grant trust to a lock.
export function createSetupCatalog({ runtime, qualification, models, memory } = {}, options) {
  return validateSetupCatalog({ schema: 1, runtime, qualification, models, ...(memory === undefined ? {} : { memory }) }, options)
}

// The one validation applied to a release-owner catalog shipped inside the
// application: the packaging gate and application start both call this, so the
// catalog a build accepts is exactly the catalog the installed application
// accepts. Production rules only: private-test local sources are never enabled.
export function validateShippedCatalog(text, { identity, trustedLocks, modelPolicy, releaseChannel } = {}) {
  if (typeof text !== 'string') throw new Error('Processing setup catalog must be JSON text')
  let catalog
  try { catalog = JSON.parse(text) } catch (error) { throw new Error(`Processing setup catalog is not JSON: ${error.message}`) }
  return validateSetupCatalog(catalog, { identity, trustedLocks, modelPolicy, releaseChannel, privateTestLocalSources: false })
}
