// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOCAL_MODEL_IDS, RUNTIME_COMPONENT_LABEL, WIZARD_LIMITATIONS, normalizeText, stepFromHeading, summarizeCatalog, assertCatalogLock,
  assertWizardPlan, assertConsentText, createStatusTracker, shouldInterrupt, classifyRetry, partialRuntimeBytes, installedRuntimeIdentity,
  assertPostRestart } from './packaged-wizard-driver.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const LOCK = 'a'.repeat(64)
const host = { platform: 'linux', arch: 'x64' }

function catalog(overrides = {}) {
  const runtime = { schema: 1, platform: 'linux', arch: 'x64', accelerator: 'cpu', provenance: { lockSha256: LOCK },
    files: [{ path: 'runtime/a.bin', size: 600, sha256: 'b'.repeat(64), url: 'https://packs.example.test:8443/a.bin' },
      { path: 'runtime/b.bin', size: 400, sha256: 'c'.repeat(64), url: 'https://packs.example.test:8443/b.bin' }] }
  return { schema: 1, runtime,
    qualification: { passed: true, runtimeLockSha256: LOCK, platform: 'linux', arch: 'x64', accelerator: 'cpu', evidenceReference: 'evidence-1' },
    models: LOCAL_MODEL_IDS.map(id => ({ id, terms: [{ label: `${id} terms`, url: `https://terms.example.test/${id}`, extra: 'dropped' }] })),
    ...overrides }
}
const bytesOf = value => Buffer.from(JSON.stringify(value))

function plan(overrides = {}) {
  return { available: true, ready: false, restartRequired: false, modelSource: 'upstream', runtimeTransferRequired: true, planId: 'plan-1',
    diskRequiredBytes: 10, diskFreeBytes: 100, memoryRequirements: { minimumBytes: 1 }, memoryQualification: 'qualified',
    components: [
      { label: RUNTIME_COMPONENT_LABEL, bytes: 1000, sources: ['https://packs.example.test:8443'], terms: [] },
      ...LOCAL_MODEL_IDS.map((id, index) => ({ label: id, bytes: 100 + index, sourceMode: 'upstream', sources: ['https://models.example.test'],
        terms: [{ label: `${id} terms`, url: `https://terms.example.test/${id}` }] })),
    ], ...overrides }
}

test('step headings map exactly, after whitespace normalization only', () => {
  assert.equal(stepFromHeading('  Your library.\n Your stage. '), 'welcome')
  assert.equal(stepFromHeading('Restart to finish setup.'), 'restart')
  assert.equal(stepFromHeading('Let’s add your first song.'), 'ready')
  assert.equal(stepFromHeading("Let's add your first song."), null)
  assert.equal(stepFromHeading('restart to finish setup.'), null)
  assert.equal(stepFromHeading(undefined), null)
  assert.equal(normalizeText('a\t\n b '), 'a b')
})

test('catalog summary carries the application runtime identity, lock, target and sources', () => {
  const value = catalog(), bytes = bytesOf(value), summary = summarizeCatalog(bytes)
  assert.equal(summary.sha256, sha256(bytes))
  assert.equal(summary.runtimeId, sha256(JSON.stringify(value.runtime)))
  assert.equal(summary.runtimeLockSha256, LOCK)
  assert.deepEqual(summary.target, { platform: 'linux', arch: 'x64', accelerator: 'cpu' })
  assert.equal(summary.runtimeBytes, 1000); assert.equal(summary.runtimeFiles, 2)
  assert.deepEqual(summary.runtimeSources, ['https://packs.example.test:8443'])
  assert.equal(Object.hasOwn(summary.qualification, 'qualificationScope'), false)
  assert.deepEqual(summary.models[0].terms[0], { label: 'heart-transcriptor terms', url: 'https://terms.example.test/heart-transcriptor' })
  const scoped = summarizeCatalog(bytesOf(catalog({ qualification: { ...value.qualification, qualificationScope: 'single-track' } })))
  assert.equal(scoped.qualification.qualificationScope, 'single-track')
  assert.throws(() => summarizeCatalog(bytesOf({ ...value, schema: 2 })), /unsupported schema/)
  assert.throws(() => summarizeCatalog(bytesOf({ ...value, runtime: { ...value.runtime, files: [] } })), /no runtime files/)
})

