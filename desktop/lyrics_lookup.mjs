// SPDX-License-Identifier: AGPL-3.0-only
// Serialize changes so the durable choice and the running provider agree.
export class LyricsLookupPreference {
  constructor({ state, apply }) { this.state = state; this.apply = apply; this.pending = Promise.resolve() }
  async get() {
    await this.pending
    return { enabled: (await this.state.read())?.lyricsLookup?.enabled === true }
  }
  set(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Expected a boolean lyrics lookup preference'))
    const action = this.pending.then(async () => {
      const previous = (await this.state.read())?.lyricsLookup?.enabled === true
      await this.apply(enabled)
      try { return await this.state.save('lyricsLookup', { enabled }) }
      catch (error) { await this.apply(previous); throw error }
    })
    this.pending = action.catch(() => {})
    return action
  }
}
