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
import { LOCAL_MODEL_IDS, RUNTIME_COMPONENT_LABEL, WIZARD_LIMITATIONS, normalizeText, errorOutcomeFromHeading, stepFrom, summarizeCatalog,
  runtimeTransferUnits, formatSize, assertArchiveRetryResumed, assertWizardHooks, HOOKLESS_CANDIDATE, assertCatalogLock,
  assertWizardPlan, assertConsentText, createStatusTracker, shouldInterrupt, classifyRetry, partialRuntimeBytes, installedRuntimeIdentity,
  installedModelsIdentity, assertPostRestart, stagedArchivePartBytes, resolveRetryTarget, UNPROVEN_RESUME, isPrivateTestOrigin, catalogLimitations, modelsManifestFromPolicy, derivePlanId, assertPlanIdentity,
  parsePackServerLog, runtimeFileUrlPath, runtimeFileForUrlPath, judgePostRestart, observePostRestart, waitForIdle, acceptConsent,
  chooseLocalAndContinue, retryFromUi, setupStarted, waitForSetupStart, uiSnapshot, cancelFromUi, clickRestart } from './packaged-wizard-driver.mjs'

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
      { label: RUNTIME_COMPONENT_LABEL, bytes: 1000, installedBytes: 1000, sources: ['https://packs.example.test'], terms: [] },
      ...LOCAL_MODEL_IDS.map((id, index) => ({ label: id, bytes: 100 + index, sourceMode: 'upstream', sources: ['https://models.example.test'],
        terms: [{ label: `${id} terms`, url: `https://terms.example.test/${id}` }] })),
    ], ...overrides }
}

test('error headings map exactly, after whitespace normalization only', () => {
  assert.equal(errorOutcomeFromHeading('  Setup\n cancelled. '), 'cancelled')
  assert.equal(errorOutcomeFromHeading('Local processing could not be verified.'), 'verification-failed')
  assert.equal(errorOutcomeFromHeading('Setup could not finish.'), 'error')
  assert.equal(errorOutcomeFromHeading('setup cancelled.'), 'error-unclassified')
  assert.equal(errorOutcomeFromHeading(undefined), 'error-unclassified')
  assert.equal(normalizeText('a\t\n b '), 'a b')
})

test('steps come only from the data-step hook; headings refine the error step alone', () => {
  assert.equal(stepFrom('checking', 'Checking your setup.'), 'checking')
  assert.equal(stepFrom('ready', 'Any new ready copy'), 'ready')
  assert.equal(stepFrom('error', 'Setup cancelled.'), 'cancelled')
  assert.equal(stepFrom('error', 'Local processing could not be verified.'), 'verification-failed')
  assert.equal(stepFrom('error', 'Setup could not finish.'), 'error')
  assert.equal(stepFrom('error', 'Unknown error copy'), 'error-unclassified')
  assert.equal(stepFrom('error', null), 'error-unclassified')
  assert.equal(stepFrom(null, 'Restart to finish setup.'), null, 'no heading fallback without the hook')
  assert.equal(stepFrom(undefined, 'Setup cancelled.'), null)
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
  assert.equal(summary.runtimeBytes, 1000); assert.equal(summary.runtimeInstalledBytes, 1000); assert.equal(summary.runtimeFiles, 2)
  assert.equal(summary.delivery, 'files'); assert.equal(summary.runtimeParts, null)
  assert.deepEqual(summary.runtimeSources, ['https://packs.example.test'])
  assert.equal(summary.privateTestSource, false)
  assert.equal(Object.hasOwn(summary.qualification, 'scope'), false)
  assert.deepEqual(summary.models[0].terms[0], { label: 'heart-transcriptor terms', url: 'https://terms.example.test/heart-transcriptor' })
  const individual = 'The runtime is delivered as individual files; there is no unpack phase to time'
  assert.deepEqual(catalogLimitations(summary), [individual, 'The packaged catalog declares no qualification scope; it is not marked as full qualification'])
  const full = summarizeCatalog(bytesOf(catalog({ qualification: { ...value.qualification, scope: 'full' } })))
  assert.equal(full.qualification.scope, 'full'); assert.deepEqual(catalogLimitations(full), [individual])
  const scoped = summarizeCatalog(bytesOf(catalog({ qualification: { ...value.qualification, scope: 'single-track' } })))
  assert.match(catalogLimitations(scoped)[1], /scope is "single-track", not full/)
  const local = catalog()
  local.runtime.files[1].url = 'https://127.0.0.1:8443/b.bin'
  const privateSummary = summarizeCatalog(bytesOf({ ...local, qualification: { ...value.qualification, scope: 'full' } }))
  assert.equal(privateSummary.privateTestSource, true)
  assert.deepEqual(catalogLimitations(privateSummary),
    [individual, 'The candidate carries a private test catalog (runtime sources https://127.0.0.1:8443, https://packs.example.test); it is not a release build'])
  assert.throws(() => summarizeCatalog(bytesOf({ ...value, schema: 2 })), /unsupported schema/)
  assert.throws(() => summarizeCatalog(bytesOf({ ...value, runtime: { ...value.runtime, files: [] } })), /no runtime files/)
})

// An archive-delivered catalog runtime: per-file records without URLs and a
// two-part archive carrying the retrieval sources.
function archiveCatalog(overrides = {}) {
  const value = catalog(overrides)
  value.runtime.files = value.runtime.files.map(({ url, ...file }) => file)
  value.runtime.archive = { format: 'concat-gzip-v1', parts: [
    { url: 'https://packs.example.test/v1/tools.pack.gz.001', sha256: 'd'.repeat(64), size: 300 },
    { url: 'https://packs.example.test/v1/tools.pack.gz.002', sha256: 'e'.repeat(64), size: 120 }] }
  return value
}

