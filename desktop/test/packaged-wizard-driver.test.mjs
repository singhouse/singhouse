// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OnboardingSetup } from '../onboarding_setup.mjs'
import { ModelCache, RuntimeManager } from '../runtime_manager.mjs'
import { createSetupCatalog, validateSetupCatalog } from '../setup_catalog.mjs'
import { LOCAL_MODEL_IDS, RUNTIME_COMPONENT_LABEL, WIZARD_LIMITATIONS, normalizeText, stepFromHeading, summarizeCatalog, assertCatalogLock,
  assertWizardPlan, assertConsentText, createStatusTracker, shouldInterrupt, classifyRetry, partialRuntimeBytes, installedRuntimeIdentity,
  installedModelsIdentity, assertPostRestart, isPrivateTestOrigin, catalogLimitations, modelsManifestFromPolicy, derivePlanId, assertPlanIdentity,
  parsePackServerLog, runtimeFileUrlPath, runtimeFileForUrlPath, judgePostRestart, observePostRestart, waitForIdle, acceptConsent,
  chooseLocalAndContinue, retryFromUi, setupStarted, waitForSetupStart } from './packaged-wizard-driver.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const LOCK = 'a'.repeat(64)
const host = { platform: 'linux', arch: 'x64' }

function catalog(overrides = {}) {
  const runtime = { schema: 1, platform: 'linux', arch: 'x64', accelerator: 'cpu', provenance: { lockSha256: LOCK },
    files: [{ path: 'runtime/a.bin', size: 600, sha256: 'b'.repeat(64), url: 'https://packs.example.test/a.bin' },
      { path: 'runtime/b.bin', size: 400, sha256: 'c'.repeat(64), url: 'https://packs.example.test/b.bin' }] }
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
      { label: RUNTIME_COMPONENT_LABEL, bytes: 1000, sources: ['https://packs.example.test'], terms: [] },
      ...LOCAL_MODEL_IDS.map((id, index) => ({ label: id, bytes: 100 + index, sourceMode: 'upstream', sources: ['https://models.example.test'],
        terms: [{ label: `${id} terms`, url: `https://terms.example.test/${id}` }] })),
    ], ...overrides }
}

test('step headings map exactly, after whitespace normalization only', () => {
  assert.equal(stepFromHeading('  Your library.\n Your stage. '), 'welcome')
  assert.equal(stepFromHeading('Restart to finish setup.'), 'restart')
  assert.equal(stepFromHeading('Let’s add your first song.'), 'ready')
  assert.equal(stepFromHeading('Setup cancelled.'), 'cancelled')
  assert.equal(stepFromHeading("Let's add your first song."), null)
  assert.equal(stepFromHeading('restart to finish setup.'), null)
  assert.equal(stepFromHeading(undefined), null)
  assert.equal(normalizeText('a\t\n b '), 'a b')
})

test('private test origins: loopback, private ranges, localhost and explicit ports', () => {
  for (const origin of ['https://127.0.0.1', 'https://127.1.2.3', 'https://localhost', 'https://packs.localhost', 'https://10.0.0.5',
    'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.1', 'https://169.254.0.1', 'https://100.64.0.1', 'https://[::1]',
    'https://[fd00::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]', 'https://packs.example.test:8443', 'https://example.org:443']) {
    // An explicit :443 is normalized away by URL, so it is a default port.
    assert.equal(isPrivateTestOrigin(origin), origin !== 'https://example.org:443', origin)
  }
  for (const origin of ['https://example.org', 'https://172.32.0.1', 'https://8.8.8.8', 'https://[2001:db8::1]', 'https://192.169.0.1', 'https://[::ffff:8.8.8.8]']) {
    assert.equal(isPrivateTestOrigin(origin), false, origin)
  }
})