test('catalog lock must equal the expected lock, be qualified, and target this host', () => {
  const summary = summarizeCatalog(bytesOf(catalog()))
  assertCatalogLock(summary, LOCK, host)
  assert.throws(() => assertCatalogLock(summary, 'A'.repeat(64), host), /64 lowercase hex/)
  assert.throws(() => assertCatalogLock(summary, 'd'.repeat(64), host), /differs from the expected lock/)
  const variant = changes => ({ ...summary, ...changes })
  assert.throws(() => assertCatalogLock(variant({ qualification: { ...summary.qualification, runtimeLockSha256: 'd'.repeat(64) } }), LOCK, host), /qualification is bound/)
  assert.throws(() => assertCatalogLock(variant({ qualification: { ...summary.qualification, passed: false } }), LOCK, host), /not marked passed/)
  assert.throws(() => assertCatalogLock(variant({ qualification: { ...summary.qualification, accelerator: 'cuda' } }), LOCK, host), /accelerator differs/)
  assert.throws(() => assertCatalogLock(summary, LOCK, { platform: 'darwin', arch: 'x64' }), /different platform/)
  assert.throws(() => assertCatalogLock(summary, LOCK, { platform: 'linux', arch: 'arm64' }), /different architecture/)
})

test('wizard plan binds to the catalog runtime and records offered components', () => {
  const summary = summarizeCatalog(bytesOf(catalog())), recorded = assertWizardPlan(plan(), summary, LOCK)
  assert.equal(recorded.planId, 'plan-1'); assert.equal(recorded.runtimeLockSha256, LOCK)
  assert.equal(recorded.transferBytes, 1000 + 100 + 101 + 102)
  assert.deepEqual(recorded.models.map(model => model.id), LOCAL_MODEL_IDS)
  assert.equal(Object.hasOwn(recorded, 'qualificationScope'), false)
  assert.equal(assertWizardPlan(plan({ qualificationScope: 'x' }), summary, LOCK).qualificationScope, 'x')
  const failures = [
    [plan({ available: false, reason: 'unsupported GPU' }), /unsupported GPU/],
    [plan({ ready: true }), /unexpectedly reports local processing ready/],
    [plan({ restartRequired: true }), /requires restart/],
    [plan({ modelSource: 'mirror' }), /upstream model sources/],
    [plan({ runtimeTransferRequired: false }), /must retrieve the processing runtime/],
    [plan({ planId: undefined }), /no identity/],
  ]
  for (const [candidate, pattern] of failures) assert.throws(() => assertWizardPlan(candidate, summary, LOCK), pattern)
  assert.throws(() => assertWizardPlan(plan(), summary, 'd'.repeat(64)), /Plan runtime lock differs/)
  const base = plan()
  const swap = (index, changes) => plan({ components: base.components.map((c, i) => i === index ? { ...c, ...changes } : c) })
  assert.throws(() => assertWizardPlan(swap(0, { bytes: 999 }), summary, LOCK), /runtime size differs/)
  assert.throws(() => assertWizardPlan(swap(0, { sources: ['https://other.example.test'] }), summary, LOCK), /runtime sources differ/)
  assert.throws(() => assertWizardPlan(plan({ components: [...base.components, base.components[0]] }), summary, LOCK), /exactly one processing runtime/)
  assert.throws(() => assertWizardPlan(plan({ components: base.components.slice(0, -1) }), summary, LOCK), /omits model karaoke-roformer/)
  assert.throws(() => assertWizardPlan(swap(1, { sourceMode: 'mirror' }), summary, LOCK), /not retrieved from upstream/)
  assert.throws(() => assertWizardPlan(swap(1, { bytes: 0 }), summary, LOCK), /no transfer size/)
  assert.throws(() => assertWizardPlan(swap(1, { terms: [] }), summary, LOCK), /no terms/)
  assert.throws(() => assertWizardPlan(swap(1, { terms: [{ label: 't', url: 'http://terms.example.test/' }] }), summary, LOCK), /not HTTPS/)
})

test('consent text must name every component with its exact formatted size', () => {
  const offered = plan(), formatted = offered.components.map(component => component.bytes.toLocaleString('en-US'))
  const text = offered.components.map(component => `${component.label}\n (${component.bytes.toLocaleString('en-US')} bytes)`).join('\n') + '\nInstall tools and models'
  assertConsentText(text, offered, formatted)
  assert.throws(() => assertConsentText(text.replace('karaoke-roformer', 'other'), offered, formatted), /omits karaoke-roformer/)
  assert.throws(() => assertConsentText(text.replace('(1,000 bytes)', '(1 KB)'), offered, formatted), /exact size of Local processing runtime/)
  assert.throws(() => assertConsentText(text.replace('Install tools and models', ''), offered, formatted), /no install control/)
})