test('archive catalogs summarize retrieval from parts and installation from files', () => {
  const value = archiveCatalog(), summary = summarizeCatalog(bytesOf(value))
  assert.equal(summary.delivery, 'archive')
  assert.equal(summary.runtimeBytes, 420); assert.equal(summary.runtimeInstalledBytes, 1000)
  assert.equal(summary.runtimeFiles, 2); assert.equal(summary.runtimeParts, 2)
  assert.deepEqual(summary.runtimeSources, ['https://packs.example.test'])
  assert.equal(summary.runtimeId, sha256(JSON.stringify(value.runtime)))
  assert.match(catalogLimitations(summary)[0], /2-part archive; setup progress names part retrieval and unpacking/)
  assert.deepEqual(runtimeTransferUnits(value.runtime).map(unit => [unit.label, unit.size, unit.part]),
    [['tools.pack.gz.001', 300, 1], ['tools.pack.gz.002', 120, 2]])
  const odd = archiveCatalog()
  odd.runtime.archive.parts[1].url = 'https://packs.example.test/v1/tools%20pack'
  assert.equal(runtimeTransferUnits(odd.runtime)[1].label, 'archive part 2')
  const same = archiveCatalog()
  same.runtime.archive.parts[1].url = 'https://mirror.example.test/v1/tools.pack.gz.001'
  assert.throws(() => runtimeTransferUnits(same.runtime), /distinct progress names/)
  assert.throws(() => summarizeCatalog(bytesOf({ ...value, runtime: { ...value.runtime, archive: { format: 'zip', parts: [] } } })), /unsupported format/)
  // The plan offers the archive's retrieval size and the unpacked size.
  const offered = plan({ components: plan().components.map(component => component.label === RUNTIME_COMPONENT_LABEL
    ? { ...component, bytes: 420, installedBytes: 1000 } : component) })
  const recorded = assertWizardPlan(offered, summary, LOCK)
  assert.deepEqual([recorded.runtime.delivery, recorded.runtime.bytes, recorded.runtime.installedBytes], ['archive', 420, 1000])
  assert.throws(() => assertWizardPlan(plan(), summary, LOCK), /runtime size differs/)
  assert.throws(() => assertWizardPlan(plan({ components: offered.components.map(component => component.label === RUNTIME_COMPONENT_LABEL
    ? { ...component, installedBytes: 999 } : component) }), summary, LOCK), /installed size differs/)
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
function productFixture({ memory = false, archive = false } = {}) {
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
  if (archive) {
    // Archive delivery: the files keep their records (no URLs) and the parts carry the sources.
    runtime.files = runtime.files.map(({ url, ...file }) => file)
    runtime.archive = { format: 'concat-gzip-v1', parts: [
      { url: 'https://127.0.0.1:8443/tools.pack.gz.001', sha256: sha256('part-1'), size: 5 },
      { url: 'https://127.0.0.1:8443/tools.pack.gz.002', sha256: sha256('part-2'), size: 4 }] }
  }
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
  for (const [fixture, hardware] of [[productFixture(), {}], [productFixture({ archive: true }), {}],
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

test('consent text keeps its exact retrieval sizes when installed sizes are added', () => {
  const offered = plan({ components: plan().components.map(component => component.label === RUNTIME_COMPONENT_LABEL
    ? { ...component, installedBytes: 1.9 * 1024 ** 3 } : component) })
  const formatted = offered.components.map(component => component.bytes.toLocaleString('en-US'))
  const text = offered.components.map((component, index) => `${component.label} · 1 MiB\n (${formatted[index]} bytes)`
    + (component.label === RUNTIME_COMPONENT_LABEL ? ' to retrieve, 1.9 GiB installed' : '')).join('\n') + '\nInstall tools and models'
  assertConsentText(text, offered, formatted)
  assert.throws(() => assertConsentText(text.replace('(1,000 bytes) to retrieve', '1.9 GiB installed'), offered, formatted),
    /exact size of Local processing runtime/)
  assert.throws(() => assertConsentText(text.replace(' to retrieve, 1.9 GiB installed', ''), offered, formatted), /installed size of Local processing runtime/)
  assert.throws(() => assertConsentText(text.replace('1.9 GiB installed', '2.0 GiB installed'), offered, formatted), /installed size/)
  assert.equal(formatSize(543 * 1024 ** 2), '543 MiB'); assert.equal(formatSize(1.9 * 1024 ** 3), '1.9 GiB')
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
    range ? { range: `bytes=${range}-`, status: 206, outcome: 'complete' } : { outcome: 'complete' })].join('\n'))
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
  // The store stages under the first 16 hex characters of the identity.
  const staging = join(profile, 'processing', 'staging', 'd'.repeat(16), 'runtime')
  mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, 'a.bin.partial'), Buffer.alloc(37))
  assert.equal(partialRuntimeBytes(profile, id, 'runtime/a.bin'), 37)
  // Staging under the earlier full-length name is discarded by the store, never measured.
  const legacy = join(profile, 'processing', 'staging', id, 'runtime')
  mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, 'c.bin.partial'), Buffer.alloc(11))
  assert.equal(partialRuntimeBytes(profile, id, 'runtime/c.bin'), null)
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
  // A runtime installed under the earlier full-length name is still read back.
  const legacy = join(profile, 'processing', 'packs', summary.runtimeId)
  mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, 'manifest.json'), JSON.stringify(value.runtime))
  assert.equal(installedRuntimeIdentity(profile, summary.runtimeId).canonicalId, summary.runtimeId)
  // The short name takes precedence, as in the store.
  const pack = join(profile, 'processing', 'packs', summary.runtimeId.slice(0, 16))
  mkdirSync(pack, { recursive: true }); writeFileSync(join(pack, 'manifest.json'), JSON.stringify(value.runtime, null, 2))
  const installed = installedRuntimeIdentity(profile, summary.runtimeId)
  assert.equal(installed.manifestSha256, sha256(JSON.stringify(value.runtime, null, 2)))
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
  const state = { visible: true, busy: false, step: 'choose', heading: 'Where should we prepare your songs?', localAvailable: true, pressed: 'true',
    detailsOpen: false, calls: [], ...initial }
  const tick = () => { state.onPoll?.(state) }
  const control = id => ({
    async isDisabled() { state.calls.push(`isDisabled:${id}:${state.busy}`); return state.busy || (id === 'onboarding-choice-local' && !state.localAvailable) },
    async isEnabled() { state.calls.push(`isEnabled:${id}:${state.busy}`); return !state.busy },
    async getAttribute(attribute) {
      if (attribute === 'aria-pressed') return state.pressed
      return attribute === 'open' && id === 'onboarding-setup-controls' && state.detailsOpen ? '' : null
    },
    locator(selector) { return { click: async () => { state.calls.push(`click:${id} ${selector}:${state.busy}`); state.detailsOpen = true } } },
    async click(options) { state.calls.push(`click:${id}:${state.busy}`); state.clickOptions = options; state.onClick?.(id, state) },
  })
  const dialog = {
    async isVisible() { return state.visible },
    async getAttribute(attribute) {
      tick()
      if (attribute === 'aria-busy') return String(state.busy)
      return attribute === 'data-step' ? state.step : null
    },
    getByRole(role) { assert.equal(role, 'heading'); return { innerText: async () => state.heading } },
    getByTestId: control,
    locator() { return { innerText: async () => state.reason ?? 'Local setup is currently unavailable.' } },
  }
  return { state, page: { getByTestId: id => { assert.equal(id, 'onboarding-dialog'); return dialog } } }
}