test('catalog summary carries identity, lock, target, sources, private-source flag and scope', () => {
  const value = catalog(), bytes = bytesOf(value), summary = summarizeCatalog(bytes)
  assert.equal(summary.sha256, sha256(bytes))
  assert.equal(summary.runtimeId, sha256(JSON.stringify(value.runtime)))
  assert.equal(summary.runtimeLockSha256, LOCK)
  assert.deepEqual(summary.target, { platform: 'linux', arch: 'x64', accelerator: 'cpu' })
  assert.equal(summary.runtimeBytes, 1000); assert.equal(summary.runtimeFiles, 2)
  assert.deepEqual(summary.runtimeSources, ['https://packs.example.test'])
  assert.equal(summary.privateTestSource, false)
  assert.equal(Object.hasOwn(summary.qualification, 'scope'), false)
  assert.deepEqual(summary.models[0].terms[0], { label: 'heart-transcriptor terms', url: 'https://terms.example.test/heart-transcriptor' })
  assert.deepEqual(catalogLimitations(summary), ['The packaged catalog declares no qualification scope; it is not marked as full qualification'])
  const full = summarizeCatalog(bytesOf(catalog({ qualification: { ...value.qualification, scope: 'full' } })))
  assert.equal(full.qualification.scope, 'full'); assert.deepEqual(catalogLimitations(full), [])
  const scoped = summarizeCatalog(bytesOf(catalog({ qualification: { ...value.qualification, scope: 'single-track' } })))
  assert.match(catalogLimitations(scoped)[0], /scope is "single-track", not full/)
  const local = catalog()
  local.runtime.files[1].url = 'https://127.0.0.1:8443/b.bin'
  const privateSummary = summarizeCatalog(bytesOf({ ...local, qualification: { ...value.qualification, scope: 'full' } }))
  assert.equal(privateSummary.privateTestSource, true)
  assert.deepEqual(catalogLimitations(privateSummary),
    ['The candidate carries a private test catalog (runtime sources https://127.0.0.1:8443, https://packs.example.test); it is not a release build'])
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
  assert.equal(Object.hasOwn(recorded, 'catalogQualificationScope'), false)
  const scoped = summarizeCatalog(bytesOf(catalog({ qualification: { ...catalog().qualification, scope: 'full' } })))
  assert.equal(assertWizardPlan(plan(), scoped, LOCK).catalogQualificationScope, 'full')
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

// A valid shipped catalog and model policy, built and admitted by the
// product's own catalog code (mirrors the product setup_catalog fixture).
function productFixture({ memory = false } = {}) {
  const ids = LOCAL_MODEL_IDS
  const identity = { appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', platform: 'linux', arch: 'x64' }
  const runtime = { schema: 1, kind: 'processing', ...identity, accelerator: 'cpu', python: 'python', pythonVersion: '3.12',
    capabilities: ['transcription', 'separation'], models: [...ids],
    modelCapabilities: Object.fromEntries(ids.map(id => [id, id === 'heart-transcriptor' ? 'transcription' : 'separation'])),
    probe: { schema: 2, type: 'python-functional-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    files: ['python', 'NOTICE'].map(path => ({ path, url: `https://127.0.0.1:8443/${path}`, sha256: sha256(path), size: 7, executable: path === 'python' })) }
  const lock = { schema: 1, kind: 'processing-input', ...Object.fromEntries(
    ['appVersion', 'backendVersion', 'lyricsyncVersion', 'platform', 'arch', 'accelerator', 'python', 'pythonVersion', 'capabilities', 'models', 'modelCapabilities', 'probe'].map(key => [key, runtime[key]])),
    sourceCommit: 'a'.repeat(40), packages: [{ name: 'fixture', version: '1', license: 'MIT', sourceUrl: 'https://example.org/package', sha256: sha256('package'), notices: ['NOTICE'] }],
    files: runtime.files.map(({ url, ...file }) => file) }
  runtime.provenance = { inputLock: JSON.stringify(lock), lockSha256: sha256(JSON.stringify(lock)), sourceCommit: lock.sourceCommit, packages: lock.packages }
  const qualification = { passed: true, runtimeLockSha256: runtime.provenance.lockSha256, platform: 'linux', arch: 'x64', accelerator: 'cpu', evidenceReference: 'run-1', scope: 'full' }
  const policy = { schema: 1, allowedHosts: ['example.org'], models: ids.map(id => ({ id, files: [{ path: `huggingface/${id}`, url: `https://example.org/${id}`, sha256: sha256(id), revision: sha256(id), size: 11, executable: false }] })) }
  const options = { identity, trustedLocks: [runtime.provenance.lockSha256], modelPolicy: policy }
  const input = { runtime, qualification, models: ids.map(id => ({ id, terms: [{ label: `${id} terms`, url: 'https://example.org/license' }] })),
    ...(memory && { memory: { runtimeLockSha256: runtime.provenance.lockSha256, platform: 'linux', arch: 'x64', accelerator: 'cpu',
      ram: { measuredPeakBytes: 1000, representativeHardware: { verified: true, description: 'fixture' }, evidenceReference: 'ram-1' } } }) }
  // The bytes the build writes into the archive, and the policy file bytes.
  const shipped = JSON.stringify(createSetupCatalog(input, options))
  return { shipped, policyText: JSON.stringify(policy), options }
}

async function productPlan(t, fixture, hardware = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-plan-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // As main.mjs: the archive catalog is admitted by validateSetupCatalog and
  // the stores are the product's own (empty) runtime and model stores.
  const policy = JSON.parse(fixture.policyText)
  const setup = new OnboardingSetup({ runtime: new RuntimeManager(join(root, 'processing'), fixture.options.identity, { trustedLocks: fixture.options.trustedLocks }),
    cache: new ModelCache(join(root, 'model-cache'), policy, {}), policy,
    catalog: validateSetupCatalog(JSON.parse(fixture.shipped), { ...fixture.options, modelPolicy: policy }),
    hardware: async () => hardware, diskFree: async () => 1e12 })
  return setup.preflight()
}

test('plan identity recomputed from the shipped catalog and model policy equals the product preflight planId', async t => {
  for (const [fixture, hardware] of [[productFixture(), {}],
    [productFixture({ memory: true }), { platform: 'linux', arch: 'x64', totalMemoryBytes: 1e12, availableMemoryBytes: 1e12, unifiedMemory: true }]]) {
    const offered = await productPlan(t, fixture, hardware)
    assert.equal(offered.available, true, offered.reason)
    const catalogRuntime = JSON.parse(fixture.shipped).runtime, policy = JSON.parse(fixture.policyText)
    const identity = assertPlanIdentity(offered, { catalogRuntime, policy })
    assert.equal(identity.planId, offered.planId); assert.equal(identity.verified, true)
    assert.equal(identity.runtimeId, sha256(JSON.stringify(catalogRuntime)))
    assert.equal(identity.modelsManifestId, sha256(JSON.stringify(modelsManifestFromPolicy(policy))))
    // Any changed input breaks the binding.
    const tampered = structuredClone(catalogRuntime); tampered.files[0].size += 1
    assert.throws(() => assertPlanIdentity(offered, { catalogRuntime: tampered, policy }), /does not match/)
    const otherPolicy = structuredClone(policy); otherPolicy.models[0].files[0].size += 1
    assert.throws(() => assertPlanIdentity(offered, { catalogRuntime, policy: otherPolicy }), /does not match/)
    assert.throws(() => assertPlanIdentity({ ...offered, components: offered.components.slice(1) }, { catalogRuntime, policy }), /does not match/)
    assert.throws(() => assertPlanIdentity({ ...offered, memoryRequirements: { ...offered.memoryRequirements, ramBytes: 1 } }, { catalogRuntime, policy }), /does not match/)
    assert.throws(() => assertPlanIdentity({ ...offered, modelSource: 'offline' }, { catalogRuntime, policy }), /upstream/)
    assert.equal(derivePlanId({ runtime: catalogRuntime, modelsManifest: modelsManifestFromPolicy(policy), components: offered.components,
      modelSource: 'upstream', memoryRequirements: offered.memoryRequirements }), offered.planId)
  }
  assert.throws(() => modelsManifestFromPolicy({ models: [] }), /exactly once/)
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
  assert.equal(tracker.lastRunningPhase(), 'runtime')
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
  assert.equal(tracker.attempt, 2); assert.equal(tracker.runtimeFraction(), 0); assert.equal(tracker.lastRunningPhase(), null)
  observation = tracker.observe(running('runtime', 'runtime/a.bin', 250), 2500)
  assert.equal(observation.transition.attempt, 2)
  assert.equal(tracker.fileObservations('runtime', 'runtime/a.bin', 1).received, 600)
  assert.equal(tracker.fileObservations('runtime', 'runtime/a.bin').firstReceived, 250)
  // A source failure reports `paused`; the failed stage is the last running phase.
  const errored = tracker.observe({ state: 'error', phase: 'paused', error: 'source failed', retryable: true }, 2600)
  assert.equal(errored.terminal, 'error'); assert.equal(errored.transition.error, 'source failed'); assert.equal(errored.transition.retryable, true)
  assert.equal(tracker.lastRunningPhase(), 'runtime')
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

const logLine = (started, time, fields) => JSON.stringify({ started, time, method: 'GET', url: '/a.bin', range: null, status: 200, bytes: 600, ...fields })

test('pack server log parsing keeps request records and refuses malformed lines', () => {
  const text = [JSON.stringify({ time: '2026-01-01T00:00:00.000Z', listening: 'https://127.0.0.1:8443/' }),
    logLine('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', { outcome: 'complete' }), ''].join('\n')
  assert.deepEqual(parsePackServerLog(text), [{ started: '2026-01-01T00:00:01.000Z', time: '2026-01-01T00:00:02.000Z', method: 'GET',
    url: '/a.bin', range: null, status: 200, bytes: 600, outcome: 'complete' }])
  assert.throws(() => parsePackServerLog('{'), /not JSON/)
  assert.throws(() => parsePackServerLog(JSON.stringify({ method: 'GET', url: '/a', time: 'x', started: '2026-01-01T00:00:00Z' })), /no time/)
  assert.throws(() => parsePackServerLog(JSON.stringify({ method: 'GET', url: '/a', time: '2026-01-01T00:00:00Z' })), /start time/)
  const runtime = catalog().runtime
  assert.equal(runtimeFileUrlPath(runtime, 'runtime/b.bin'), '/b.bin')
  assert.equal(runtimeFileForUrlPath(runtime, '/a.bin?attempt=1'), 'runtime/a.bin')
  assert.throws(() => runtimeFileUrlPath(runtime, 'runtime/x.bin'), /not in the packaged catalog/)
  assert.throws(() => runtimeFileForUrlPath(runtime, '/x.bin'), /exactly one/)
})

test('retry is classified resumed or restarted only from the server request log', () => {
  const at = '2026-01-01T00:00:10.000Z'
  // The interrupted transfer started before the cancel and is logged after it.
  const first = logLine('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:10.500Z', { outcome: 'aborted' })
  const log = range => parsePackServerLog([first, logLine('2026-01-01T00:00:20.000Z', '2026-01-01T00:00:21.000Z',
    range ? { range: `bytes=${range}-`, status: 206 } : {})].join('\n'))
  const retry = { firstReceived: 300, minReceived: 300 }
  const none = classifyRetry({ bytesPresent: 300, retry })
  assert.equal(none.classification, 'unproven'); assert.match(none.reason, /--pack-server-log/)
  assert.deepEqual(none.polling, { firstObservedReceived: 300, minimumObservedReceived: 300 })
  const resumed = classifyRetry({ bytesPresent: 300, retry, log: log(300), path: '/a.bin', after: at })
  assert.equal(resumed.classification, 'resumed'); assert.equal(resumed.resumedFromByte, 300); assert.equal(resumed.matchesBytesPresent, true)
  assert.equal(resumed.request.started, '2026-01-01T00:00:20.000Z')
  assert.equal(classifyRetry({ bytesPresent: 300, retry, log: log(200), path: '/a.bin', after: at }).matchesBytesPresent, false)
  assert.equal(classifyRetry({ bytesPresent: 300, retry, log: log(), path: '/a.bin', after: at }).classification, 'restarted')
  assert.match(classifyRetry({ bytesPresent: 300, log: parsePackServerLog(first), path: '/a.bin', after: at }).reason, /after the interruption/)
  assert.match(classifyRetry({ bytesPresent: 300, log: log(300), path: '/b.bin', after: at }).reason, /before the interruption/)
  const odd = parsePackServerLog([first, logLine('2026-01-01T00:00:20.000Z', '2026-01-01T00:00:21.000Z', { range: 'bytes=0-', status: 206 })].join('\n'))
  assert.equal(classifyRetry({ bytesPresent: 0, log: odd, path: '/a.bin', after: at }).classification, 'unproven')
  assert.throws(() => classifyRetry({ log: log(300), path: '/a.bin', after: 'never' }), /interruption time/)
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

function installModels(profile, manifest, slots) {
  const id = sha256(JSON.stringify(manifest)), root = join(profile, 'model-cache')
  mkdirSync(join(root, 'packs', id), { recursive: true }); writeFileSync(join(root, 'packs', id, 'manifest.json'), JSON.stringify(manifest))
  for (const [slot, sequence, pointerId = id] of slots) {
    const value = { schema: 2, sequence, id: pointerId }
    writeFileSync(join(root, `active.${slot}.json`), JSON.stringify({ ...value, checksum: sha256(JSON.stringify(value)) }))
  }
  return id
}

test('installed model identity follows the highest valid pointer, as the model store does', t => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-models-')))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const policy = JSON.parse(productFixture().policyText), manifest = modelsManifestFromPolicy(policy)
  const id = installModels(profile, manifest, [[0, 1, 'e'.repeat(64)], [1, 2]])
  const installed = installedModelsIdentity(profile)
  assert.equal(installed.modelsId, id); assert.equal(installed.canonicalId, id); assert.deepEqual(installed.pointer, { slot: 1, sequence: 2 })
  assert.deepEqual(installed.models, LOCAL_MODEL_IDS)
  // A pointer with a bad checksum is ignored.
  writeFileSync(join(profile, 'model-cache', 'active.1.json'), JSON.stringify({ schema: 2, sequence: 9, id, checksum: 'x' }))
  assert.throws(() => installedModelsIdentity(profile), /ENOENT/)
  rmSync(join(profile, 'model-cache'), { recursive: true })
  assert.throws(() => installedModelsIdentity(profile), /ENOENT/)
})

test('post-restart acceptance requires the promised runtime, lock, target and model set', t => {
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
  const modelsId = installModels(profile, modelsManifestFromPolicy(JSON.parse(productFixture().policyText)), [[0, 1]])
  const installedModels = installedModelsIdentity(profile)

  const good = { settled: { step: 'ready' }, readiness: { runtime: { id: summary.runtimeId }, separation: { ready: true }, transcription: { ready: true } },
    installed, installedModels }
  assertPostRestart(good, summary, LOCK, modelsId)
  const failures = [
    [{ settled: { step: 'restart' } }, /did not settle on ready/],
    [{ readiness: { ...good.readiness, runtime: { id: 'f'.repeat(64) } } }, /different runtime than the plan/],
    [{ installed: { ...installed, canonicalId: 'f'.repeat(64) } }, /does not match its identity/],
    [{ installed: { ...installed, runtimeLockSha256: 'f'.repeat(64) } }, /lock differs/],
    [{ installed: { ...installed, target: { ...installed.target, accelerator: 'cuda' } } }, /target differs/],
    [{ installedModels: { ...installedModels, canonicalId: 'f'.repeat(64) } }, /model manifest does not match/],
    [{ readiness: { ...good.readiness, separation: { ready: false } } }, /Separation is not ready/],
    [{ readiness: { ...good.readiness, transcription: undefined } }, /Transcription is not ready/],
  ]
  for (const [change, pattern] of failures) assert.throws(() => assertPostRestart({ ...good, ...change }, summary, LOCK, modelsId), pattern)
  assert.throws(() => assertPostRestart(good, summary, LOCK, 'f'.repeat(64)), /model set differs/)
})

// ---- Fake Playwright page: the dialog, its busy flag, heading and buttons ----

function fakeWizard(initial) {
  const state = { visible: true, busy: false, heading: 'Where should we prepare your songs?', localAvailable: true, pressed: 'true',
    calls: [], ...initial }
  const tick = () => { state.onPoll?.(state) }
  const button = name => ({
    async isDisabled() { state.calls.push(`isDisabled:${name}:${state.busy}`); return state.busy || (String(name).includes('On this computer') && !state.localAvailable) },
    async isEnabled() { state.calls.push(`isEnabled:${name}:${state.busy}`); return !state.busy },
    async getAttribute(attribute) { return attribute === 'aria-pressed' ? state.pressed : null },
    async click() { state.calls.push(`click:${name}:${state.busy}`); state.onClick?.(String(name), state) },
  })
  const dialog = {
    async isVisible() { return state.visible },
    async getAttribute(attribute) { tick(); return attribute === 'aria-busy' ? String(state.busy) : null },
    getByRole(role, { name } = {}) {
      return role === 'heading' ? { innerText: async () => state.heading } : button(name)
    },
    locator() { return { innerText: async () => state.reason ?? 'Local setup is currently unavailable.' } },
  }
  return { state, page: { getByRole: () => dialog } }
}

test('controls are judged only after the wizard is idle (aria-busy=false)', async () => {
  // The choice screen renders while its preflight runs: busy, local disabled.
  let polls = 0
  const { state, page } = fakeWizard({ busy: true, onPoll: s => { if (++polls >= 3) s.busy = false },
    onClick: (name, s) => { if (name.includes('Continue')) s.heading = 'Review your installation.' } })
  await chooseLocalAndContinue(page, { timeoutMs: 2000 })
  assert.ok(polls >= 3)
  assert.ok(state.calls.includes('isDisabled:/^On this computer/u:false'))
  assert.ok(!state.calls.some(call => call.endsWith(':true')), 'no control was judged or clicked while busy')

  const unavailable = fakeWizard({ localAvailable: false, reason: 'Not enough free disk space.' })
  await assert.rejects(chooseLocalAndContinue(unavailable.page, { timeoutMs: 500 }), /unavailable in the wizard: Not enough free disk space/)

  const consent = fakeWizard({ busy: true, heading: 'Review your installation.' })
  setTimeout(() => { consent.state.busy = false }, 30)
  await acceptConsent(consent.page, { timeoutMs: 2000 })
  assert.deepEqual(consent.state.calls, ['isEnabled:/^Install tools and models/u:false', 'click:/^Install tools and models/u:false'])

  const retry = fakeWizard({ busy: true, heading: 'Setup cancelled.',
    onClick: (name, s) => { if (name.includes('retry')) s.heading = 'Where should we prepare your songs?'; if (name.includes('Continue')) s.heading = 'Review your installation.' } })
  setTimeout(() => { retry.state.busy = false }, 30)
  await retryFromUi(retry.page, { timeoutMs: 2000 })
  assert.equal(retry.state.calls[0], 'click:Review setup and retry:false')

  const stuck = fakeWizard({ busy: true })
  await assert.rejects(waitForIdle(stuck.page, { timeoutMs: 50, interval: 5 }), /stayed busy .*aria-busy=true/)
  await assert.rejects(waitForIdle(stuck.page, {}), /requires a timeout/)
})

test('setup start requires leaving idle or the prior stopped state, bounded', async () => {
  assert.equal(setupStarted(null, { state: 'idle' }), false)
  assert.equal(setupStarted({ state: 'idle' }, { state: 'running' }), true)
  const cancelled = { state: 'cancelled', phase: 'paused', message: 'Setup cancelled. Retry to resume saved files.' }
  assert.equal(setupStarted(cancelled, { ...cancelled }), false)
  assert.equal(setupStarted(cancelled, { state: 'error', phase: 'paused', message: 'The setup plan changed.' }), true)
  let reads = 0
  const status = await waitForSetupStart(async () => (++reads < 3 ? { state: 'idle' } : { state: 'running', phase: 'preflight' }),
    { before: { state: 'idle' }, timeoutMs: 1000, interval: 1 })
  assert.equal(status.state, 'running')
  await assert.rejects(waitForSetupStart(async () => ({ state: 'idle' }), { before: { state: 'idle' }, timeoutMs: 20, interval: 1 }),
    /Setup did not start within 0 s of the install click \(status idle\)/)
})

// A scripted post-restart sequence; each UI read advances a fake clock.
function scripted(frames, stepMs = 500) {
  let clock = 0, index = 0
  const frame = () => frames[Math.min(index, frames.length - 1)]
  return {
    now: () => clock,
    snapshot: async () => { const current = frame(); clock += stepMs; index++; return current.ui },
    // The status read follows the snapshot it is paired with.
    read: async () => frames[Math.min(Math.max(index - 1, 0), frames.length - 1)].status,
  }
}
const ui = (step, heading, busy, visible = true) => ({ dialogVisible: visible, busy, heading, step })
const statusOf = state => ({ state, message: state === 'cancelled' ? 'Setup was interrupted. Retry to verify and resume saved files.' : null })

async function postRestart(frames, timeoutMs = 10000) {
  const script = scripted(frames)
  const result = await observePostRestart({}, { timeoutMs, interval: 0, settleMs: 1000, snapshot: script.snapshot, read: script.read, now: script.now })
  return { result, judge: () => judgePostRestart({ ...result, timeoutMs }) }
}

test('post-restart: today’s defect sequence (interrupted screen, then ready) fails naming the defect', async () => {
  const { result, judge } = await postRestart([
    { ui: ui(null, null, null, false), status: statusOf('cancelled') },
    { ui: ui('cancelled', 'Setup cancelled.', true), status: statusOf('cancelled') },
    { ui: ui('cancelled', 'Setup cancelled.', true), status: statusOf('cancelled') },
    { ui: ui('ready', 'Let’s add your first song.', false), status: statusOf('cancelled') },
  ])
  assert.equal(result.timedOut, false); assert.equal(result.settled.step, 'ready')
  assert.deepEqual(result.observations.map(item => [item.step, item.statusState, item.heading]),
    [[null, 'cancelled', null], ['cancelled', 'cancelled', 'Setup cancelled.'], ['ready', 'cancelled', 'Let’s add your first song.']])
  assert.ok(result.observations.every(item => typeof item.at === 'string' && Number.isInteger(item.elapsedMs)))
  assert.throws(judge, /verified restart was presented as an interrupted setup \(product defect\)/)
})

test('post-restart: a clean sequence (neutral checking state, then ready) passes', async () => {
  const { result, judge } = await postRestart([
    { ui: ui(null, 'Checking your installation…', true), status: { state: 'idle' } },
    { ui: ui(null, 'Checking your installation…', true), status: { state: 'idle' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'idle' } },
  ])
  assert.deepEqual(judge(), { dialogVisible: true, step: 'ready', heading: 'Let’s add your first song.', statusState: 'idle' })
  assert.deepEqual(result.observations.map(item => item.step), [null, 'ready'])
})

test('post-restart: settled restart, progress or error screens and status errors fail', async () => {
  for (const [frames, pattern] of [
    [[{ ui: ui('restart', 'Restart to finish setup.', false), status: { state: 'idle' } }], /settled on restart after restart, not ready/],
    [[{ ui: ui('progress', 'We’ll take it from here.', false), status: { state: 'running' } }], /settled on progress/],
    [[{ ui: ui('error', 'Setup could not finish.', false), status: { state: 'error' } }], /product defect/],
    [[{ ui: ui(null, 'Checking…', true), status: { state: 'error' } }, { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready' } }], /product defect/],
    [[{ ui: ui(null, 'Something new', false), status: { state: 'idle' } }], /settled on "Something new"/],
  ]) {
    const { judge } = await postRestart(frames)
    assert.throws(judge, pattern)
  }
})

test('post-restart: never settling, never reopening, or closing early fails', async () => {
  const busy = await postRestart([{ ui: ui(null, 'Checking…', true), status: { state: 'idle' } }], 5000)
  assert.equal(busy.result.timedOut, true); assert.equal(busy.result.settled, null)
  assert.throws(busy.judge, /did not settle within 5 s after restart/)
  const hidden = await postRestart([{ ui: ui(null, null, null, false), status: { state: 'idle' } }], 3000)
  assert.throws(hidden.judge, /did not reopen after restart/)
  const closed = await postRestart([{ ui: ui(null, 'Checking…', true), status: { state: 'idle' } },
    { ui: ui(null, null, null, false), status: { state: 'idle' } }])
  assert.equal(closed.result.settled.dialogVisible, false)
  assert.throws(closed.judge, /closed after restart before settling/)
  await assert.rejects(observePostRestart({}, {}), /requires a timeout/)
  // A failing status read is recorded, not fatal to observation.
  const script = scripted([{ ui: ui('ready', 'Let’s add your first song.', false) }])
  const result = await observePostRestart({}, { timeoutMs: 5000, interval: 0, settleMs: 1000, snapshot: script.snapshot, now: script.now,
    read: async () => { throw new Error('bridge unavailable') } })
  assert.equal(result.observations[0].statusReadError, 'bridge unavailable')
})

test('wizard limitations state the restart interception, absent phase split and plan inputs', () => {
  assert.ok(WIZARD_LIMITATIONS.some(line => /relaunch request is intercepted/.test(line)))
  assert.ok(WIZARD_LIMITATIONS.some(line => /does not separate runtime transfer/.test(line)))
  assert.ok(WIZARD_LIMITATIONS.some(line => /components and memory requirements from the plan/.test(line)))
  assert.ok(Object.isFrozen(WIZARD_LIMITATIONS))
})
