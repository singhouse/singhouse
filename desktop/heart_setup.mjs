// SPDX-License-Identifier: AGPL-3.0-only
// Fixed application-owned setup; the renderer supplies neither URLs nor paths.
export const HEART_MODEL_ID = 'heart-transcriptor'

export function heartManifest(policy, active) {
  const ids = [...new Set([...(active?.manifest.models || []), HEART_MODEL_ID])]
  const entries = ids.map(id => {
    const entry = policy.models.find(model => model.id === id)
    if (!entry) throw new Error('Heart model inventory is unavailable in this application')
    return entry
  })
  return { schema: 1, kind: 'models', models: ids, files: entries.flatMap(entry => entry.files) }
}

export function authorizedHeartCaller(event, host, origin) {
  return Boolean(host && event.sender === host.webContents
    && event.senderFrame === host.webContents.mainFrame
    && new URL(event.senderFrame.url).origin === origin)
}

export class HeartSetup {
  constructor({ cache, policy, loadedModels, consent, chooseDirectory, notify, progressDone,
    runtimeReady = async () => false, cancelled = () => false }) {
    Object.assign(this, { cache, policy, loadedModels, consent, chooseDirectory, notify,
      progressDone, runtimeReady, cancelled })
    this.operation = null
    this.controller = null
  }

  prepare() {
    if (!this.operation) this.operation = this.run().finally(() => { this.operation = null })
    return this.operation
  }

  cancel() { this.controller?.abort() }

  async run() {
    try {
      let active, repair = false
      try { active = await this.cache.active() }
      catch {
        active = await this.cache.selectionForRepair()
        if (!active) throw new Error('The saved model inventory cannot be verified. Restore a known-good cache before retrying setup.')
        repair = true
      }
      if (!repair && active?.manifest.models.includes(HEART_MODEL_ID)) {
        const loaded = this.loadedModels?.id === active.id
        if (!loaded) await this.notify('Heart is installed. Reopen the application, then retry transcription.')
        return { installed: loaded, restartRequired: !loaded }
      }
      const manifest = heartManifest(this.policy, active)
      this.cache.validate(manifest)
      const entry = this.policy.models.find(model => model.id === HEART_MODEL_ID)
      const bytes = entry.files.reduce((sum, file) => sum + file.size, 0)
      const choice = await this.consent({ bytes, sources: [...new Set(entry.files.map(file => new URL(file.url).origin))],
        revision: entry.files[0].revision, runtimeReady: await this.runtimeReady(), repair })
      if (!['upstream', 'directory'].includes(choice) || this.cancelled()) return { installed: false, restartRequired: false }
      let directory
      if (choice === 'directory') {
        directory = await this.chooseDirectory()
        if (!directory || this.cancelled()) return { installed: false, restartRequired: false }
      }
      this.controller = new AbortController()
      const options = { signal: this.controller.signal }
      if (directory) {
        // Import a complete combined cache by its manifest layout when other
        // models are present; a Heart-only import accepts the upstream folder.
        const prefix = manifest.models.length === 1 ? entry.files[0].path.slice(0, entry.files[0].path.lastIndexOf('/')) : ''
        await this.cache.installFromDirectory(manifest, directory, { ...options, prefix })
      } else await this.cache.install(manifest, options)
      if (!this.cancelled()) await this.notify('Heart files are verified and saved. Reopen the application, then retry transcription. A compatible processing runtime is also required.')
      return { installed: false, restartRequired: true }
    } catch (error) {
      const reason = this.controller?.signal.aborted ? 'Heart setup cancelled. Retry to resume.' : error.message
      if (!this.cancelled()) await this.notify(reason, true)
      return { installed: false, restartRequired: false, reason }
    } finally { this.controller = null; this.progressDone?.() }
  }
}