test('controls are judged only after the wizard is idle (aria-busy=false)', async () => {
  // The choice screen renders while its preflight runs: busy, local disabled.
  let polls = 0
  const { state, page } = fakeWizard({ busy: true, onPoll: s => { if (++polls >= 3) s.busy = false },
    onClick: (id, s) => { if (id === 'onboarding-continue') s.step = 'consent' } })
  await chooseLocalAndContinue(page, { timeoutMs: 2000 })
  assert.ok(polls >= 3)
  assert.ok(state.calls.includes('isDisabled:onboarding-choice-local:false'))
  assert.ok(state.calls.includes('click:onboarding-continue:false'))
  assert.ok(!state.calls.some(call => call.endsWith(':true')), 'no control was judged or clicked while busy')

  const unavailable = fakeWizard({ localAvailable: false, reason: 'Not enough free disk space.' })
  await assert.rejects(chooseLocalAndContinue(unavailable.page, { timeoutMs: 500 }), /unavailable in the wizard: Not enough free disk space/)

  const consent = fakeWizard({ busy: true, step: 'consent', heading: 'Review your installation.' })
  setTimeout(() => { consent.state.busy = false }, 30)
  await acceptConsent(consent.page, { timeoutMs: 2000 })
  assert.deepEqual(consent.state.calls, ['isEnabled:onboarding-install:false', 'click:onboarding-install:false'])

  const retry = fakeWizard({ busy: true, step: 'error', heading: 'Setup cancelled.',
    onClick: (id, s) => { if (id === 'onboarding-retry') s.step = 'choose'; if (id === 'onboarding-continue') s.step = 'consent' } })
  setTimeout(() => { retry.state.busy = false }, 30)
  await retryFromUi(retry.page, { timeoutMs: 2000 })
  assert.equal(retry.state.calls[0], 'click:onboarding-retry:false')

  const progress = fakeWizard({ step: 'progress', heading: 'We’ll take it from here.' })
  await cancelFromUi(progress.page)
  assert.deepEqual(progress.state.calls, ['click:onboarding-setup-controls summary:false', 'click:onboarding-cancel:false'])
  const restart = fakeWizard({ step: 'restart', heading: 'Restart to finish setup.' })
  await clickRestart(restart.page)
  assert.deepEqual(restart.state.calls, ['click:onboarding-restart:false'])
  assert.equal(restart.state.clickOptions.noWaitAfter, true)

  // The step is the hook's, whatever the heading copy says.
  const renamed = fakeWizard({ step: 'checking', heading: 'Some future checking copy' })
  assert.deepEqual(await uiSnapshot(renamed.page), { dialogVisible: true, busy: false, heading: 'Some future checking copy', step: 'checking' })

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

test('post-restart: a clean sequence (checking from the restored checkpoint, then ready) passes', async () => {
  const { result, judge } = await postRestart([
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready', phase: 'complete' } },
  ])
  assert.deepEqual(judge(), { dialogVisible: true, step: 'ready', heading: 'Let’s add your first song.', statusState: 'ready' })
  assert.deepEqual(result.observations.map(item => item.step), ['checking', 'ready'])
  // Seen in setup status alone (the wizard view was not sampled in time) also counts.
  const quick = await postRestart([
    { ui: ui('welcome', 'Your library. Your stage.', true), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready', phase: 'complete' } },
  ])
  assert.equal(quick.judge().step, 'ready')
})

test('post-restart: ready without an observed check, or without a ready status, fails', async () => {
  // A checkpoint restore that regressed to idle would go straight to ready.
  const idle = await postRestart([{ ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'idle' } }])
  assert.throws(idle.judge, /post-restart check was not observed: neither the wizard nor setup status showed checking/)
  // The harness knows only what it observed, never that the checkpoint was not exercised.
  assert.throws(idle.judge, error => /did not observe the restored setup checkpoint being exercised/.test(error.message)
    && !/was not exercised/.test(error.message))
  const unsettled = await postRestart([
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'idle' } },
  ])
  assert.throws(unsettled.judge, /check was not observed to settle: setup status was idle, not ready/)
})

