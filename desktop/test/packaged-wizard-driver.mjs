// SPDX-License-Identifier: AGPL-3.0-only
// Test-only driver for the packaged first-launch setup wizard. It acts only
// through the visible renderer controls; bridge calls are reads
// (preflightSetup, getSetupStatus, getOnboardingState). Pure helpers are
// exported for unit tests and never launch Electron.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCAL_MODEL_IDS = Object.freeze(['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer'])
export const RUNTIME_COMPONENT_LABEL = 'Local processing runtime'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

// Visible step headings (DesktopOnboarding.vue). Text locators are the only
// hooks the component offers; see the README for the stable hooks that would
// make this independent of copy changes.
const HEADINGS = [
  ['welcome', 'Your library. Your stage.'],
  ['choose', 'Where should we prepare your songs?'],
  ['consent', 'Review your installation.'],
  ['modal', 'Your account. Your control.'],
  ['progress', 'We’ll take it from here.'],
  ['cancelled', 'Setup cancelled.'],
  ['error', 'Setup could not finish.'],
  ['restart', 'Restart to finish setup.'],
  ['ready', 'Let’s add your first song.'],
]
export const normalizeText = text => String(text ?? '').replace(/\s+/gu, ' ').trim()
export function stepFromHeading(text) {
  const normalized = normalizeText(text)
  return HEADINGS.find(([, heading]) => heading === normalized)?.[0] ?? null
}

// The shipped catalog is read from the application's own archive; the setup
// engine validates and loads the same file at startup.
export function summarizeCatalog(bytes) {
  const catalog = JSON.parse(Buffer.from(bytes).toString('utf8'))
  assert.equal(catalog?.schema, 1, 'Packaged processing catalog has an unsupported schema')
  const runtime = catalog.runtime
  assert.ok(runtime && Array.isArray(runtime.files) && runtime.files.length > 0, 'Packaged processing catalog has no runtime files')
  const q = catalog.qualification ?? {}
  return {
    sha256: sha256(bytes),
    // Same identity the application assigns the installed runtime.
    runtimeId: sha256(JSON.stringify(runtime)),
    runtimeLockSha256: runtime.provenance?.lockSha256 ?? null,
    target: { platform: runtime.platform, arch: runtime.arch, accelerator: runtime.accelerator },
    runtimeBytes: runtime.files.reduce((sum, file) => sum + file.size, 0),
    runtimeFiles: runtime.files.length,
    runtimeSources: [...new Set(runtime.files.map(file => new URL(file.url).origin))].sort(),
    qualification: { passed: q.passed, runtimeLockSha256: q.runtimeLockSha256 ?? null, platform: q.platform, arch: q.arch,
      accelerator: q.accelerator, evidenceReference: q.evidenceReference ?? null,
      ...(Object.hasOwn(q, 'qualificationScope') && { qualificationScope: q.qualificationScope }) },
    models: (catalog.models ?? []).map(entry => ({ id: entry.id, terms: (entry.terms ?? []).map(({ label, url }) => ({ label, url })) })),
  }
}

export function assertCatalogLock(summary, expectedLock, host) {
  assert.match(expectedLock, /^[a-f0-9]{64}$/u, 'Expected runtime lock must be 64 lowercase hex characters')
  assert.equal(summary.runtimeLockSha256, expectedLock, 'Packaged catalog runtime lock differs from the expected lock')
  assert.equal(summary.qualification.runtimeLockSha256, expectedLock, 'Packaged catalog qualification is bound to a different lock')
  assert.equal(summary.qualification.passed, true, 'Packaged catalog qualification is not marked passed')
  for (const key of ['platform', 'arch', 'accelerator']) {
    assert.equal(summary.qualification[key], summary.target[key], `Packaged catalog qualification ${key} differs from its runtime`)
  }
  assert.equal(summary.target.platform, host.platform, 'Packaged catalog targets a different platform')
  assert.equal(summary.target.arch, host.arch, 'Packaged catalog targets a different architecture')
}

