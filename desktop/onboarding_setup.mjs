// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { processingAttestation } from './runtime_manager.mjs'

export const LOCAL_MODEL_IDS = Object.freeze(['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = manifest => manifest.files.reduce((sum, file) => sum + file.size, 0)
const complete = manifest => ['transcription', 'separation'].every(id => manifest.capabilities?.includes(id))
  && LOCAL_MODEL_IDS.every(id => manifest.models?.includes(id)
    && manifest.modelCapabilities?.[id] === (id === 'heart-transcriptor' ? 'transcription' : 'separation'))
const initial = () => ({ state: 'idle', phase: 'preflight', message: 'Choose local processing or playback.', retryable: false, restartRequired: false })

// Catalog, policy, and qualification are release-owned inputs. Never populate
// these from renderer messages, persisted progress, or an unsigned remote feed.
export class OnboardingSetup {
  constructor({ runtime, cache, policy, catalog = null, hardware = async () => ({}), diskFree,
    loaded = {}, load = async () => null, save = async () => {}, notify = () => {} }) {
    Object.assign(this, { runtime, cache, policy, hardware, diskFree, loaded, load, save, notify })
    this.catalog = catalog && structuredClone(catalog)
    this.state = initial()
    this.operation = null
    this.controller = null
    this.restored = false
  }

  async getStatus() {
    if (!this.restored) {
      this.restored = true
      const previous = await this.load()
      // A checkpoint records workflow only; it never supplies runnable inputs
      // or proves readiness. Every attempt revalidates the stores and catalog.
      if (previous && ['running', 'error', 'cancelled', 'restart-required'].includes(previous.state)) {
        this.state = { ...initial(), state: 'cancelled', message: 'Setup was interrupted. Retry to verify and resume saved files.', retryable: true }
      }
    }
    return structuredClone(this.state)
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
    const catalog = this.catalog
    if (!catalog || catalog.schema !== 1 || !catalog.runtime) throw new Error('Complete local setup is unavailable: this release has no authenticated processing installation catalog.')
    const runtime = this.runtime.validate(structuredClone(catalog.runtime))
    const q = catalog.qualification
    if (!complete(runtime) || runtime.probe.schema !== 2 || q?.passed !== true
        || q.runtimeLockSha256 !== runtime.provenance.lockSha256
        || ['platform', 'arch', 'accelerator'].some(key => q[key] !== runtime[key])) {
      throw new Error('Complete local setup is unavailable: the processing bundle has no matching complete qualification.')
    }
    const ids = [...new Set([...(active?.manifest.models || []), ...LOCAL_MODEL_IDS])]
    const entries = ids.map(id => {
      const entry = this.policy.models.find(model => model.id === id)
      const terms = catalog.models?.find(model => model.id === id)?.terms
      if (!entry || !Array.isArray(terms) || !terms.length || terms.some(term => {
        try { return !term.label?.trim() || new URL(term.url).protocol !== 'https:' } catch { return true }
      })) throw new Error(`Complete local setup is unavailable: authenticated source and terms information is missing for ${id}.`)
      return { ...entry, terms }
    })
    const models = this.cache.validate({ schema: 1, kind: 'models', models: ids, files: entries.flatMap(entry => entry.files) })
    return { runtime, models, entries }
  }

  async preflight({ signal } = {}) {
    await this.getStatus()
    const installed = await this.installed({ signal })
    const hardware = await this.hardware()
    signal?.throwIfAborted()
    const base = { available: false, ready: installed.ready, restartRequired: installed.restartRequired, hardware,
      components: [], diskRequiredBytes: 0, diskFreeBytes: null }
    if (installed.installed) return { ...base, available: true, planId: hash([installed.runtime.id, installed.models.id]), components: [] }
    try {
      const selected = this.selection(installed.models)
      const runtimeNeeded = installed.runtime?.id !== hash(selected.runtime)
      const modelsNeeded = installed.models?.id !== hash(selected.models)
      const runtimeBytes = runtimeNeeded ? bytes(selected.runtime) : 0
      const modelBytes = modelsNeeded ? bytes(selected.models) : 0
      // Same staging/activation reservation as RuntimeManager. Conservative:
      // existing model files are reused, but their staged copies still need space.
      const diskRequiredBytes = (runtimeBytes + modelBytes) * 2 + (Number(runtimeNeeded) + Number(modelsNeeded)) * 64 * 1024 * 1024
      const diskFreeBytes = this.diskFree ? await this.diskFree() : null
      signal?.throwIfAborted()
      const components = [
        ...(runtimeNeeded ? [{ label: 'Local processing runtime', bytes: runtimeBytes,
          sources: [...new Set(selected.runtime.files.map(file => new URL(file.url).origin))],
          terms: selected.runtime.provenance.packages.map(p => ({ label: `${p.name}: ${p.license}`, url: p.sourceUrl })) }] : []),
        ...selected.entries.map(entry => ({ label: entry.id, bytes: installed.models?.manifest.models.includes(entry.id) ? 0 : bytes(entry),
          sources: [...new Set(entry.files.map(file => new URL(file.url).origin))], terms: entry.terms })),
      ]
      const planId = hash([selected.runtime, selected.models, components])
      const result = { ...base, planId, components, diskRequiredBytes, diskFreeBytes }
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
        for (const [phase, manager, manifest, existing] of [
          ['runtime', this.runtime, selected.runtime, active.runtime], ['models', this.cache, selected.models, active.models],
        ]) {
          signal.throwIfAborted()
          if (existing?.id === hash(manifest)) continue
          await this.update({ phase, message: phase === 'runtime' ? 'Installing the local processing runtime.' : 'Installing separation and Heart model files.' })
          manager.progress = progress => { this.state.progress = progress; this.notify(structuredClone(this.state)) }
          await manager.install(manifest, { signal })
        }
      }
      signal.throwIfAborted()
      await this.update({ phase: 'verification', message: 'Verifying all local processing components.', progress: undefined })
      const result = await this.installed({ signal })
      signal.throwIfAborted()
      if (!result.installed) throw new Error('Complete local processing verification failed. Retry setup to repair the saved files.')
      await this.update({ state: result.ready ? 'ready' : 'restart-required', phase: 'complete',
        message: result.ready ? 'Local processing is ready.' : 'Setup is verified. Reopen Singhouse to use local processing.', restartRequired: result.restartRequired })
    } catch (error) {
      await this.update({ state: signal.aborted ? 'cancelled' : 'error', phase: 'paused', progress: undefined,
        message: signal.aborted ? 'Setup cancelled. Retry to resume saved files.' : error.message,
        error: signal.aborted ? undefined : error.message, retryable: true, restartRequired: false })
    } finally { this.runtime.progress = originalRuntimeProgress; this.cache.progress = originalModelProgress }
  }
}