test('post-restart: the checking step is not settled even when the dialog is not busy', async () => {
  const { result, judge } = await postRestart([
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready', phase: 'complete' } },
  ])
  assert.equal(result.settled.step, 'ready')
  assert.deepEqual(result.observations.map(item => [item.step, item.statusState, item.statusPhase]),
    [['checking', 'checking', 'verification'], ['ready', 'ready', 'complete']])
  assert.equal(judge().step, 'ready')
  const stuck = await postRestart([{ ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } }], 5000)
  assert.equal(stuck.result.timedOut, true)
  assert.throws(stuck.judge, /did not settle within 5 s after restart \(last step checking/)
})

test('post-restart: an honest failed verification is reported as such, not as an interrupted setup', async () => {
  const failure = { state: 'error', phase: 'verification', message: 'Review setup to check and repair the installation.' }
  const honest = error => /Post-restart verification failed/.test(error.message) && !/product defect/.test(error.message)
  for (const frames of [
    [{ ui: ui('checking', 'Checking your setup.', false), status: { state: 'checking', phase: 'verification' } },
      { ui: ui('verification-failed', 'Local processing could not be verified.', false), status: failure }],
    // An error screen whose heading the harness cannot classify, with the service's verification error.
    [{ ui: ui('error-unclassified', null, false), status: failure }],
  ]) {
    const { judge } = await postRestart(frames)
    assert.throws(judge, error => honest(error) && /did not pass live verification/.test(error.message) && /check and repair/.test(error.message))
  }
  // The wizard gave up while the service was still checking: the check did not complete.
  const gaveUp = await postRestart([{ ui: ui('verification-failed', 'Local processing could not be verified.', false), status: { state: 'checking', phase: 'verification' } }])
  assert.equal(gaveUp.result.settled.step, 'verification-failed')
  assert.throws(gaveUp.judge, error => honest(error) && /check did not complete \(setup status was still checking\)/.test(error.message)
    && !/did not pass live verification/.test(error.message))
  // An unclassifiable error screen without that status is not called honest or interrupted.
  const unknown = await postRestart([{ ui: ui('error-unclassified', 'Something else went wrong.', false), status: { state: 'checking', phase: 'verification' } }])
  assert.throws(unknown.judge, /error screen the harness cannot classify/)
  const unknownGeneric = await postRestart([{ ui: ui('error-unclassified', null, false), status: { state: 'error', phase: 'paused' } }])
  assert.throws(unknownGeneric.judge, /product defect/)
  // A verification failure shown as cancelled is still the product defect.
  const { judge } = await postRestart([{ ui: ui('cancelled', 'Setup cancelled.', false), status: failure }])
  assert.throws(judge, /presented as an interrupted setup \(product defect\)/)
  const generic = await postRestart([{ ui: ui('error', 'Setup could not finish.', false), status: failure }])
  assert.throws(generic.judge, /product defect/)
})

test('post-restart: a failed-verification screen is described by what setup status reported beside it', async () => {
  const shown = 'Local processing could not be verified.'
  const honest = error => /Post-restart verification failed/.test(error.message) && !/product defect/.test(error.message)
  const observation = status => ({ elapsedMs: 0, dialogVisible: true, busy: false, step: 'verification-failed', heading: shown,
    statusState: status.state, statusPhase: status.phase ?? null, statusMessage: null })
  const judge = status => () => judgePostRestart({ observations: [observation(status)], settled: null, timedOut: true, timeoutMs: 1000 })
  // Still checking, or unreadable: the check did not complete.
  assert.throws(judge({ state: 'checking', phase: 'verification' }),
    error => honest(error) && /check did not complete \(setup status was still checking\)/.test(error.message) && !/disagreement/.test(error.message))
  assert.throws(judge({ state: null }),
    error => honest(error) && /check did not complete \(setup status was still unreadable\)/.test(error.message) && !/disagreement/.test(error.message))
  // Any other status: the wizard and the setup service disagree.
  for (const status of [{ state: 'ready', phase: 'complete' }, { state: 'error', phase: 'paused' }, { state: 'idle' }]) {
    assert.throws(judge(status), error => honest(error)
      && new RegExp(`the wizard showed a failed verification while the setup service reported ${status.state}/${status.phase ?? 'unknown'}, a disagreement`).test(error.message)
      && !/did not complete/.test(error.message) && !/did not pass live verification/.test(error.message))
  }
  const ready = await postRestart([{ ui: ui('verification-failed', shown, false), status: { state: 'ready', phase: 'complete' } }])
  assert.equal(ready.result.settled.step, 'verification-failed')
  assert.throws(ready.judge, /reported ready\/complete, a disagreement/)
})