// Binds what the UI was offered (preflight plan) to the shipped catalog and
// the operator's expected lock. The plan itself carries no lock; the runtime
// component's exact bytes and sources tie it to the catalog runtime.
export function assertWizardPlan(plan, summary, expectedLock) {
  assert.equal(plan?.available, true, `Local setup is not available: ${plan?.reason ?? 'no reason given'}`)
  assert.equal(plan.ready, false, 'Fresh profile unexpectedly reports local processing ready')
  assert.equal(plan.restartRequired, false, 'Fresh profile unexpectedly requires restart')
  assert.equal(plan.modelSource, 'upstream', 'Wizard qualification requires upstream model sources')
  assert.equal(plan.runtimeTransferRequired, true, 'Fresh setup must retrieve the processing runtime')
  assert.equal(typeof plan.planId, 'string', 'Plan has no identity')
  assert.equal(summary.runtimeLockSha256, expectedLock, 'Plan runtime lock differs from the expected lock')
  const runtime = plan.components.filter(component => component.label === RUNTIME_COMPONENT_LABEL)
  assert.equal(runtime.length, 1, 'Plan must offer exactly one processing runtime')
  assert.equal(runtime[0].bytes, summary.runtimeBytes, 'Plan runtime size differs from the packaged catalog runtime')
  assert.deepEqual([...runtime[0].sources].sort(), summary.runtimeSources, 'Plan runtime sources differ from the packaged catalog runtime')
  const models = plan.components.filter(component => component.label !== RUNTIME_COMPONENT_LABEL)
  for (const id of LOCAL_MODEL_IDS) {
    const entry = models.find(component => component.label === id)
    assert.ok(entry, `Plan omits model ${id}`)
    assert.equal(entry.sourceMode, 'upstream', `Plan model ${id} is not retrieved from upstream`)
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, `Plan model ${id} has no transfer size`)
    assert.ok(Array.isArray(entry.terms) && entry.terms.length > 0, `Plan model ${id} has no terms`)
    for (const term of entry.terms) assert.equal(new URL(term.url).protocol, 'https:', `Plan model ${id} terms URL is not HTTPS`)
  }
  return {
    planId: plan.planId, runtimeLockSha256: expectedLock, target: summary.target,
    runtime: { bytes: runtime[0].bytes, sources: runtime[0].sources, terms: runtime[0].terms },
    models: models.map(component => ({ id: component.label, bytes: component.bytes, sources: component.sources,
      terms: (component.terms ?? []).map(({ label, url }) => ({ label, url })) })),
    transferBytes: plan.components.reduce((sum, component) => sum + component.bytes, 0),
    diskRequiredBytes: plan.diskRequiredBytes, diskFreeBytes: plan.diskFreeBytes,
    memoryRequirements: plan.memoryRequirements, memoryQualification: plan.memoryQualification,
    ...(Object.hasOwn(plan, 'qualificationScope') && { qualificationScope: plan.qualificationScope }),
    ...(Object.hasOwn(summary.qualification, 'qualificationScope') && { catalogQualificationScope: summary.qualification.qualificationScope }),
  }
}

// The consent screen must show every component and exact byte count it asks
// consent for. `formatted` is each component's byte count as the renderer
// formats it (toLocaleString in the renderer's own locale).
export function assertConsentText(text, plan, formatted) {
  const normalized = normalizeText(text)
  for (const [index, component] of plan.components.entries()) {
    assert.ok(normalized.includes(component.label), `Consent screen omits ${component.label}`)
    assert.ok(normalized.includes(`(${formatted[index]} bytes)`), `Consent screen omits the exact size of ${component.label}`)
  }
  assert.ok(normalized.includes('Install tools and models'), 'Consent screen has no install control')
}

