// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, rename, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const steps = new Set(['welcome', 'choose', 'lyrics', 'consent', 'progress', 'modal', 'error', 'restart', 'ready'])
export function onboardingPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
  return { step: steps.has(value.step) ? value.step : 'welcome',
    choice: ['local', 'modal'].includes(value.choice) ? value.choice : null,
    skipped: value.skipped === true }
}

// Processing tools and models install under a saved folder while it is still
// a directory; otherwise, and when none was chosen, under the default root.
export async function resolveInstallRoot(defaultRoot, saved) {
  if (typeof saved === 'string' && isAbsolute(saved)) {
    try { if ((await stat(saved)).isDirectory()) return resolve(saved) }
    catch { /* A missing or unreadable folder falls back to the default. */ }
  }
  return resolve(defaultRoot)
}

// A folder picked in the desktop dialog, by its real path. A folder removed
// before it can be read is reported rather than treated as the default.
export async function chosenInstallRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Select a folder using the desktop picker.')
  const unavailable = () => new Error('The selected folder is no longer available. Choose another folder.')
  let real
  try { real = await realpath(path) }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw unavailable(); throw error }
  if (!(await stat(real)).isDirectory()) throw unavailable()
  return real
}

// A saved folder that was unavailable at launch is forgotten once an install
// completes in the root actually used, so a later launch does not prefer an
// empty folder over that installation. Returns the folder still saved.
export async function settleInstallLocation(state, { saved, used }) {
  if (typeof saved !== 'string' || !saved) return null
  if (resolve(saved) === resolve(used)) return saved
  await state.save('installLocation', null)
  return null
}

// Preferences are not evidence of readiness. Only verified runtime/model state is.
export class OnboardingState {
  constructor(path) { this.path = path; this.pending = Promise.resolve() }
  async read() {
    await this.pending
    try { return JSON.parse(await readFile(this.path, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}
      throw error
    }
  }
  save(key, value) {
    const action = this.pending.then(async () => {
      let state = {}
      try { state = JSON.parse(await readFile(this.path, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
      if (!state || typeof state !== 'object' || Array.isArray(state)) state = {}
      state[key] = value
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, this.path)
      return value
    })
    this.pending = action.catch(() => {})
    return action
  }
}

// Only durable queued jobs held by the readiness gate may survive a setup restart.
function onlyDeferred(total, deferred = 0) {
  return Number.isSafeInteger(total) && total >= 0
    && Number.isSafeInteger(deferred) && deferred >= 0 && total === deferred
}

export async function restartForSetup({ activity, quiesce, resume, restart }) {
  const check = async () => {
    const state = await activity()
    if (state.projectorOpen || state.audible || state.installing || !state.backendReady
      || !onlyDeferred(state.activeJobs, state.deferredJobs)) throw new Error('Finish processing and playback, close the projector, and wait for installation before restarting.')
  }
  await check()
  try {
    const locked = await quiesce()
    if (locked.quiesced !== true || locked.activeMutations !== 0 || !onlyDeferred(locked.jobs?.nonterminal, locked.jobs?.deferred)) {
      throw new Error('The library is busy. Finish the current operation before restarting.')
    }
    await check()
    await restart()
    return { restarting: true }
  } catch (error) {
    await resume()
    throw error
  }
}