test('post-restart: the service’s verification error is preferred over an earlier failed-verification screen', () => {
  const shown = 'Local processing could not be verified.'
  const observations = [
    { elapsedMs: 0, dialogVisible: true, busy: false, step: 'verification-failed', heading: shown, statusState: 'checking', statusPhase: 'verification', statusMessage: null },
    { elapsedMs: 250, dialogVisible: true, busy: false, step: 'verification-failed', heading: shown, statusState: 'error', statusPhase: 'verification',
      statusMessage: 'Review setup to check and repair the installation.' },
  ]
  assert.throws(() => judgePostRestart({ observations, settled: observations[1], timedOut: false, timeoutMs: 1000 }),
    error => /did not pass live verification/.test(error.message) && /at 250 ms/.test(error.message) && !/did not complete/.test(error.message))
})

test('post-restart: the checking step in the wizard alone counts as the observed check', async () => {
  // Setup status never read `checking`; the wizard showed its checking step.
  const { judge } = await postRestart([
    { ui: ui('checking', 'Checking your setup.', false), status: { state: 'idle', phase: 'preflight' } },
    { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready', phase: 'complete' } },
  ])
  assert.equal(judge().step, 'ready')
})

test('post-restart: settled restart, progress or error screens and status errors fail', async () => {
  for (const [frames, pattern] of [
    [[{ ui: ui('restart', 'Restart to finish setup.', false), status: { state: 'idle' } }], /settled on restart after restart, not ready/],
    [[{ ui: ui('progress', 'We’ll take it from here.', false), status: { state: 'running' } }], /settled on progress/],
    [[{ ui: ui('error', 'Setup could not finish.', false), status: { state: 'error' } }], /product defect/],
    [[{ ui: ui('checking', 'Checking your setup.', false), status: { state: 'error' } }, { ui: ui('ready', 'Let’s add your first song.', false), status: { state: 'ready' } }], /product defect/],
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
  assert.ok(WIZARD_LIMITATIONS.some(line => /does not separate runtime transfer, unpacking/.test(line)))
  assert.ok(!WIZARD_LIMITATIONS.some(line => /no archive extraction phase/.test(line)), 'delivery-specific limitations come from the catalog')
  assert.ok(WIZARD_LIMITATIONS.some(line => /components and memory requirements from the plan/.test(line)))
  assert.ok(Object.isFrozen(WIZARD_LIMITATIONS))
})

test('an archive catalog plan from the product preflight binds to the harness summary, identity and consent text', async t => {
  const fixture = productFixture({ archive: true })
  const offered = await productPlan(t, fixture)
  assert.equal(offered.available, true, offered.reason)
  const summary = summarizeCatalog(Buffer.from(fixture.shipped))
  const runtime = offered.components.find(component => component.label === RUNTIME_COMPONENT_LABEL)
  assert.deepEqual([runtime.bytes, runtime.installedBytes], [summary.runtimeBytes, summary.runtimeInstalledBytes])
  assert.deepEqual([summary.runtimeBytes, summary.runtimeInstalledBytes], [9, 14])
  const recorded = assertWizardPlan(offered, summary, summary.runtimeLockSha256)
  assert.deepEqual(recorded.runtime.sources, ['https://127.0.0.1:8443'])
  const identity = assertPlanIdentity(offered, { catalogRuntime: JSON.parse(fixture.shipped).runtime, policy: JSON.parse(fixture.policyText) })
  assert.equal(identity.planId, offered.planId)
  const formatted = offered.components.map(component => component.bytes.toLocaleString('en-US'))
  const text = offered.components.map((component, index) => `${component.label} · ${formatSize(component.bytes)} (${formatted[index]} bytes)`
    + (component === runtime ? ` to retrieve, ${formatSize(component.installedBytes)} installed` : '')).join('\n') + '\nInstall tools and models'
  assertConsentText(text, offered, formatted)
})

test('archive retrieval: tracker counts only part transfer, times unpacking, and never interrupts while unpacking', () => {
  const tracker = createStatusTracker({ runtimeBytes: 420, start: 0 })
  const part = (file, part, received, total) => ({ state: 'running', phase: 'runtime', progress: { file, phase: 'retrieve', part, parts: 2, received, total } })
  const unpack = received => ({ state: 'running', phase: 'runtime', progress: { file: 'runtime/a.bin', phase: 'extract', received, total: 1000 } })
  tracker.observe({ state: 'running', phase: 'preflight' }, 0)
  tracker.observe(part('tools.pack.gz.001', 1, 0, 300), 100)
  let observation = tracker.observe(part('tools.pack.gz.001', 1, 150, 300), 200)
  assert.equal(observation.runtimeFraction, 150 / 420)
  assert.equal(shouldInterrupt(observation, part('tools.pack.gz.001', 1, 150, 300)), true)
  tracker.observe(part('tools.pack.gz.001', 1, 300, 300), 300)
  tracker.observe(part('tools.pack.gz.002', 2, 120, 120), 400)
  observation = tracker.observe(unpack(200), 600)
  assert.equal(observation.runtimeFraction, 1, 'unpacking never counts as retrieval')
  assert.equal(shouldInterrupt({ ...observation, runtimeFraction: 0.5 }, unpack(200)), false)
  tracker.observe(unpack(1000), 900)
  // Hash checks and the self-test after unpacking report no progress.
  tracker.observe(unpack(1000), 1400)
  tracker.observe({ state: 'restart-required', phase: 'complete' }, 1500)
  assert.deepEqual(tracker.summary().find(entry => entry.phase === 'runtime'),
    { attempt: 1, phase: 'runtime', observedMs: 1300, transferObservedMs: 300, postTransferObservedMs: 1000, unpackObservedMs: 300, postUnpackObservedMs: 500 })
  assert.deepEqual(tracker.fileObservations('runtime', 'tools.pack.gz.001'), { received: 300, total: 300, firstReceived: 0, minReceived: 0 })
  assert.equal(tracker.fileObservations('runtime', 'runtime/a.bin'), null)
})

test('archive parts map to their logged paths and staged partial files', t => {
  const runtime = archiveCatalog().runtime
  assert.equal(runtimeFileUrlPath(runtime, 'tools.pack.gz.002'), '/v1/tools.pack.gz.002')
  assert.equal(runtimeFileForUrlPath(runtime, '/v1/tools.pack.gz.001?sig=1'), 'tools.pack.gz.001')
  assert.throws(() => runtimeFileUrlPath(runtime, 'runtime/a.bin'), /not in the packaged catalog/)
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-archive-'))), id = 'd'.repeat(64)
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const parts = join(profile, 'processing', 'staging', `${'d'.repeat(16)}.archive`)
  mkdirSync(parts, { recursive: true }); writeFileSync(join(parts, 'part-002.partial'), Buffer.alloc(64))
  assert.equal(partialRuntimeBytes(profile, id, 'tools.pack.gz.002', runtime), 64)
  assert.equal(partialRuntimeBytes(profile, id, 'tools.pack.gz.001', runtime), null)
  symlinkSync(join(parts, 'part-002.partial'), join(parts, 'part-001.partial'))
  assert.equal(partialRuntimeBytes(profile, id, 'tools.pack.gz.001', runtime), null)
  assert.throws(() => partialRuntimeBytes(profile, id, '../escape', runtime), /not in the packaged catalog/)
})

test('an interrupted archive part must resume with a Range request when the server log is available', () => {
  const runtime = archiveCatalog().runtime, summary = summarizeCatalog(bytesOf(archiveCatalog()))
  const path = runtimeFileUrlPath(runtime, 'tools.pack.gz.001'), at = '2026-01-01T00:00:10.000Z'
  const line = (started, fields) => JSON.stringify({ started, time: started, method: 'GET', url: path, range: null, status: 200, bytes: 300, ...fields })
  const first = line('2026-01-01T00:00:05.000Z', { outcome: 'injected-failure', bytes: 120 })
  const retry = log => classifyRetry({ bytesPresent: 120, log: parsePackServerLog(log.join('\n')), path, after: at, size: 300 })
  const resumed = retry([first, line('2026-01-01T00:00:20.000Z', { range: 'bytes=120-', status: 206, bytes: 180, outcome: 'complete' })])
  assert.equal(resumed.classification, 'resumed')
  assertArchiveRetryResumed(summary, resumed, { logged: true })
  const restarted = retry([first, line('2026-01-01T00:00:20.000Z', { outcome: 'complete' })])
  assert.throws(() => assertArchiveRetryResumed(summary, restarted, { logged: true }), /refetched the interrupted runtime archive part from zero/)
  assert.throws(() => assertArchiveRetryResumed(summary, retry([first]), { logged: true }), /could not be shown to resume/)
  const offset = retry([first, line('2026-01-01T00:00:20.000Z', { range: 'bytes=60-', status: 206, bytes: 240, outcome: 'complete' })])
  assert.throws(() => assertArchiveRetryResumed(summary, offset, { logged: true }), /from byte 60, not from the 120 bytes kept/)
  // Without the log, or for a per-file runtime, the classification stays evidence only.
  assertArchiveRetryResumed(summary, restarted, { logged: false })
  assertArchiveRetryResumed(summarizeCatalog(bytesOf(catalog())), restarted, { logged: true })
})

test('retry classification requires a complete resume of exactly the remaining bytes and no later refetch from zero', () => {
  const at = '2026-01-01T00:00:10.000Z'
  const first = logLine('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:10.500Z', { outcome: 'aborted', bytes: null })
  const resume = fields => logLine('2026-01-01T00:00:20.000Z', '2026-01-01T00:00:21.000Z', { range: 'bytes=300-', status: 206, bytes: 300, outcome: 'complete', ...fields })
  const classify = (lines, size = 600) => classifyRetry({ bytesPresent: 300, log: parsePackServerLog([first, ...lines].join('\n')), path: '/a.bin', after: at, size })
  const ok = classify([resume()])
  assert.equal(ok.classification, 'resumed'); assert.equal(ok.partSize, 600); assert.equal(ok.request.outcome, 'complete')
  // The resume request must be served to completion.
  for (const outcome of ['aborted', 'injected-failure', undefined]) {
    const result = classify([resume({ outcome })])
    assert.equal(result.classification, 'unproven'); assert.match(result.reason, /not served completely/)
  }
  // It must serve exactly size - N bytes.
  const short = classify([resume({ bytes: 200 })])
  assert.equal(short.classification, 'unproven'); assert.match(short.reason, /served 200 bytes, not the 300 bytes after byte 300/)
  assert.equal(classify([resume({ bytes: null })]).classification, 'unproven')
  // Without a known size the byte count is not compared.
  assert.equal(classify([resume({ bytes: 200 })], null).classification, 'resumed')
  // A later refetch of the same path from zero (200, or bytes=0-) undoes the resume.
  for (const refetch of [{ range: null, status: 200, bytes: 600 }, { range: 'bytes=0-', status: 206, bytes: 600 }]) {
    const result = classify([resume(), logLine('2026-01-01T00:00:30.000Z', '2026-01-01T00:00:31.000Z', { outcome: 'complete', ...refetch })])
    assert.equal(result.classification, 'restarted'); assert.match(result.reason, /requested again from zero/)
    assert.equal(result.request.started, '2026-01-01T00:00:30.000Z'); assert.equal(result.resumeRequest.started, '2026-01-01T00:00:20.000Z')
  }
  // A later request for another path, or a later resume of this one, does not.
  const other = logLine('2026-01-01T00:00:30.000Z', '2026-01-01T00:00:31.000Z', { url: '/b.bin', outcome: 'complete' })
  assert.equal(classify([resume(), other]).classification, 'resumed')
})

test('an archive retry passes only when some but not all of the part was kept and it resumed from exactly there', () => {
  const summary = summarizeCatalog(bytesOf(archiveCatalog())), runtime = archiveCatalog().runtime
  const path = runtimeFileUrlPath(runtime, 'tools.pack.gz.001'), at = '2026-01-01T00:00:10.000Z'
  const line = (started, fields) => JSON.stringify({ started, time: started, method: 'GET', url: path, range: null, status: 200, bytes: 300, outcome: 'complete', ...fields })
  const first = line('2026-01-01T00:00:05.000Z', { outcome: 'injected-failure', bytes: 120 })
  const classify = (bytesPresent, lines) => classifyRetry({ bytesPresent, log: parsePackServerLog([first, ...lines].join('\n')), path, after: at, size: 300 })
  const resumedFrom = from => line('2026-01-01T00:00:20.000Z', { range: `bytes=${from}-`, status: 206, bytes: 300 - from })
  const fromZero = line('2026-01-01T00:00:20.000Z', {})
  const unproven = pattern => error => error.message.startsWith(UNPROVEN_RESUME) && pattern.test(error.message) && !/refetched/.test(error.message)
  // (a) Kept bytes unknown: no resume can be shown, whatever the log says.
  for (const lines of [[resumedFrom(120)], [fromZero], []]) {
    assert.throws(() => assertArchiveRetryResumed(summary, classify(null, lines), { logged: true }),
      unproven(/bytes kept of that part after the stop are unknown/))
  }
  // (c) Nothing kept: retrieving from zero is correct, and still unproven.
  for (const lines of [[fromZero], []]) {
    assert.throws(() => assertArchiveRetryResumed(summary, classify(0, lines), { logged: true }), unproven(/nothing was kept .*0 bytes.*a resume could not be shown/))
  }
  // (c) The part completed before the stop took effect and was not requested again.
  assert.throws(() => assertArchiveRetryResumed(summary, classify(300, []), { logged: true }),
    unproven(/already complete on disk \(300 of 300 bytes\) when the stop took effect and was not requested again, so a resume could not be shown/))
  assert.throws(() => assertArchiveRetryResumed(summary, classify(300, [fromZero]), { logged: true }),
    error => unproven(/already complete on disk/)(error) && !/not requested again/.test(error.message))
  // Some bytes kept: the product must resume from exactly them.
  assertArchiveRetryResumed(summary, classify(120, [resumedFrom(120)]), { logged: true })
  assert.throws(() => assertArchiveRetryResumed(summary, classify(120, [fromZero]), { logged: true }),
    /refetched the interrupted runtime archive part from zero instead of resuming it with a Range request from the 120 bytes kept/)
  assert.throws(() => assertArchiveRetryResumed(summary, classify(120, [resumedFrom(60)]), { logged: true }), /from byte 60, not from the 120 bytes kept/)
  // The part size must be known to judge an archive retry.
  assert.throws(() => assertArchiveRetryResumed(summary, { ...classify(120, [resumedFrom(120)]), partSize: null }, { logged: true }), /requires the interrupted part size/)
})

test('the failed archive part is the one the server log names, with its kept bytes staged at stop time', t => {
  const runtime = archiveCatalog().runtime, id = 'd'.repeat(64)
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'wizard-staged-')))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const parts = join(profile, 'processing', 'staging', `${'d'.repeat(16)}.archive`)
  mkdirSync(parts, { recursive: true })
  writeFileSync(join(parts, 'part-001.partial'), Buffer.alloc(300)); writeFileSync(join(parts, 'part-002.partial'), Buffer.alloc(64))
  const staged = stagedArchivePartBytes(profile, id, runtime)
  assert.deepEqual(staged, { 'tools.pack.gz.001': 300, 'tools.pack.gz.002': 64 })
  rmSync(join(parts, 'part-002.partial'))
  assert.deepEqual(stagedArchivePartBytes(profile, id, runtime), { 'tools.pack.gz.001': 300, 'tools.pack.gz.002': null })
  assert.throws(() => stagedArchivePartBytes(profile, id, catalog().runtime), /require an archive runtime/)
  // Setup progress last named part 1 (complete); the server failed part 2.
  const failedAt = '2026-01-01T00:00:06.000Z'
  const log = parsePackServerLog([
    JSON.stringify({ started: '2026-01-01T00:00:01.000Z', time: '2026-01-01T00:00:02.000Z', method: 'GET', url: '/v1/tools.pack.gz.001', range: null, status: 200, bytes: 300, outcome: 'complete' }),
    JSON.stringify({ started: '2026-01-01T00:00:03.000Z', time: failedAt, method: 'GET', url: '/v1/tools.pack.gz.002', range: null, status: 200, bytes: 64, outcome: 'injected-failure' }),
  ].join('\n'))
  const recovery = { kind: 'injected-failure', at: '2026-01-01T00:00:07.000Z', file: 'tools.pack.gz.001', bytesPresentAfterStop: 300, stagedPartsAfterStop: staged }
  const target = resolveRetryTarget({ runtime, recovery, log })
  assert.deepEqual({ ...target, serverInjectedFailure: target.serverInjectedFailure.url },
    { file: 'tools.pack.gz.002', path: '/v1/tools.pack.gz.002', size: 120, after: failedAt, bytesPresent: 64, serverInjectedFailure: '/v1/tools.pack.gz.002' })
  // A failed part with no staged file has unknown kept bytes, never another part's.
  assert.equal(resolveRetryTarget({ runtime, recovery: { ...recovery, stagedPartsAfterStop: { ...staged, 'tools.pack.gz.002': null } }, log }).bytesPresent, null)
  assert.throws(() => resolveRetryTarget({ runtime, recovery, log: [...log, ...log] }), /exactly one injected failure/)
  // Without the log (or for a cancel) the unit is the one setup progress named.
  assert.deepEqual(resolveRetryTarget({ runtime, recovery, log: null }),
    { file: 'tools.pack.gz.001', path: '/v1/tools.pack.gz.001', size: 300, after: recovery.at, bytesPresent: 300 })
  assert.deepEqual(resolveRetryTarget({ runtime, recovery: { kind: 'cancel', at: recovery.at, file: null }, log }),
    { file: null, path: undefined, size: null, after: recovery.at, bytesPresent: null })
  // Per-file delivery has no staged map: kept bytes belong only to the file progress named.
  const files = catalog().runtime
  const fileLog = parsePackServerLog(logLine('2026-01-01T00:00:03.000Z', failedAt, { url: '/b.bin', outcome: 'injected-failure' }))
  const perFile = { kind: 'injected-failure', at: recovery.at, file: 'runtime/a.bin', bytesPresentAfterStop: 37 }
  assert.equal(resolveRetryTarget({ runtime: files, recovery: perFile, log: fileLog }).bytesPresent, null)
  assert.equal(resolveRetryTarget({ runtime: files, recovery: perFile, log: null }).bytesPresent, 37)
})