// Status state machine. Setup status reports one phase per stage
// (preflight, runtime, models, verification, complete, paused) plus
// per-file progress. Runtime transfer, hash verification and the runtime
// self-test all report phase `runtime`; the split below uses the last
// progress change as the end of transfer, which is an observation bound.
export function createStatusTracker({ runtimeBytes, start = Date.now() } = {}) {
  assert.ok(Number.isSafeInteger(runtimeBytes) && runtimeBytes > 0, 'Tracker requires the runtime size')
  const transitions = [], phases = new Map(), files = new Map()
  let attempt = 1, previous = null, last = null
  const touch = (phase, at) => {
    const key = `${attempt}:${phase}`
    if (!phases.has(key)) phases.set(key, { attempt, phase, firstMs: at - start, lastMs: at - start, lastProgressMs: null })
    const record = phases.get(key); record.lastMs = at - start
    return record
  }
  function runtimeFraction() {
    let received = 0
    for (const [key, value] of files) if (key.startsWith(`${attempt}:runtime:`)) received += Math.min(value.received, value.total)
    return received / runtimeBytes
  }
  function observe(status, at = Date.now()) {
    assert.ok(status && typeof status.state === 'string', 'Setup status is malformed')
    const signature = `${status.state}/${status.phase}`
    let transition = null
    if (signature !== previous) {
      transition = { attempt, elapsedMs: at - start, state: status.state, phase: status.phase, message: status.message ?? null,
        ...(status.error && { error: status.error }), retryable: status.retryable === true }
      transitions.push(transition); previous = signature
    }
    const record = touch(status.phase, at)
    const progress = status.progress
    if (progress && typeof progress.file === 'string' && Number.isSafeInteger(progress.received) && Number.isSafeInteger(progress.total)) {
      const key = `${attempt}:${status.phase}:${progress.file}`
      const prior = files.get(key)
      if (!prior || prior.received !== progress.received) record.lastProgressMs = at - start
      files.set(key, { received: Math.max(prior?.received ?? 0, progress.received), total: progress.total,
        firstReceived: prior?.firstReceived ?? progress.received, minReceived: Math.min(prior?.minReceived ?? Infinity, progress.received) })
    }
    last = status
    const terminal = ['ready', 'restart-required', 'error', 'cancelled'].includes(status.state) ? status.state : null
    return { transition, terminal, runtimeFraction: runtimeFraction(), progress: progress ?? null }
  }
  function nextAttempt() { attempt += 1; previous = null }
  function fileObservations(phase, file, onAttempt = attempt) { return files.get(`${onAttempt}:${phase}:${file}`) ?? null }
  function summary() {
    const result = []
    for (const record of phases.values()) {
      const entry = { attempt: record.attempt, phase: record.phase, observedMs: record.lastMs - record.firstMs }
      if (record.phase === 'runtime' && record.lastProgressMs !== null) {
        entry.transferObservedMs = record.lastProgressMs - record.firstMs
        entry.postTransferObservedMs = record.lastMs - record.lastProgressMs
      }
      if (record.phase === 'models' && record.lastProgressMs !== null) entry.transferObservedMs = record.lastProgressMs - record.firstMs
      result.push(entry)
    }
    return result
  }
  return { observe, nextAttempt, summary, transitions, fileObservations, runtimeFraction, get attempt() { return attempt }, get last() { return last } }
}

// Interrupt only during actual runtime byte transfer, after at least 5%.
export function shouldInterrupt(observation, status, { minimumFraction = 0.05 } = {}) {
  return status?.state === 'running' && status.phase === 'runtime' && observation.runtimeFraction >= minimumFraction
    && observation.runtimeFraction < 1 && observation.progress !== null && observation.progress.received < observation.progress.total
}