test('status tracker records transitions, per-attempt phases and transfer bounds', () => {
  const tracker = createStatusTracker({ runtimeBytes: 1000, start: 0 })
  assert.throws(() => createStatusTracker({ runtimeBytes: 0 }), /runtime size/)
  assert.throws(() => tracker.observe({}), /malformed/)
  const running = (phase, file, received, total = 600) => ({ state: 'running', phase, progress: file && { file, received, total } })
  let observation = tracker.observe(running('preflight'), 0)
  assert.equal(observation.transition.phase, 'preflight'); assert.equal(observation.terminal, null)
  tracker.observe(running('runtime', 'runtime/a.bin', 0), 100)
  observation = tracker.observe(running('runtime', 'runtime/a.bin', 300), 200)
  assert.equal(observation.transition, null); assert.equal(observation.runtimeFraction, 0.3)
  tracker.observe(running('runtime', 'runtime/a.bin', 600), 300)
  tracker.observe(running('runtime', 'runtime/b.bin', 400, 400), 400)
  // Verification and self-test report the same phase with unchanged progress.
  tracker.observe(running('runtime', 'runtime/b.bin', 400, 400), 900)
  assert.equal(tracker.runtimeFraction(), 1)
  tracker.observe(running('models', 'heart', 10, 20), 1000)
  tracker.observe(running('models', 'heart', 20, 20), 1500)
  tracker.observe({ state: 'running', phase: 'verification' }, 1600)
  observation = tracker.observe({ state: 'restart-required', phase: 'complete' }, 2000)
  assert.equal(observation.terminal, 'restart-required')
  assert.deepEqual(tracker.transitions.map(t => `${t.state}/${t.phase}`),
    ['running/preflight', 'running/runtime', 'running/models', 'running/verification', 'restart-required/complete'])
  const runtime = tracker.summary().find(entry => entry.phase === 'runtime')
  assert.deepEqual(runtime, { attempt: 1, phase: 'runtime', observedMs: 800, transferObservedMs: 300, postTransferObservedMs: 500 })
  assert.equal(tracker.summary().find(entry => entry.phase === 'models').transferObservedMs, 500)
  assert.deepEqual(tracker.fileObservations('runtime', 'runtime/a.bin'), { received: 600, total: 600, firstReceived: 0, minReceived: 0 })
  assert.equal(tracker.last.state, 'restart-required')
  // A retry is a separate attempt; its runtime fraction starts over.
  tracker.nextAttempt()
  assert.equal(tracker.attempt, 2); assert.equal(tracker.runtimeFraction(), 0)
  observation = tracker.observe(running('runtime', 'runtime/a.bin', 250), 2500)
  assert.equal(observation.transition.attempt, 2)
  assert.equal(tracker.fileObservations('runtime', 'runtime/a.bin', 1).received, 600)
  assert.equal(tracker.fileObservations('runtime', 'runtime/a.bin').firstReceived, 250)
  const errored = tracker.observe({ state: 'error', phase: 'runtime', error: 'source failed', retryable: true }, 2600)
  assert.equal(errored.terminal, 'error'); assert.equal(errored.transition.error, 'source failed'); assert.equal(errored.transition.retryable, true)
})

test('interruption happens only during an incomplete runtime transfer past the threshold', () => {
  const at = (fraction, received = 10, total = 20) => ({ runtimeFraction: fraction, progress: { file: 'f', received, total } })
  const status = { state: 'running', phase: 'runtime' }
  assert.equal(shouldInterrupt(at(0.05), status), true)
  assert.equal(shouldInterrupt(at(0.049), status), false)
  assert.equal(shouldInterrupt(at(1), status), false)
  assert.equal(shouldInterrupt(at(0.5, 20, 20), status), false)
  assert.equal(shouldInterrupt({ runtimeFraction: 0.5, progress: null }, status), false)
  assert.equal(shouldInterrupt(at(0.5), { state: 'running', phase: 'models' }), false)
  assert.equal(shouldInterrupt(at(0.5), { state: 'paused', phase: 'runtime' }), false)
  assert.equal(shouldInterrupt(at(0.2), status, { minimumFraction: 0.25 }), false)
})