// A fake page over the dialogs on screen. The hooked dialog is shown always,
// never, or only once its first visibility check has returned (it opens right
// then). Role queries see every dialog; intersected with the exact
// not-onboarding selector they skip the hooked one, as Playwright would.
function hooksPage({ hooked = false, opensAfterFirstCheck = false, dataStep = 'welcome', other = false }) {
  let shown = hooked
  const dialogs = () => [...(shown ? [{ onboarding: true }] : []), ...(other ? [{ onboarding: false }] : [])]
  const visible = excludeOnboarding => async () => dialogs().some(item => !(excludeOnboarding && item.onboarding))
  return {
    getByTestId: () => ({
      isVisible: async () => { const now = shown; if (opensAfterFirstCheck) shown = true; return now },
      getAttribute: async () => dataStep,
    }),
    getByRole: () => ({ first: () => ({ isVisible: visible(false) }), and: filter => ({ first: () => ({ isVisible: visible(filter.excludesOnboarding) }) }) }),
    locator: selector => ({ excludesOnboarding: selector === ':not([data-testid="onboarding-dialog"])' }),
  }
}

test('a hooked dialog that opens between the two dialog reads is not taken for a hookless candidate', async () => {
  // The hooked dialog is invisible on the first check and visible afterwards.
  await assertWizardHooks(hooksPage({ opensAfterFirstCheck: true }), { timeoutMs: 100, interval: 1 })
  // Another dialog is showing too: the hooked dialog is checked again before failing.
  await assertWizardHooks(hooksPage({ opensAfterFirstCheck: true, other: true }), { timeoutMs: 100, interval: 1 })
  // Without the hooked dialog ever opening, the other dialog still fails the run.
  await assert.rejects(assertWizardHooks(hooksPage({ other: true }), { timeoutMs: 100, interval: 1 }),
    error => error.message.startsWith(HOOKLESS_CANDIDATE) && /without data-testid/.test(error.message))
})

test('a candidate without the wizard hooks fails at once, naming the reason', async () => {
  const page = ({ hooked = false, dataStep = null, other = false }) => hooksPage({ hooked, dataStep, other })
  await assertWizardHooks(page({ hooked: true, dataStep: 'welcome' }), { timeoutMs: 100, interval: 1 })
  await assert.rejects(assertWizardHooks(page({ other: true }), { timeoutMs: 100, interval: 1 }),
    error => error.message.startsWith(HOOKLESS_CANDIDATE) && /without data-testid/.test(error.message))
  await assert.rejects(assertWizardHooks(page({ hooked: true }), { timeoutMs: 100, interval: 1 }), /predates the wizard test hooks.*no data-step/)
  await assert.rejects(assertWizardHooks(page({}), { timeoutMs: 20, interval: 1 }), /No setup dialog appeared/)
  await assert.rejects(assertWizardHooks(page({}), {}), /requires a timeout/)
})
