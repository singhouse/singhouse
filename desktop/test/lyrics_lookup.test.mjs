// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnboardingState } from '../onboarding_state.mjs'
import { LyricsLookupPreference } from '../lyrics_lookup.mjs'

test('lyrics lookup defaults off, persists explicit choices, and serializes updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lyrics-preference-'))
  try {
    const state = new OnboardingState(join(directory, 'state.json'))
    const applied = []
    const preference = new LyricsLookupPreference({ state, apply: async value => { applied.push(value) } })
    assert.deepEqual(await preference.get(), { enabled: false })
    for (const value of [null, undefined, 1, 0, 'true', {}, []]) await assert.rejects(preference.set(value), /boolean/)
    assert.deepEqual(applied, [])
    assert.deepEqual(await preference.set(true), { enabled: true })
    const reopened = new LyricsLookupPreference({ state: new OnboardingState(state.path), apply: async () => {} })
    assert.deepEqual(await reopened.get(), { enabled: true })
    await Promise.all([preference.set(false), preference.set(true), preference.set(false)])
    assert.deepEqual(applied, [true, false, true, false])
    assert.deepEqual(await preference.get(), { enabled: false })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed backend changes do not persist and failed saves roll back the active preference', async () => {
  const applied = []
  const state = { read: async () => ({ lyricsLookup: { enabled: false } }), save: async () => { throw new Error('disk failure') } }
  const preference = new LyricsLookupPreference({ state, apply: async value => { applied.push(value) } })
  await assert.rejects(preference.set(true), /disk failure/)
  assert.deepEqual(applied, [true, false])
  let saved = false
  const unavailable = new LyricsLookupPreference({ state: { ...state, save: async () => { saved = true } }, apply: async () => { throw new Error('unavailable') } })
  await assert.rejects(unavailable.set(true), /unavailable/)
  assert.equal(saved, false)
})