test('retry classification never claims resume without evidence', () => {
  assert.equal(classifyRetry({ bytesPresent: null }).classification, 'no-partial-bytes-present')
  assert.equal(classifyRetry({ bytesPresent: 0, retry: { minReceived: 0 } }).classification, 'no-partial-bytes-present')
  assert.equal(classifyRetry({ bytesPresent: 100 }).classification, 'indeterminate')
  assert.deepEqual(classifyRetry({ bytesPresent: 100, retry: { firstReceived: 40, minReceived: 40 } }),
    { classification: 'restarted', bytesPresent: 100, firstObservedReceived: 40, minimumObservedReceived: 40 })
  const resumed = classifyRetry({ bytesPresent: 100, retry: { firstReceived: 150, minReceived: 100 } })
  assert.equal(resumed.classification, 'consistent-with-resume'); assert.match(resumed.note, /Range log/)
})

test('partial runtime bytes are read from staging without following links or leaving the store', t => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-profile-'))), id = 'd'.repeat(64)
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const staging = join(profile, 'processing', 'staging', id, 'runtime')
  mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, 'a.bin.partial'), Buffer.alloc(37))
  assert.equal(partialRuntimeBytes(profile, id, 'runtime/a.bin'), 37)
  assert.equal(partialRuntimeBytes(profile, id, 'runtime/missing.bin'), null)
  symlinkSync(join(staging, 'a.bin.partial'), join(staging, 'b.bin.partial'))
  assert.equal(partialRuntimeBytes(profile, id, 'runtime/b.bin'), null)
  assert.throws(() => partialRuntimeBytes(profile, id, '../escape.bin'), /Unsafe/)
  assert.throws(() => partialRuntimeBytes(profile, id, '/abs.bin'), /Unsafe/)
  assert.throws(() => partialRuntimeBytes(profile, 'not-an-id', 'runtime/a.bin'))
})

test('installed runtime identity is read back from the profile and compared after restart', t => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-installed-')))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const value = catalog(), summary = summarizeCatalog(bytesOf(value))
  const pack = join(profile, 'processing', 'packs', summary.runtimeId)
  mkdirSync(pack, { recursive: true }); writeFileSync(join(pack, 'manifest.json'), JSON.stringify(value.runtime, null, 2))
  const installed = installedRuntimeIdentity(profile, summary.runtimeId)
  assert.equal(installed.canonicalId, summary.runtimeId); assert.equal(installed.runtimeLockSha256, LOCK)
  assert.deepEqual(installed.target, summary.target)
  assert.throws(() => installedRuntimeIdentity(profile, null), /no active runtime/)
  assert.throws(() => installedRuntimeIdentity(profile, 'e'.repeat(64)), /ENOENT/)

  const good = { onboarding: { dialogVisible: false }, status: { state: 'ready' }, plan: { ready: true, restartRequired: false },
    readiness: { runtime: { id: summary.runtimeId }, separation: { ready: true }, transcription: { ready: true } }, installed }
  assertPostRestart(good, summary, LOCK)
  const failures = [
    [{ onboarding: { dialogVisible: true } }, /Onboarding was shown again/],
    [{ status: { state: 'cancelled' } }, /status after restart is cancelled/],
    [{ plan: { ready: false, restartRequired: false } }, /does not report local processing ready/],
    [{ plan: { ready: true, restartRequired: true } }, /still requires a restart/],
    [{ readiness: { ...good.readiness, runtime: { id: 'f'.repeat(64) } } }, /different runtime than the plan/],
    [{ installed: { ...installed, canonicalId: 'f'.repeat(64) } }, /does not match its identity/],
    [{ installed: { ...installed, runtimeLockSha256: 'f'.repeat(64) } }, /lock differs/],
    [{ installed: { ...installed, target: { ...installed.target, accelerator: 'cuda' } } }, /target differs/],
    [{ readiness: { ...good.readiness, separation: { ready: false } } }, /Separation is not ready/],
    [{ readiness: { ...good.readiness, transcription: undefined } }, /Transcription is not ready/],
  ]
  for (const [change, pattern] of failures) assert.throws(() => assertPostRestart({ ...good, ...change }, summary, LOCK), pattern)
})

test('wizard limitations state the restart interception and the absent phase split', () => {
  assert.ok(WIZARD_LIMITATIONS.some(line => /relaunch request is intercepted/.test(line)))
  assert.ok(WIZARD_LIMITATIONS.some(line => /does not separate runtime transfer/.test(line)))
  assert.ok(Object.isFrozen(WIZARD_LIMITATIONS))
})
