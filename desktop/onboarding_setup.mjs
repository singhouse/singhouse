// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { checkedFile, processingAttestation } from './runtime_manager.mjs'
import { QUALIFICATION_SCOPES, qualificationScopeError, qualificationStatusMatches, validateSetupMemory } from './setup_catalog.mjs'

export const LOCAL_MODEL_IDS = Object.freeze(['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = manifest => manifest.files.reduce((sum, file) => sum + file.size, 0)
const complete = manifest => ['transcription', 'separation'].every(id => manifest.capabilities?.includes(id))
  && LOCAL_MODEL_IDS.every(id => manifest.models?.includes(id)
    && manifest.modelCapabilities?.[id] === (id === 'heart-transcriptor' ? 'transcription' : 'separation'))
const NVIDIA_REQUIRED = 'Local processing in this build requires an NVIDIA GPU with a current driver, and none was detected on this computer. You can still play your existing karaoke files.'
// The accelerator of the runtime a plan installs or uses, for wizard wording only.
const planAccelerator = runtime => ['cpu', 'cuda', 'metal'].includes(runtime?.accelerator) ? runtime.accelerator : null
const REOPEN_MESSAGE = 'Setup is verified. Reopen singhouse to use local processing.'
const initial = () => ({ state: 'idle', phase: 'preflight', message: 'Choose local processing or playback.', retryable: false, restartRequired: false })

// These checks compare observations with measured release evidence. They do not
// establish GPU compatibility or promise a runtime will fit every possible job.
function memoryAssessment(catalog, runtime, hardware) {
  const requirements = { ramBytes: null, dedicatedVideoMemoryBytes: null,
    unifiedMemory: hardware.unifiedMemory === true, evidenceAvailable: false }
  const qualification = { status: 'unknown', reason: null, warnings: [] }
  const result = { memoryRequirements: requirements, memoryQualification: qualification, blocked: false }
  if (catalog?.memory === undefined) {
    qualification.reason = 'This release has no measured memory requirements; memory suitability is unknown.'
    return result
  }
  let memory
  try { memory = validateSetupMemory(catalog.memory, runtime) }
  catch {
    qualification.reason = 'The memory measurements do not match this processing runtime. Use a release with matching memory evidence.'
    return { ...result, blocked: true }
  }
  requirements.evidenceAvailable = true
  requirements.ramBytes = memory.ram.recommendedBytes
  requirements.dedicatedVideoMemoryBytes = memory.vram?.recommendedBytes ?? null
  if (['platform', 'arch'].some(key => hardware[key] !== memory[key])) {
    qualification.reason = 'The measured memory requirements do not match the observed computer target.'
    return { ...result, blocked: true }
  }
  const observed = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const total = observed(hardware.totalMemoryBytes)
  const available = observed(hardware.availableMemoryBytes)
  if (available !== null && available < requirements.ramBytes) {
    qualification.warnings.push('Available RAM is currently below the measured recommendation. Close other applications before processing; available RAM changes over time.')
  }
  if (total === null) {
    qualification.reason = 'Total RAM could not be verified against the measured requirement.'
    return { ...result, blocked: true }
  }
  if (total < requirements.ramBytes) {
    qualification.status = 'insufficient'
    qualification.reason = 'This computer has less total RAM than the measured requirement plus 25% headroom.'
    return { ...result, blocked: true }
  }
  const cudaTarget = memory.accelerator === 'cuda'
  const adapters = cudaTarget ? hardware.cudaDevices : hardware.gpuDevices
  if (cudaTarget && (!Array.isArray(adapters) || adapters.length !== 1 || hardware.unifiedMemory === true)) {
    qualification.reason = 'Dedicated video memory could not be verified for an unambiguous CUDA device. The processing device is unknown; other adapters and Unified system memory cannot establish its VRAM capacity.'
    return { ...result, blocked: true }
  }
  if (memory.vram) {
    // Neither display adapters nor the largest of several CUDA cards identify
    // the device the worker will use. Require one observed device in the
    // relevant driver inventory; never substitute a summed/maximum flat value.
    const dedicated = hardware.unifiedMemory === true || !Array.isArray(adapters) || adapters.length !== 1
      ? null : observed(adapters[0]?.dedicatedMemoryBytes)
    if (dedicated === null) {
      qualification.reason = 'Dedicated video memory could not be verified. Unified system memory does not establish dedicated VRAM capacity.'
      return { ...result, blocked: true }
    }
    if (dedicated < memory.vram.recommendedBytes) {
      qualification.status = 'insufficient'
      qualification.reason = 'The observed processing GPU has less dedicated video memory than the measured requirement plus 25% headroom.'
      return { ...result, blocked: true }
    }
  }
  qualification.status = 'meets-measured-requirements'
  qualification.reason = 'Observed memory meets the measured requirements for this release target; this is not a GPU compatibility guarantee.'
  return result
}

// Catalog, policy, and qualification are release-owned inputs. Never populate
// these from renderer messages, persisted progress, or an unsigned remote feed.
export class OnboardingSetup {
  #offlineModelsDirectory = null

  setOfflineModelsDirectory(directory) {
    if (this.operation) throw new Error('Wait for the current setup operation before changing the model source.')
    if (directory !== null && (typeof directory !== 'string' || !isAbsolute(directory))) {
      throw new Error('Select an absolute model folder using the desktop picker.')
    }
    this.#offlineModelsDirectory = directory === null ? null : resolve(directory)
  }

  // releaseChannel is the validated release policy's channel; it decides
  // whether private-smoke or hardware-test qualification is acceptable.
  constructor({ runtime, cache, policy, catalog = null, catalogError = null, releaseChannel, hardware = async () => ({}), diskFree,
    loaded = {}, load = async () => null, save = async () => {}, notify = () => {} }) {
    Object.assign(this, { runtime, cache, policy, catalogError, releaseChannel, hardware, diskFree, loaded, load, save, notify })
    this.catalog = catalog && structuredClone(catalog)
    this.state = initial()
    this.operation = null
    this.controller = null
    this.restoring = null
    this.check = null
  }

  async getStatus() {
    // Every early caller waits for the same checkpoint read.
    this.restoring ??= this.restore()
    await this.restoring
    return structuredClone(this.state)
  }

  async restore() {
    let previous = null
    // An unreadable checkpoint is treated as none.
    try { previous = await this.load() } catch { /* start from idle */ }
    // A checkpoint records workflow only; it never supplies runnable inputs
    // or proves readiness. Every attempt revalidates the stores and catalog.
    // A finished, verified run awaiting reopening, or a failed re-check of
    // one, is only checked again: the next preflight settles it from live
    // verification. It is not saved, so an exit while checking leaves the
    // checkpoint to be checked again.
    if (previous?.state === 'restart-required' || (previous?.state === 'error' && previous.phase === 'verification')) {
      this.state = { ...initial(), state: 'checking', phase: 'verification', message: 'Checking your local processing setup…' }
    } else if (previous && ['running', 'error', 'cancelled'].includes(previous.state)) {
      this.state = { ...initial(), state: 'cancelled', message: 'Setup was interrupted. Retry to verify and resume saved files.', retryable: true }
    }
  }

  // The scope the wizard labels, carried on the preflight plan only: only a
  // scope this build accepts is reported, so the label can never describe a
  // catalog that selection would refuse.
  qualificationScope() {
    const scope = this.catalog?.qualification?.scope
    return !this.catalogError && QUALIFICATION_SCOPES.includes(scope) && !qualificationScopeError(scope, this.releaseChannel) ? scope : null
  }

  async update(values) {
    this.state = { ...this.state, ...values }
    await this.save({ schema: 1, state: this.state.state, phase: this.state.phase })
    this.notify(structuredClone(this.state))
    return this.getStatus()
  }

  async installed({ signal } = {}) {
    signal?.throwIfAborted()
    const [runtime, models] = await Promise.all([this.runtime.active().catch(() => null), this.cache.active().catch(() => null)])
    signal?.throwIfAborted()
    let functional = false
    if (runtime && complete(runtime.manifest)) {
      try { functional = processingAttestation(runtime, await this.runtime.probe(runtime, { signal })).capabilitiesReady === true }
      catch { /* Failed or import-only probes never satisfy local readiness. */ }
    }
    signal?.throwIfAborted()
    const installed = functional && LOCAL_MODEL_IDS.every(id => models?.manifest.models.includes(id))
    const ready = installed && this.loaded.runtimeId === runtime.id && this.loaded.modelsId === models.id
    return { runtime, models, installed, ready, restartRequired: installed && !ready }
  }

  selection(active) {
    if (this.catalogError) throw new Error(this.catalogError)
    const catalog = this.catalog
    if (!catalog || catalog.schema !== 1 || !catalog.runtime) throw new Error('Local song processing is not available in this version yet. You can still play your existing karaoke files.')
    const runtime = this.runtime.validate(structuredClone(catalog.runtime))
    const q = catalog.qualification
    if (!complete(runtime) || runtime.probe.schema !== 2 || !qualificationStatusMatches(q)
        || q.runtimeLockSha256 !== runtime.provenance.lockSha256 || qualificationScopeError(q.scope, this.releaseChannel)
        || ['platform', 'arch', 'accelerator'].some(key => q[key] !== runtime[key])) {
      throw new Error('Local song processing is not available in this version yet. Its processing tools still need to pass the required checks.')
    }
    const ids = [...new Set([...(active?.manifest.models || []), ...LOCAL_MODEL_IDS])]
    const entries = ids.map(id => {
      const entry = this.policy.models.find(model => model.id === id)
      const terms = catalog.models?.find(model => model.id === id)?.terms
      if (!entry || !Array.isArray(terms) || !terms.length || terms.some(term => {
        try { return !term.label?.trim() || new URL(term.url).protocol !== 'https:' } catch { return true }
      })) throw new Error(`Local setup cannot continue because source and terms information is missing for ${id}.`)
      return { ...entry, terms }
    })
    const models = this.cache.validate({ schema: 1, kind: 'models', models: ids, files: entries.flatMap(entry => entry.files) })
    return { runtime, models, entries }
  }

  async inspectOfflineModels(manifest, directory, signal, verifyContents = false) {
    // This read-only inspection is advisory. ModelCache reopens and validates
    // every source through held descriptors at installation time.
    try {
      const selected = await lstat(directory)
      if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('unsafe directory')
      const root = await realpath(directory)
      const canonical = await lstat(root)
      if (!canonical.isDirectory() || canonical.isSymbolicLink()
          || canonical.ino !== selected.ino || canonical.dev !== selected.dev) throw new Error('directory changed')
      for (const record of manifest.files) {
        signal?.throwIfAborted()
        let ancestor = dirname(join(root, record.path))
        for (;;) {
          const info = await lstat(ancestor)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe ancestor')
          if (dirname(ancestor) === ancestor) break
          ancestor = dirname(ancestor)
        }
        const source = await checkedFile(join(root, record.path), constants.O_RDONLY)
        try {
          if ((await source.stat()).size !== record.size) throw new Error('size mismatch')
          // The chooser stays responsive: multi-GB checksum reads belong to
          // the cancellable operation, then ModelCache revalidates activation.
          if (!verifyContents) continue
          const digest = createHash('sha256')
          for await (const chunk of source.createReadStream({ autoClose: false, signal })) {
            signal?.throwIfAborted()
            digest.update(chunk)
          }
          if (digest.digest('hex') !== record.sha256) throw new Error('checksum mismatch')
        } finally { await source.close() }
      }
    } catch (error) {
      signal?.throwIfAborted()
      // OS errors contain private paths; none cross the setup DTO boundary.
      throw new Error('The selected model folder is incomplete, unsafe, or does not match the release checksums. Choose the complete folder and retry.')
    }
  }

  // Settles a restored check from this live verification only. A started
  // setup takes precedence over the outcome.
  async settleCheck(installed) {
    if (this.state.state !== 'checking') return
    if (installed?.ready) {
      await this.update({ state: 'ready', phase: 'complete', message: 'Local processing is ready.', restartRequired: false })
    } else if (installed?.restartRequired) {
      await this.update({ state: 'restart-required', phase: 'complete', message: REOPEN_MESSAGE, restartRequired: true })
    } else {
      const message = 'Review setup to check and repair the installation.'
      await this.update({ state: 'error', phase: 'verification', message, error: message, retryable: true, restartRequired: false })
    }
  }

  async preflight({ signal } = {}) {
    await this.getStatus()
    const offlineDirectory = this.#offlineModelsDirectory
    const modelSource = offlineDirectory === null ? 'upstream' : 'offline'
    let installed
    if (this.state.state === 'checking') {
      // Concurrent preflights during a check share one live verification;
      // each still builds its own plan from the shared result.
      this.check ??= this.installed().then(
        async result => { await this.settleCheck(result); return result },
        async error => { await this.settleCheck(null); throw error },
      ).finally(() => { this.check = null })
      installed = await this.check
      signal?.throwIfAborted()
    } else installed = await this.installed({ signal })
    const hardware = await this.hardware()
    signal?.throwIfAborted()
    const memory = memoryAssessment(this.catalog, installed.installed ? installed.runtime.manifest : this.catalog?.runtime, hardware)
    const { blocked: memoryBlocked, ...memoryFields } = memory
    const base = { ...memoryFields, available: false, ready: installed.ready, restartRequired: installed.restartRequired, hardware,
      qualificationScope: this.qualificationScope(), accelerator: planAccelerator(installed.installed ? installed.runtime.manifest : this.catalog?.runtime), modelSource, runtimeTransferRequired: false, components: [], diskRequiredBytes: 0, diskFreeBytes: null }
    if (installed.installed) return { ...base, available: true, planId: hash([installed.runtime.id, installed.models.id, modelSource, offlineDirectory]), components: [] }
    try {
      const selected = this.selection(installed.models)
      // A CUDA pack activates only after its CUDA device check passes, so never
      // offer its multi-GB download to a computer with no NVIDIA driver inventory.
      if (selected.runtime.accelerator === 'cuda' && !(Array.isArray(hardware.cudaDevices) && hardware.cudaDevices.length)) {
        return { ...base, reason: NVIDIA_REQUIRED }
      }
      if (memoryBlocked) return { ...base, reason: memory.memoryQualification.reason }
      const runtimeNeeded = installed.runtime?.id !== hash(selected.runtime)
      const modelsNeeded = installed.models?.id !== hash(selected.models)
      if (modelsNeeded && offlineDirectory !== null) await this.inspectOfflineModels(selected.models, offlineDirectory, signal)
      // Archive-form runtimes transfer their compressed parts, then extract the
      // full uncompressed tree; per-file runtimes transfer the tree itself.
      const runtimeParts = selected.runtime.archive?.parts
      const runtimeInstalledBytes = runtimeNeeded ? bytes(selected.runtime) : 0
      const runtimeBytes = !runtimeNeeded ? 0 : runtimeParts ? runtimeParts.reduce((sum, part) => sum + part.size, 0) : runtimeInstalledBytes
      const modelBytes = modelsNeeded ? bytes(selected.models) : 0
      // Never weaker than the reservation each installer makes. A per-file
      // runtime and the models need their staged copy plus the activated tree
      // (bytes * 2). An archive runtime needs every part (none are assumed to
      // be retrieved yet) plus the uncompressed tree. Each install adds 64 MiB.
      // Conservative: existing model files are reused, but their staged copies
      // still need space.
      const runtimeReserve = !runtimeNeeded ? 0 : runtimeParts ? runtimeBytes + runtimeInstalledBytes : runtimeInstalledBytes * 2
      const diskRequiredBytes = runtimeReserve + modelBytes * 2 + (Number(runtimeNeeded) + Number(modelsNeeded)) * 64 * 1024 * 1024
      const diskFreeBytes = this.diskFree ? await this.diskFree() : null
      signal?.throwIfAborted()
      const runtimeSources = runtimeParts ? runtimeParts.map(part => part.url) : selected.runtime.files.map(file => file.url)
      const components = [
        ...(runtimeNeeded ? [{ label: 'Local processing runtime', bytes: runtimeBytes, installedBytes: runtimeInstalledBytes, sourceMode: 'catalog',
          sources: [...new Set(runtimeSources.map(url => new URL(url).origin))],
          terms: selected.runtime.provenance.packages.map(p => ({ label: `${p.name}: ${p.license}`, url: p.sourceUrl })) }] : []),
        ...selected.entries.map(entry => ({ label: entry.id, sourceMode: modelSource, bytes: installed.models?.manifest.models.includes(entry.id) ? 0 : bytes(entry),
          sources: offlineDirectory === null ? [...new Set(entry.files.map(file => new URL(file.url).origin))] : ['Selected model folder'], terms: entry.terms })),
      ]
      const planId = hash([selected.runtime, selected.models, components, modelSource, offlineDirectory, memory.memoryRequirements])
      const result = { ...base, planId, components, diskRequiredBytes, diskFreeBytes, runtimeTransferRequired: runtimeNeeded }
      if (!Number.isSafeInteger(diskFreeBytes) || diskFreeBytes < diskRequiredBytes) {
        return { ...result, reason: diskFreeBytes === null ? 'Available disk space could not be checked.' : 'Not enough free disk space for complete local setup.' }
      }
      return { ...result, available: true }
    } catch (error) { signal?.throwIfAborted(); return { ...base, reason: error.message } }
  }

  async start({ consent, planId } = {}) {
    await this.getStatus()
    if (this.operation) return this.getStatus()
    if (consent !== true) return this.getStatus()
    // Reserve immediately, before preflight yields, so concurrent starts share
    // the same attempt and cannot open two installs.
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.operation = this.run(planId, signal).finally(() => { this.operation = null; this.controller = null })
    return this.getStatus()
  }

  cancel() { this.controller?.abort() }

  async run(planId, signal) {
    const originalRuntimeProgress = this.runtime.progress, originalModelProgress = this.cache.progress
    try {
      await this.update({ state: 'running', phase: 'preflight', message: 'Verifying the complete local setup.', error: undefined, progress: undefined, retryable: false })
      const plan = await this.preflight({ signal })
      signal.throwIfAborted()
      if (!plan.available) throw new Error(plan.reason)
      if (plan.planId !== planId) throw new Error('The setup plan changed. Review the complete installation plan again.')
      if (!plan.ready && !plan.restartRequired) {
        const active = await this.installed({ signal })
        const selected = this.selection(active.models)
        if (this.#offlineModelsDirectory !== null && active.models?.id !== hash(selected.models)) {
          await this.update({ phase: 'verification', message: 'Verifying your selected model files.' })
          await this.inspectOfflineModels(selected.models, this.#offlineModelsDirectory, signal, true)
        }
        for (const [phase, manager, manifest, existing] of [
          ['runtime', this.runtime, selected.runtime, active.runtime], ['models', this.cache, selected.models, active.models],
        ]) {
          signal.throwIfAborted()
          if (existing?.id === hash(manifest)) continue
          await this.update({ phase, message: phase === 'runtime' ? 'Installing the local processing runtime.' : 'Installing separation and Heart model files.' })
          manager.progress = progress => { this.state.progress = progress; this.notify(structuredClone(this.state)) }
          if (phase === 'models' && this.#offlineModelsDirectory !== null) {
            try { await this.cache.installFromDirectory(manifest, this.#offlineModelsDirectory, { prefix: '', signal }) }
            catch (error) {
              signal.throwIfAborted()
              throw new Error('Offline model installation failed. Verify the selected folder and retry; no model downloads were attempted.')
            }
          } else await manager.install(manifest, { signal })
        }
      }
      signal.throwIfAborted()
      await this.update({ phase: 'verification', message: 'Verifying all local processing components.', progress: undefined })
      const result = await this.installed({ signal })
      signal.throwIfAborted()
      if (!result.installed) throw new Error('Complete local processing verification failed. Retry setup to repair the saved files.')
      await this.update({ state: result.ready ? 'ready' : 'restart-required', phase: 'complete',
        message: result.ready ? 'Local processing is ready.' : REOPEN_MESSAGE, restartRequired: result.restartRequired })
    } catch (error) {
      await this.update({ state: signal.aborted ? 'cancelled' : 'error', phase: 'paused', progress: undefined,
        message: signal.aborted ? 'Setup cancelled. Retry to resume saved files.' : error.message,
        error: signal.aborted ? undefined : error.message, retryable: true, restartRequired: false })
    } finally { this.runtime.progress = originalRuntimeProgress; this.cache.progress = originalModelProgress }
  }
}
