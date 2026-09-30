// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const steps = new Set(['welcome', 'choose', 'consent', 'progress', 'modal', 'error', 'restart', 'ready'])
export function onboardingPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
  return { step: steps.has(value.step) ? value.step : 'welcome',
    choice: ['local', 'modal'].includes(value.choice) ? value.choice : null,
    skipped: value.skipped === true }
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

export async function restartForSetup({ activity, quiesce, resume, restart }) {
  const check = async () => {
    const state = await activity()
    if (state.projectorOpen || state.audible || state.installing || !state.backendReady
      || state.activeJobs !== 0) throw new Error('Finish processing and playback, close the projector, and wait for installation before restarting.')
  }
  await check()
  try {
    const locked = await quiesce()
    if (locked.quiesced !== true || locked.activeMutations !== 0 || locked.jobs?.nonterminal !== 0) {
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
