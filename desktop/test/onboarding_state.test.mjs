// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { onboardingPreferences, OnboardingState, restartForSetup } from '../onboarding_state.mjs'

const defaults = { step: 'welcome', choice: null, skipped: false }
const idle = { projectorOpen: false, audible: false, installing: false, backendReady: true, activeJobs: 0 }
const locked = { quiesced: true, activeMutations: 0, jobs: { nonterminal: 0 } }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'singhouse-onboarding-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'preferences.json') }
}

function restartFixture(overrides = {}) {
  const calls = []
  const callbacks = {
    activity: async () => { calls.push('activity'); return { ...idle } },
    quiesce: async () => { calls.push('quiesce'); return structuredClone(locked) },
    resume: async () => { calls.push('resume') },
    restart: async () => { calls.push('restart') },
    ...overrides,
  }
  return { calls, callbacks }
}

test('preferences whitelist navigation fields and never preserve readiness evidence', () => {
  for (const step of ['welcome', 'choose', 'consent', 'progress', 'modal', 'ready', 'error', 'restart']) {
    assert.deepEqual(onboardingPreferences({ step, choice: 'local', skipped: true,
      ready: true, installed: true, verified: true, credentials: 'secret' }),
    { step, choice: 'local', skipped: true })
  }
  assert.deepEqual(onboardingPreferences({ step: 'finished', choice: 'cloud', skipped: 'true' }), defaults)
  assert.deepEqual(onboardingPreferences({ step: 'ready', choice: 'modal' }), { step: 'ready', choice: 'modal', skipped: false })
})

test('malformed preference values are safe defaults, never readiness evidence', () => {
  for (const value of [undefined, null, false, true, 42, 'ready', [], ['ready']]) {
    assert.deepEqual(onboardingPreferences(value), defaults)
  }
})

test('concurrent saves serialize read-modify-write and reads observe all completed writes', async t => {
  const { path, directory } = await fixture(t)
  const state = new OnboardingState(path)
  assert.deepEqual(await state.read(), {})
  const writes = Array.from({ length: 24 }, (_, index) => state.save(`key${index}`, { index }))
  const read = state.read()
  await Promise.all(writes)
  const expected = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`key${index}`, { index }]))
  assert.deepEqual(await read, expected)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), expected)
  await Promise.all([state.save('preferences', { step: 'choose' }), state.save('preferences', { step: 'ready' })])
  assert.deepEqual((await state.read()).preferences, { step: 'ready' })
  assert.deepEqual(await readdir(directory), ['preferences.json'])
})

test('corrupt state recovers on save without manufacturing readiness', async t => {
  const { path } = await fixture(t)
  await writeFile(path, '{"ready":true,')
  const state = new OnboardingState(path)
  assert.deepEqual(await state.read(), {})
  for (const invalid of ['null', '[]', '42', '"ready"', '{']) {
    await writeFile(path, invalid)
    await state.save('preferences', onboardingPreferences({ skipped: true }))
    assert.deepEqual(await state.read(), { preferences: { ...defaults, skipped: true } })
  }
})

test('a rejected save does not poison the serialization queue', async t => {
  const { path } = await fixture(t)
  const state = new OnboardingState(path)
  const circular = {}; circular.self = circular
  await assert.rejects(state.save('invalid', circular), /circular/i)
  await state.save('preferences', defaults)
  assert.deepEqual(await state.read(), { preferences: defaults })
})

test('restart refuses jobs, unknown readiness, projector, audible playback, and installation before quiescing', async () => {
  for (const patch of [
    { activeJobs: 1 }, { activeJobs: null }, { activeJobs: undefined }, { activeJobs: -1 },
    { backendReady: false }, { backendReady: undefined },
    { projectorOpen: true }, { audible: true }, { installing: true },
  ]) {
    const { calls, callbacks } = restartFixture({ activity: async () => ({ ...idle, ...patch }) })
    await assert.rejects(restartForSetup(callbacks), /before restarting/)
    assert.deepEqual(calls, [])
  }
})

test('safe idle restart quiesces and rechecks before restart without resuming admission', async () => {
  const { calls, callbacks } = restartFixture()
  assert.deepEqual(await restartForSetup(callbacks), { restarting: true })
  assert.deepEqual(calls, ['activity', 'quiesce', 'activity', 'restart'])
})

test('activity racing with quiesce rejects and resumes admission', async () => {
  for (const patch of [{ projectorOpen: true }, { audible: true }, { installing: true }, { activeJobs: 1 }, { activeJobs: null }, { backendReady: false }]) {
    let checks = 0
    const { calls, callbacks } = restartFixture({ activity: async () => ({ ...idle, ...(checks++ ? patch : {}) }) })
    await assert.rejects(restartForSetup(callbacks), /before restarting/)
    assert.deepEqual(calls, ['quiesce', 'resume'])
  }
})

test('incomplete or busy quiesce evidence fails closed and resumes', async () => {
  for (const result of [null, {}, { ...locked, quiesced: false }, { ...locked, activeMutations: 1 },
    { ...locked, activeMutations: undefined }, { ...locked, jobs: {} }, { ...locked, jobs: { nonterminal: 1 } }]) {
    const { calls, callbacks } = restartFixture({ quiesce: async () => result })
    await assert.rejects(restartForSetup(callbacks))
    assert.deepEqual(calls, ['activity', 'resume'])
  }
})

test('quiesce, second activity check, restart, and resume failures never report success', async () => {
  for (const boundary of ['quiesce', 'restart']) {
    const { calls, callbacks } = restartFixture({ [boundary]: async () => { throw new Error(`${boundary} failed`) } })
    await assert.rejects(restartForSetup(callbacks), new RegExp(`${boundary} failed`))
    assert.equal(calls.at(-1), 'resume')
  }
  let checks = 0
  const activityFailure = restartFixture({ activity: async () => {
    if (checks++) throw new Error('activity unavailable')
    return idle
  } })
  await assert.rejects(restartForSetup(activityFailure.callbacks), /activity unavailable/)
  assert.deepEqual(activityFailure.calls, ['quiesce', 'resume'])
  const resumeFailure = restartFixture({
    quiesce: async () => { throw new Error('quiesce failed') },
    resume: async () => { throw new Error('resume failed') },
  })
  await assert.rejects(restartForSetup(resumeFailure.callbacks), /resume failed/)
  assert.deepEqual(resumeFailure.calls, ['activity'])
})

test('setup restart preserves only verified deferred queued jobs', async () => {
  const { calls, callbacks } = restartFixture({
    activity: async () => ({ ...idle, activeJobs: 3, deferredJobs: 3 }),
    quiesce: async () => ({ ...locked, jobs: { nonterminal: 3, deferred: 3 } }),
  })
  await restartForSetup(callbacks)
  assert.deepEqual(calls, ['restart'])
  for (const deferred of [0, 2, 4, null, -1, 3.5, '3']) {
    const blocked = restartFixture({ activity: async () => ({ ...idle, activeJobs: 3, deferredJobs: deferred }) })
    await assert.rejects(restartForSetup(blocked.callbacks))
    assert.deepEqual(blocked.calls, [])
  }
})

test('setup restart rechecks deferral after quiescing', async () => {
  const { calls, callbacks } = restartFixture({
    activity: async () => ({ ...idle, activeJobs: 2, deferredJobs: 2 }),
    quiesce: async () => ({ ...locked, jobs: { nonterminal: 2, deferred: 1 } }),
  })
  await assert.rejects(restartForSetup(callbacks), /library is busy/)
  assert.deepEqual(calls, ['resume'])
})