// Polling cannot see every progress event; classify conservatively.
export function classifyRetry({ bytesPresent, retry }) {
  if (!Number.isSafeInteger(bytesPresent) || bytesPresent <= 0) return { classification: 'no-partial-bytes-present', bytesPresent: bytesPresent ?? null }
  if (!retry) return { classification: 'indeterminate', reason: 'The interrupted file was not observed during retry', bytesPresent }
  if (retry.minReceived < bytesPresent) {
    return { classification: 'restarted', bytesPresent, firstObservedReceived: retry.firstReceived, minimumObservedReceived: retry.minReceived }
  }
  return { classification: 'consistent-with-resume', bytesPresent, firstObservedReceived: retry.firstReceived,
    note: 'No retry observation fell below the bytes already present; correlate with the source server Range log for proof' }
}

// Staging location used by the application's runtime store; read-only stat.
export function partialRuntimeBytes(profile, runtimeId, file) {
  assert.match(runtimeId, /^[a-f0-9]{64}$/u)
  assert.ok(typeof file === 'string' && !file.split('/').includes('..') && !file.startsWith('/'), 'Unsafe runtime file path')
  const info = lstatSync(join(profile, 'processing', 'staging', runtimeId, ...file.split('/')) + '.partial', { throwIfNoEntry: false })
  return info?.isFile() && !info.isSymbolicLink() ? info.size : null
}

// After the harness relaunch: the active runtime must be exactly the
// promised one, read back from the profile's own installed manifest.
export function installedRuntimeIdentity(profile, runtimeId) {
  assert.match(runtimeId ?? '', /^[a-f0-9]{64}$/u, 'Application reports no active runtime identity')
  const path = join(profile, 'processing', 'packs', runtimeId, 'manifest.json')
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Installed runtime manifest must be a regular file')
  const bytes = readFileSync(path), manifest = JSON.parse(bytes)
  return { runtimeId, manifestSha256: sha256(bytes), canonicalId: sha256(JSON.stringify(manifest)),
    runtimeLockSha256: manifest.provenance?.lockSha256 ?? null, target: { platform: manifest.platform, arch: manifest.arch, accelerator: manifest.accelerator } }
}

export function assertPostRestart({ onboarding, status, plan, readiness, installed }, summary, expectedLock) {
  assert.equal(onboarding.dialogVisible, false, 'Onboarding was shown again after setup completed and the app restarted')
  assert.equal(status?.state, 'ready', `Setup status after restart is ${status?.state ?? 'missing'}, not ready`)
  assert.equal(plan?.ready, true, 'Preflight after restart does not report local processing ready')
  assert.equal(plan.restartRequired, false, 'Preflight after restart still requires a restart')
  assert.equal(readiness?.runtime?.id, summary.runtimeId, 'Application activated a different runtime than the plan promised')
  assert.equal(installed.canonicalId, summary.runtimeId, 'Installed runtime manifest does not match its identity')
  assert.equal(installed.runtimeLockSha256, expectedLock, 'Installed runtime lock differs from the expected lock')
  assert.deepEqual(installed.target, summary.target, 'Installed runtime target differs from the plan')
  assert.equal(readiness.separation?.ready, true, 'Separation is not ready after restart')
  assert.equal(readiness.transcription?.ready, true, 'Transcription is not ready after restart')
}

export const WIZARD_LIMITATIONS = Object.freeze([
  'Wizard mode processes a single track; it is not full release qualification',
  'The UI restart control is exercised up to application exit; the application\'s own relaunch request is intercepted and recorded, and the harness relaunches the same executable and profile',
  'Setup status does not separate runtime transfer, hash verification and runtime self-test; their split is an observation bound from the last progress change',
  'Runtime files are transferred individually; there is no archive extraction phase to time',
  'Model retrieval is from the policy-defined upstream sources the application selects; source availability is not under harness control',
])

// ---- Playwright steps (require a live packaged application) ----

export function onboardingDialog(page) { return page.getByRole('dialog', { name: /setup$/u }) }

export async function currentStep(page) {
  const dialog = onboardingDialog(page)
  if (!await dialog.isVisible()) return null
  const heading = dialog.getByRole('heading', { level: 1 })
  return stepFromHeading(await heading.innerText({ timeout: 2000 }).catch(() => ''))
}

export async function waitForStep(page, expected, { timeoutMs, interval = 250 } = {}) {
  const wanted = [expected].flat(), deadline = Date.now() + timeoutMs
  let seen
  while (Date.now() < deadline) {
    seen = await currentStep(page)
    if (wanted.includes(seen)) return seen
    await pause(interval)
  }
  throw new Error(`Setup wizard did not reach ${wanted.join(' or ')} (last step: ${seen ?? 'none'})`)
}

const button = (page, name) => onboardingDialog(page).getByRole('button', { name })

export async function chooseLocalAndContinue(page, { timeoutMs }) {
  await waitForStep(page, 'choose', { timeoutMs })
  const local = button(page, /^On this computer/u)
  if (await local.isDisabled()) {
    throw new Error(`Local processing is unavailable in the wizard: ${normalizeText(await onboardingDialog(page).locator('#local-reason').innerText())}`)
  }
  if (await local.getAttribute('aria-pressed') !== 'true') await local.click()
  assert.equal(await local.getAttribute('aria-pressed'), 'true', 'Local processing choice was not selected')
  await button(page, 'Continue →').click()
  await waitForStep(page, 'consent', { timeoutMs })
}

export async function readPlan(page) { return page.evaluate(() => window.karaokeDesktop.preflightSetup()) }
export async function readStatus(page) { return page.evaluate(() => window.karaokeDesktop.getSetupStatus()) }

export async function consentSnapshot(page, plan) {
  const text = await onboardingDialog(page).innerText()
  const formatted = await page.evaluate(values => values.map(value => Number(value).toLocaleString()), plan.components.map(component => component.bytes))
  assertConsentText(text, plan, formatted)
  return { text: normalizeText(text), sha256: sha256(Buffer.from(normalizeText(text))) }
}

export async function acceptConsent(page) {
  const install = button(page, /^Install tools and models/u)
  assert.equal(await install.isEnabled(), true, 'Install control is disabled')
  await install.click()
}

export async function cancelFromUi(page) {
  const dialog = onboardingDialog(page)
  const summary = dialog.locator('summary', { hasText: 'Setup controls' })
  const details = dialog.locator('details', { has: summary })
  if (await details.getAttribute('open') === null) await summary.click()
  await button(page, 'Cancel setup').click()
}

export async function retryFromUi(page, { timeoutMs }) {
  await button(page, 'Review setup and retry').click()
  await chooseLocalAndContinue(page, { timeoutMs })
}

export async function clickRestart(page) {
  // The application quits during this action; Playwright may lose the page.
  await button(page, /^Restart /u).click({ noWaitAfter: true, timeout: 10000 })
}

// Records the application's relaunch request instead of letting it spawn an
// unowned instance that would hold the single-instance profile lock.
export async function interceptRelaunch(application, markerPath) {
  await application.evaluate(({ app }, marker) => {
    const fs = process.getBuiltinModule('fs')
    app.relaunch = options => {
      fs.writeFileSync(marker, `${JSON.stringify({ requestedAt: new Date().toISOString(), options: options ?? null })}\n`, { flag: 'wx' })
    }
  }, markerPath)
}

export async function observeOnboarding(page, { settleMs = 2000, timeoutMs = 30000 } = {}) {
  // The library shell renders this control immediately; the onboarding
  // decision follows its own preference read.
  await page.getByRole('button', { name: /Set up song processing|⚙/u }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  const preferences = await page.evaluate(() => window.karaokeDesktop.getOnboardingState())
  await pause(settleMs)
  const dialogVisible = await onboardingDialog(page).isVisible()
  return { dialogVisible, step: dialogVisible ? await currentStep(page) : null, preferences }
}
