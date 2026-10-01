// SPDX-License-Identifier: AGPL-3.0-only
// Test-only driver for the packaged first-launch setup wizard. It acts only
// through the visible renderer controls. Bridge calls are not all reads:
// getSetupStatus and getOnboardingState only read state, but preflightSetup
// verifies the stores and, once a runtime is installed, re-hashes it and runs
// its self-test. The harness calls preflightSetup only before consent (nothing
// installed) and only while the wizard is idle; after relaunch it lets the
// wizard's own preflight settle and never starts a second one. Pure helpers
// are exported for unit tests and never launch Electron.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'

export const LOCAL_MODEL_IDS = Object.freeze(['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer'])
export const RUNTIME_COMPONENT_LABEL = 'Local processing runtime'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// The application's own content identity: SHA-256 of the JSON serialization.
const jsonIdentity = value => sha256(JSON.stringify(value))
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

// Steps are read from the dialog's `data-step` hook; wizard mode requires a
// candidate that has the hooks. The error step carries three outcomes that
// only its heading names, so the heading refines that step alone:
// `cancelled` (a cancelled or interrupted status), `verification-failed` (an
// honest failed re-verification after restart) and `error` (setup could not
// finish). Any other error heading is `error-unclassified`.
const ERROR_HEADINGS = [
  ['cancelled', 'Setup cancelled.'],
  ['verification-failed', 'Local processing could not be verified.'],
  ['error', 'Setup could not finish.'],
]
export const normalizeText = text => String(text ?? '').replace(/\s+/gu, ' ').trim()
export function errorOutcomeFromHeading(text) {
  const normalized = normalizeText(text)
  return ERROR_HEADINGS.find(([, heading]) => heading === normalized)?.[0] ?? 'error-unclassified'
}
// The step a user sees: the `data-step` hook, with the error step refined.
export function stepFrom(dataStep, heading) {
  if (!dataStep) return null
  return dataStep === 'error' ? errorOutcomeFromHeading(heading) : dataStep
}

// A source a release catalog would never name: loopback, private-range or
// link-local addresses, `localhost`, or an explicit non-default port.
export function isPrivateTestOrigin(origin) {
  const url = new URL(origin)
  if (url.port !== '') return true
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
  }
  if (isIP(host) === 6) {
    // URL serializes an IPv4-mapped address in hex (::ffff:7f00:1).
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(host), hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host)
    if (dotted) return isPrivateTestOrigin(`https://${dotted[1]}`)
    if (hex) {
      const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)]
      return isPrivateTestOrigin(`https://${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return host === '::1' || host === '::' || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host)
  }
  return false
}

// The runtime's transfer units as the application retrieves them: each file
// for per-file delivery, or each part of a `concat-gzip-v1` archive. `label`
// is the name setup progress reports for the unit; for an archive part that
// is its published file name, or `archive part N` when the name is not a
// plain token (as runtime_manager.mjs names it).
const ARCHIVE_PART_NAME = /^[A-Za-z0-9._+-]{1,200}$/u
export function runtimeTransferUnits(runtime) {
  if (runtime.archive === undefined) return runtime.files.map(file => ({ label: file.path, url: file.url, size: file.size }))
  assert.equal(runtime.archive?.format, 'concat-gzip-v1', 'Packaged runtime archive has an unsupported format')
  assert.ok(Array.isArray(runtime.archive.parts) && runtime.archive.parts.length > 0, 'Packaged runtime archive has no parts')
  const units = runtime.archive.parts.map((part, index) => {
    let name = ''
    try { name = decodeURIComponent(new URL(part.url).pathname.split('/').pop()) } catch { /* named by position below */ }
    return { label: ARCHIVE_PART_NAME.test(name) ? name : `archive part ${index + 1}`, url: part.url, size: part.size, part: index + 1 }
  })
  assert.equal(new Set(units.map(unit => unit.label)).size, units.length, 'Packaged runtime archive parts do not have distinct progress names')
  return units
}

// The shipped catalog is read from the application's own archive; the setup
// engine validates and loads the same file at startup. `runtimeBytes` is what
// setup retrieves (the archive parts, or the files themselves) and
// `runtimeInstalledBytes` the unpacked file tree.
export function summarizeCatalog(bytes) {
  const catalog = JSON.parse(Buffer.from(bytes).toString('utf8'))
  assert.equal(catalog?.schema, 1, 'Packaged processing catalog has an unsupported schema')
  const runtime = catalog.runtime
  assert.ok(runtime && Array.isArray(runtime.files) && runtime.files.length > 0, 'Packaged processing catalog has no runtime files')
  const q = catalog.qualification ?? {}
  const units = runtimeTransferUnits(runtime)
  const runtimeSources = [...new Set(units.map(unit => new URL(unit.url).origin))].sort()
  return {
    sha256: sha256(bytes),
    // Same identity the application assigns the installed runtime.
    runtimeId: jsonIdentity(runtime),
    runtimeLockSha256: runtime.provenance?.lockSha256 ?? null,
    target: { platform: runtime.platform, arch: runtime.arch, accelerator: runtime.accelerator },
    delivery: runtime.archive === undefined ? 'files' : 'archive',
    runtimeBytes: units.reduce((sum, unit) => sum + unit.size, 0),
    runtimeInstalledBytes: runtime.files.reduce((sum, file) => sum + file.size, 0),
    runtimeFiles: runtime.files.length,
    runtimeParts: runtime.archive === undefined ? null : units.length,
    runtimeSources,
    privateTestSource: runtimeSources.some(isPrivateTestOrigin),
    qualification: { passed: q.passed, runtimeLockSha256: q.runtimeLockSha256 ?? null, platform: q.platform, arch: q.arch,
      accelerator: q.accelerator, evidenceReference: q.evidenceReference ?? null,
      ...(Object.hasOwn(q, 'scope') && { scope: q.scope }),
      ...(Object.hasOwn(q, 'qualificationScope') && { qualificationScope: q.qualificationScope }) },
    models: (catalog.models ?? []).map(entry => ({ id: entry.id, terms: (entry.terms ?? []).map(({ label, url }) => ({ label, url })) })),
  }
}

// Limitations implied by the catalog itself, never failures.
export function catalogLimitations(summary) {
  const limitations = [summary.delivery === 'archive'
    ? `The runtime is delivered as a ${summary.runtimeParts}-part archive; setup progress names part retrieval and unpacking, which the evidence times from observed progress changes; the runtime self-test after unpacking reports no progress of its own`
    : 'The runtime is delivered as individual files; there is no unpack phase to time']
  if (summary.privateTestSource) {
    limitations.push(`The candidate carries a private test catalog (runtime sources ${summary.runtimeSources.join(', ')}); it is not a release build`)
  }
  const scope = summary.qualification.scope
  if (scope === undefined) limitations.push('The packaged catalog declares no qualification scope; it is not marked as full qualification')
  else if (scope !== 'full') limitations.push(`The packaged catalog qualification scope is ${JSON.stringify(scope)}, not full`)
  return limitations
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

// The model manifest the setup engine selects on a profile with no installed
// models: the three default sets, in this order, with the packaged policy's
// file records (onboarding_setup.mjs selection()).
export function modelsManifestFromPolicy(policy) {
  assert.ok(policy && Array.isArray(policy.models), 'Packaged model policy is malformed')
  const files = LOCAL_MODEL_IDS.flatMap(id => {
    const entries = policy.models.filter(entry => entry.id === id)
    assert.equal(entries.length, 1, `Packaged model policy must define ${id} exactly once`)
    assert.ok(Array.isArray(entries[0].files), `Packaged model policy has no files for ${id}`)
    return entries[0].files
  })
  return { schema: 1, kind: 'models', models: [...LOCAL_MODEL_IDS], files }
}

// planId as onboarding_setup.mjs preflight() derives it for a plan that still
// needs installation: the identity of [runtime, models manifest, offered
// components, model source mode, offline folder, memory requirements].
export function derivePlanId({ runtime, modelsManifest, components, modelSource, offlineDirectory = null, memoryRequirements }) {
  return jsonIdentity([runtime, modelsManifest, components, modelSource, offlineDirectory, memoryRequirements])
}

// Binds the consented plan to the shipped catalog runtime and the packaged
// model policy. Components and memory requirements come from the plan itself;
// the other inputs are read from the candidate's archive.
export function assertPlanIdentity(plan, { catalogRuntime, policy }) {
  const modelsManifest = modelsManifestFromPolicy(policy)
  assert.equal(plan.modelSource, 'upstream', 'Plan identity check requires upstream model sources')
  const expected = derivePlanId({ runtime: catalogRuntime, modelsManifest, components: plan.components, modelSource: plan.modelSource,
    offlineDirectory: null, memoryRequirements: plan.memoryRequirements })
  assert.equal(plan.planId, expected, 'Plan identity does not match the packaged catalog runtime and model policy')
  return { verified: true, planId: expected, runtimeId: jsonIdentity(catalogRuntime), modelsManifestId: jsonIdentity(modelsManifest),
    takenFromPlan: ['components', 'memoryRequirements'] }
}

// Binds what the UI was offered (preflight plan) to the shipped catalog and
// the operator's expected lock. The plan itself carries no lock; the runtime
// component's exact bytes and sources tie it to the catalog runtime, and
// assertPlanIdentity binds the planId.
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
  assert.equal(runtime[0].installedBytes, summary.runtimeInstalledBytes, 'Plan runtime installed size differs from the packaged catalog runtime')
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
    runtime: { delivery: summary.delivery, bytes: runtime[0].bytes, installedBytes: runtime[0].installedBytes, sources: runtime[0].sources, terms: runtime[0].terms },
    models: models.map(component => ({ id: component.label, bytes: component.bytes, sources: component.sources,
      terms: (component.terms ?? []).map(({ label, url }) => ({ label, url })) })),
    transferBytes: plan.components.reduce((sum, component) => sum + component.bytes, 0),
    diskRequiredBytes: plan.diskRequiredBytes, diskFreeBytes: plan.diskFreeBytes,
    memoryRequirements: plan.memoryRequirements, memoryQualification: plan.memoryQualification,
    ...(Object.hasOwn(summary.qualification, 'scope') && { catalogQualificationScope: summary.qualification.scope }),
  }
}

// The consent screen must show every component and exact byte count it asks
// consent for. `formatted` is each component's byte count as the renderer
// formats it (toLocaleString in the renderer's own locale). A component
// whose installed size differs from what is retrieved (an archive-delivered
// runtime) must also name that installed size right after the exact
// retrieval size, in the renderer's size format.
export const formatSize = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`
export function assertConsentText(text, plan, formatted) {
  const normalized = normalizeText(text)
  for (const [index, component] of plan.components.entries()) {
    assert.ok(normalized.includes(component.label), `Consent screen omits ${component.label}`)
    assert.ok(normalized.includes(`(${formatted[index]} bytes)`), `Consent screen omits the exact size of ${component.label}`)
    if (Number.isFinite(component.installedBytes) && component.installedBytes !== component.bytes) {
      assert.ok(normalized.includes(`(${formatted[index]} bytes) to retrieve, ${formatSize(component.installedBytes)} installed`),
        `Consent screen omits the installed size of ${component.label}`)
    }
  }
  assert.ok(normalized.includes('Install tools and models'), 'Consent screen has no install control')
}

// Status state machine. Setup status reports one phase per stage
// (preflight, runtime, models, verification, complete, paused) plus
// per-file progress. Runtime transfer, hash verification and the runtime
// self-test all report phase `runtime`; the split below uses the last
// transfer progress change as the end of transfer, which is an observation
// bound. Archive delivery reports part retrieval (`progress.phase`
// `retrieve`, per part) and unpacking (`extract`, cumulative over the
// unpacked tree); only retrieval counts toward the runtime fraction, and
// unpacking is timed separately from its own progress changes.
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
    if (progress?.phase === 'extract' && Number.isSafeInteger(progress.received)) {
      record.unpackFirstMs ??= at - start
      if (record.unpackReceived !== progress.received) { record.unpackReceived = progress.received; record.unpackLastProgressMs = at - start }
    } else if (progress && typeof progress.file === 'string' && Number.isSafeInteger(progress.received) && Number.isSafeInteger(progress.total)) {
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
  // The phase of the last running observation in this attempt.
  function lastRunningPhase() {
    return transitions.filter(item => item.attempt === attempt && item.state === 'running').at(-1)?.phase ?? null
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
      if (record.phase === 'runtime' && record.unpackFirstMs !== undefined) {
        entry.unpackObservedMs = record.unpackLastProgressMs - record.unpackFirstMs
        entry.postUnpackObservedMs = record.lastMs - record.unpackLastProgressMs
      }
      if (record.phase === 'models' && record.lastProgressMs !== null) entry.transferObservedMs = record.lastProgressMs - record.firstMs
      result.push(entry)
    }
    return result
  }
  return { observe, nextAttempt, summary, transitions, fileObservations, runtimeFraction, lastRunningPhase,
    get attempt() { return attempt }, get last() { return last } }
}

// Interrupt only during actual runtime byte transfer (a file, or an archive
// part; never unpacking), after at least 5%.
export function shouldInterrupt(observation, status, { minimumFraction = 0.05 } = {}) {
  return status?.state === 'running' && status.phase === 'runtime' && observation.runtimeFraction >= minimumFraction
    && observation.runtimeFraction < 1 && observation.progress !== null && observation.progress.phase !== 'extract'
    && observation.progress.received < observation.progress.total
}

// The pack server's JSON request log (one object per line). Each record has
// the request's arrival (`started`) and completion (`time`). Lines that are
// not request records (the listening banner) are skipped; malformed JSON fails.
export function parsePackServerLog(text) {
  const entries = []
  for (const [index, line] of String(text).split('\n').entries()) {
    if (!line.trim()) continue
    let value
    try { value = JSON.parse(line) } catch { throw new Error(`Pack server log line ${index + 1} is not JSON`) }
    if (!value || typeof value.method !== 'string' || typeof value.url !== 'string') continue
    assert.ok(typeof value.time === 'string' && Number.isFinite(Date.parse(value.time)), `Pack server log line ${index + 1} has no time`)
    assert.ok(typeof value.started === 'string' && Number.isFinite(Date.parse(value.started)), `Pack server log line ${index + 1} has no request start time`)
    entries.push({ started: value.started, time: value.time, method: value.method, url: value.url, range: value.range ?? null, status: value.status,
      bytes: value.bytes ?? null, outcome: value.outcome ?? null })
  }
  return entries
}

const requestPath = url => url.split('?')[0]

// A retry is classified only from the source server's request log. Polling
// observations are recorded as supplementary context, never as proof.
// `path` is the URL path of the interrupted runtime file; `after` is the
// ISO time of the interruption (cancel click or injected failure).
export function classifyRetry({ bytesPresent, retry, log, path, after }) {
  const polling = retry ? { firstObservedReceived: retry.firstReceived, minimumObservedReceived: retry.minReceived } : null
  const base = { bytesPresent: Number.isSafeInteger(bytesPresent) ? bytesPresent : null, polling }
  if (!log) return { ...base, classification: 'unproven', reason: 'No pack server request log was supplied (--pack-server-log)' }
  assert.equal(typeof path, 'string', 'Retry classification requires the interrupted file path')
  const since = Date.parse(after)
  assert.ok(Number.isFinite(since), 'Retry classification requires the interruption time')
  // Arrival time orders requests: an in-flight transfer aborted by the
  // interruption completes (and is logged) after it.
  const requests = log.filter(entry => entry.method === 'GET' && requestPath(entry.url) === path)
    .sort((left, right) => Date.parse(left.started) - Date.parse(right.started))
  if (!requests.some(entry => Date.parse(entry.started) <= since)) {
    return { ...base, classification: 'unproven', reason: 'The log has no request for the interrupted file before the interruption; it may belong to another server or run' }
  }
  const later = requests.find(entry => Date.parse(entry.started) > since)
  if (!later) return { ...base, classification: 'unproven', reason: 'The log has no request for the interrupted file after the interruption' }
  const request = { started: later.started, time: later.time, range: later.range, status: later.status, bytes: later.bytes }
  const match = /^bytes=(\d+)-$/u.exec(later.range ?? '')
  if (match && Number(match[1]) > 0 && later.status === 206) {
    return { ...base, classification: 'resumed', resumedFromByte: Number(match[1]), request,
      ...(base.bytesPresent !== null && { matchesBytesPresent: Number(match[1]) === base.bytesPresent }) }
  }
  if (later.range === null && later.status === 200) return { ...base, classification: 'restarted', request }
  return { ...base, classification: 'unproven', reason: 'The first retry request is neither a resume (206 with an open range) nor a full restart', request }
}

// An archive runtime arrives as one or a few large parts that the product
// resumes with `Range: bytes=N-`. With the pack server log, a retry that
// refetched the interrupted part from zero (or cannot be shown to resume) is
// a failure; per-file runtimes keep the classification as evidence only.
export function assertArchiveRetryResumed(summary, retry, { logged }) {
  if (summary.delivery !== 'archive' || !logged) return
  assert.notEqual(retry.classification, 'restarted',
    'The retry refetched the interrupted runtime archive part from zero instead of resuming it with a Range request')
  assert.equal(retry.classification, 'resumed', `The retry of the interrupted runtime archive part could not be shown to resume: ${retry.reason}`)
  assert.notEqual(retry.matchesBytesPresent, false,
    `The retry resumed the archive part from byte ${retry.resumedFromByte}, not from the ${retry.bytesPresent} bytes kept after the stop`)
}

// URL path of a catalog runtime transfer unit (a file, or an archive part by
// its progress name), as the pack server logs it.
export function runtimeFileUrlPath(runtime, file) {
  const unit = runtimeTransferUnits(runtime).find(entry => entry.label === file)
  assert.ok(unit, `Runtime file ${file} is not in the packaged catalog`)
  return new URL(unit.url).pathname
}
// The catalog runtime transfer unit a logged URL path names.
export function runtimeFileForUrlPath(runtime, path) {
  const units = runtimeTransferUnits(runtime).filter(entry => new URL(entry.url).pathname === requestPath(path))
  assert.equal(units.length, 1, `Logged path ${path} does not name exactly one catalog runtime file`)
  return units[0].label
}

// Staging location used by the application's runtime store; read-only stat.
// A per-file transfer stages `<id>/<path>.partial`; an archive part stages
// `<id>.archive/part-NNN.partial` beside the tree (runtime_manager.mjs).
export function partialRuntimeBytes(profile, runtimeId, file, runtime = null) {
  assert.match(runtimeId, /^[a-f0-9]{64}$/u)
  let path
  if (runtime && runtime.archive !== undefined) {
    const unit = runtimeTransferUnits(runtime).find(entry => entry.label === file)
    assert.ok(unit, `Runtime archive part ${file} is not in the packaged catalog`)
    path = join(profile, 'processing', 'staging', `${runtimeId}.archive`, `part-${String(unit.part).padStart(3, '0')}.partial`)
  } else {
    assert.ok(typeof file === 'string' && !file.split('/').includes('..') && !file.startsWith('/'), 'Unsafe runtime file path')
    path = join(profile, 'processing', 'staging', runtimeId, ...file.split('/')) + '.partial'
  }
  const info = lstatSync(path, { throwIfNoEntry: false })
  return info?.isFile() && !info.isSymbolicLink() ? info.size : null
}

function regularFile(path, label) {
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`)
  return readFileSync(path)
}

// After the harness relaunch: the active runtime must be exactly the
// promised one, read back from the profile's own installed manifest.
export function installedRuntimeIdentity(profile, runtimeId) {
  assert.match(runtimeId ?? '', /^[a-f0-9]{64}$/u, 'Application reports no active runtime identity')
  const bytes = regularFile(join(profile, 'processing', 'packs', runtimeId, 'manifest.json'), 'Installed runtime manifest')
  const manifest = JSON.parse(bytes)
  return { runtimeId, manifestSha256: sha256(bytes), canonicalId: jsonIdentity(manifest),
    runtimeLockSha256: manifest.provenance?.lockSha256 ?? null, target: { platform: manifest.platform, arch: manifest.arch, accelerator: manifest.accelerator } }
}

// The active model set, read the way the model store selects it: the valid
// pointer with the highest sequence (active.0/1.json), else active.json.
export function installedModelsIdentity(profile) {
  const root = join(profile, 'model-cache'), pointers = []
  for (const slot of [0, 1]) {
    const path = join(root, `active.${slot}.json`)
    if (!lstatSync(path, { throwIfNoEntry: false })) continue
    let value
    try { value = JSON.parse(regularFile(path, 'Model pointer')) } catch { continue }
    const { schema, sequence, id, checksum } = value ?? {}
    if (schema === 2 && Number.isSafeInteger(sequence) && sequence > 0 && /^[a-f0-9]{64}$/u.test(id ?? '')
      && checksum === jsonIdentity({ schema, sequence, id })) pointers.push({ slot, sequence, id })
  }
  pointers.sort((left, right) => right.sequence - left.sequence)
  let pointer = pointers[0]
  if (!pointer) {
    const legacy = JSON.parse(regularFile(join(root, 'active.json'), 'Model pointer'))
    assert.equal(legacy?.schema, 1, 'Invalid active model pointer')
    pointer = { slot: 'legacy', id: legacy.id }
  }
  assert.match(pointer.id ?? '', /^[a-f0-9]{64}$/u, 'Active model pointer has no identity')
  const bytes = regularFile(join(root, 'packs', pointer.id, 'manifest.json'), 'Installed model manifest')
  const manifest = JSON.parse(bytes)
  return { modelsId: pointer.id, pointer: { slot: pointer.slot, sequence: pointer.sequence ?? null }, manifestSha256: sha256(bytes),
    canonicalId: jsonIdentity(manifest), models: manifest.models ?? null }
}

// Judges the post-restart observation sequence. Expected: the dialog reopens,
// the wizard shows its neutral `checking` step while its own preflight
// re-verifies the runtime from the restored checkpoint, then settles on
// `ready` with setup status `ready`. A cancelled or generic error screen or
// status at any point is the product presenting a verified restart as an
// interrupted setup. An honest failed re-verification (the
// verification-failed screen, or an error status in the verification phase)
// is reported as such; it is still a failed run.
export const INTERRUPTED_STEPS = Object.freeze(['error', 'cancelled'])
const verificationError = item => item.statusState === 'error' && item.statusPhase === 'verification'
const honestFailure = item => item.step === 'verification-failed' || (verificationError(item) && !INTERRUPTED_STEPS.includes(item.step))
const where = item => `at ${item.elapsedMs} ms the wizard showed step ${item.step ?? 'unknown'} with status `
  + `${item.statusState ?? 'unknown'}/${item.statusPhase ?? 'unknown'} (${JSON.stringify(item.heading)})`
export function judgePostRestart({ observations, settled, timedOut, timeoutMs }) {
  assert.ok(Array.isArray(observations), 'Post-restart observations are missing')
  assert.ok(observations.some(item => item.dialogVisible), 'The setup dialog did not reopen after restart; expected it to re-verify the installed runtime')
  const interrupted = observations.find(item => !honestFailure(item)
    && (INTERRUPTED_STEPS.includes(item.step) || INTERRUPTED_STEPS.includes(item.statusState)))
  if (interrupted) {
    throw new Error(`A verified restart was presented as an interrupted setup (product defect): ${where(interrupted)}; see wizard.postRestart.observations`)
  }
  const unclassified = observations.find(item => item.step === 'error-unclassified' && !honestFailure(item))
  if (unclassified) {
    throw new Error(`The wizard showed an error screen the harness cannot classify: ${where(unclassified)}; see wizard.postRestart.observations`)
  }
  // Only the setup service's own verification-phase error says the installed
  // files failed; a wizard that gave up while the service was still checking
  // only shows that the check did not complete.
  const failed = observations.find(item => honestFailure(item) && verificationError(item)) ?? observations.find(honestFailure)
  if (failed) {
    throw new Error(verificationError(failed)
      ? `Post-restart verification failed: ${where(failed)}; the setup service reported that the installed runtime or models did not pass live verification `
        + `(${JSON.stringify(failed.statusMessage)}); see wizard.postRestart.observations`
      : `Post-restart verification failed: ${where(failed)}; the post-restart check did not complete (setup status was still `
        + `${failed.statusState ?? 'unreadable'}), so it does not show whether the installed files pass; see wizard.postRestart.observations`)
  }
  if (timedOut || !settled) {
    const last = observations.at(-1)
    throw new Error(`Setup did not settle within ${Math.round(timeoutMs / 1000)} s after restart (last step ${last?.step ?? 'unknown'}, `
      + `status ${last?.statusState ?? 'unknown'}, busy ${last?.busy})`)
  }
  assert.equal(settled.dialogVisible, true, 'The setup dialog closed after restart before settling on ready')
  assert.equal(settled.step, 'ready', `Setup settled on ${settled.step ?? JSON.stringify(settled.heading)} after restart, not ready`)
  assert.ok(observations.some(item => item.step === 'checking' || item.statusState === 'checking'),
    'The post-restart check was not observed: neither the wizard nor setup status showed checking, so the restored setup checkpoint was not exercised')
  assert.equal(settled.statusState, 'ready',
    `The post-restart check was not observed to settle: setup status was ${settled.statusState ?? 'unreadable'}, not ready, when the wizard showed ready`)
  return settled
}

export function assertPostRestart({ settled, readiness, installed, installedModels }, summary, expectedLock, expectedModelsId) {
  assert.equal(settled?.step, 'ready', 'Setup did not settle on ready after restart')
  assert.equal(readiness?.runtime?.id, summary.runtimeId, 'Application activated a different runtime than the plan promised')
  assert.equal(installed.canonicalId, summary.runtimeId, 'Installed runtime manifest does not match its identity')
  assert.equal(installed.runtimeLockSha256, expectedLock, 'Installed runtime lock differs from the expected lock')
  assert.deepEqual(installed.target, summary.target, 'Installed runtime target differs from the plan')
  assert.equal(installedModels.canonicalId, installedModels.modelsId, 'Installed model manifest does not match its identity')
  assert.equal(installedModels.modelsId, expectedModelsId, 'Installed model set differs from the packaged model policy selection')
  assert.equal(readiness.separation?.ready, true, 'Separation is not ready after restart')
  assert.equal(readiness.transcription?.ready, true, 'Transcription is not ready after restart')
}

// Setup has started once status leaves `idle` and differs from what it was
// before the install click (a retry starts from `cancelled` or `error`).
export function setupStarted(before, status) {
  if (!status || status.state === 'idle') return false
  if (status.state === 'running') return true
  return !before || status.state !== before.state || status.message !== before.message || status.phase !== before.phase
}

export const WIZARD_LIMITATIONS = Object.freeze([
  'Wizard mode processes a single track; it is not full release qualification',
  'The UI restart control is exercised up to application exit; the application\'s own relaunch request is intercepted and recorded, and the harness relaunches the same executable and profile',
  'Setup status does not separate runtime transfer, unpacking (archive delivery only), hash verification and runtime self-test into phases; their split is an observation bound from observed progress changes',
  'Model retrieval is from the policy-defined upstream sources the application selects; source availability is not under harness control',
  'The plan identity check takes the offered components and memory requirements from the plan itself; the host hardware observation behind the memory requirements is not independently verified',
])

// ---- Playwright steps (require a live packaged application) ----

export function onboardingDialog(page) { return page.getByTestId('onboarding-dialog') }
// A wizard control by its stable test hook.
export function control(page, id) { return onboardingDialog(page).getByTestId(id) }

async function readStep(dialog) {
  const dataStep = await dialog.getAttribute('data-step', { timeout: 2000 }).catch(() => null)
  const heading = normalizeText(await dialog.getByRole('heading', { level: 1 }).innerText({ timeout: 2000 }).catch(() => '')) || null
  return { heading, step: stepFrom(dataStep, heading) }
}

// Wizard mode drives only candidates that carry the wizard test hooks. A
// setup dialog without them (or without its `data-step`) fails at once
// instead of timing out on a step that can never be recognised.
export const HOOKLESS_CANDIDATE = 'This candidate predates the wizard test hooks; wizard mode cannot drive it'
export async function assertWizardHooks(page, { timeoutMs, interval = 250 } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'assertWizardHooks requires a timeout')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const dialog = onboardingDialog(page)
    if (await dialog.isVisible()) {
      if (await dialog.getAttribute('data-step', { timeout: 2000 }).catch(() => null)) return
      throw new Error(`${HOOKLESS_CANDIDATE} (the setup dialog has no data-step)`)
    }
    if (await page.getByRole('dialog').first().isVisible().catch(() => false)) throw new Error(`${HOOKLESS_CANDIDATE} (a dialog without data-testid="onboarding-dialog" is showing)`)
    if (Date.now() >= deadline) break
    await pause(interval)
  }
  throw new Error(`No setup dialog appeared within ${Math.round(timeoutMs / 1000)} s of launch`)
}

export async function currentStep(page) {
  const dialog = onboardingDialog(page)
  if (!await dialog.isVisible()) return null
  return (await readStep(dialog)).step
}

// One read of what a user sees: dialog visibility, its busy flag, the step
// heading and the step (null when neither hook nor heading names one).
export async function uiSnapshot(page) {
  const dialog = onboardingDialog(page)
  if (!await dialog.isVisible()) return { dialogVisible: false, busy: null, heading: null, step: null }
  const busy = await dialog.getAttribute('aria-busy', { timeout: 2000 }).catch(() => null)
  return { dialogVisible: true, busy: busy === 'true' ? true : busy === 'false' ? false : null, ...await readStep(dialog) }
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

// Controls are judged only while the wizard is idle: while one of its actions
// runs (including the preflight behind the choice and consent screens) the
// dialog is aria-busy and that screen's controls are disabled. The
// post-restart check is not such an action: it shows the `checking` step with
// the dialog not busy and its library control enabled, so it is observed by
// step, not by this wait.
export async function waitForIdle(page, { timeoutMs, interval = 100 } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'waitForIdle requires a timeout')
  const dialog = onboardingDialog(page), deadline = Date.now() + timeoutMs
  let busy
  for (;;) {
    busy = await dialog.getAttribute('aria-busy', { timeout: 2000 }).catch(() => null)
    if (busy === 'false') return
    if (Date.now() >= deadline) break
    await pause(interval)
  }
  throw new Error(`Setup wizard stayed busy for ${Math.round(timeoutMs / 1000)} s (aria-busy=${busy ?? 'unavailable'})`)
}


export async function chooseLocalAndContinue(page, { timeoutMs }) {
  await waitForStep(page, 'choose', { timeoutMs })
  await waitForIdle(page, { timeoutMs })
  const local = control(page, 'onboarding-choice-local')
  if (await local.isDisabled()) {
    throw new Error(`Local processing is unavailable in the wizard: ${normalizeText(await onboardingDialog(page).locator('#local-reason').innerText())}`)
  }
  if (await local.getAttribute('aria-pressed') !== 'true') await local.click()
  assert.equal(await local.getAttribute('aria-pressed'), 'true', 'Local processing choice was not selected')
  await control(page, 'onboarding-continue').click()
  await waitForStep(page, 'consent', { timeoutMs })
  await waitForIdle(page, { timeoutMs })
}

export async function readPlan(page) { return page.evaluate(() => window.karaokeDesktop.preflightSetup()) }
export async function readStatus(page) { return page.evaluate(() => window.karaokeDesktop.getSetupStatus()) }

export async function consentSnapshot(page, plan) {
  const text = await onboardingDialog(page).innerText()
  const formatted = await page.evaluate(values => values.map(value => Number(value).toLocaleString()), plan.components.map(component => component.bytes))
  assertConsentText(text, plan, formatted)
  return { text: normalizeText(text), sha256: sha256(Buffer.from(normalizeText(text))) }
}

export async function acceptConsent(page, { timeoutMs }) {
  await waitForIdle(page, { timeoutMs })
  const install = control(page, 'onboarding-install')
  assert.equal(await install.isEnabled(), true, 'Install control is disabled')
  await install.click()
}

// After the install click, wait (bounded) for setup to leave its prior state.
export async function waitForSetupStart(read, { before, timeoutMs, interval = 250 }) {
  const deadline = Date.now() + timeoutMs
  let status
  for (;;) {
    status = await read()
    if (setupStarted(before, status)) return status
    if (Date.now() >= deadline) break
    await pause(interval)
  }
  throw new Error(`Setup did not start within ${Math.round(timeoutMs / 1000)} s of the install click (status ${status?.state ?? 'missing'})`)
}

export async function cancelFromUi(page) {
  const details = control(page, 'onboarding-setup-controls')
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
  await control(page, 'onboarding-cancel').click()
}

export async function retryFromUi(page, { timeoutMs }) {
  await waitForIdle(page, { timeoutMs })
  await control(page, 'onboarding-retry').click()
  await chooseLocalAndContinue(page, { timeoutMs })
}

export async function clickRestart(page) {
  // The application quits during this action; Playwright may lose the page.
  await control(page, 'onboarding-restart').click({ noWaitAfter: true, timeout: 10000 })
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

// After relaunch: record every distinct (dialog visibility, step, status,
// heading) with timestamps until the wizard is idle on one screen other than
// `checking` for `settleMs`, or `timeoutMs` passes. `checking` is the
// wizard's own re-verification still running: not settled, not a failure. Only getSetupStatus is read; the
// wizard's own preflight is the only verification that runs.
export async function observePostRestart(page, { timeoutMs, interval = 250, settleMs = 1500, read = readStatus, snapshot = uiSnapshot,
  now = Date.now } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'observePostRestart requires a timeout')
  const start = now(), observations = []
  let lastKey = null, stableSince = start
  while (now() - start < timeoutMs) {
    const ui = await snapshot(page)
    let status
    try { status = await read(page) } catch (error) { status = { state: null, readError: error.message } }
    const at = now()
    const key = JSON.stringify([ui.dialogVisible, ui.step, ui.heading, status?.state ?? null, ui.busy])
    if (key !== lastKey) {
      stableSince = at; lastKey = key
      const signature = JSON.stringify([ui.dialogVisible, ui.step, ui.heading, status?.state ?? null])
      if (signature !== observations.at(-1)?.signature) {
        observations.push({ signature, elapsedMs: at - start, at: new Date(at).toISOString(), dialogVisible: ui.dialogVisible,
          busy: ui.busy, step: ui.step, heading: ui.heading, statusState: status?.state ?? null, statusPhase: status?.phase ?? null,
          statusMessage: status?.message ?? null,
          ...(status?.readError && { statusReadError: status.readError }) })
      }
    }
    const seenDialog = observations.some(item => item.dialogVisible)
    if (seenDialog && ui.busy === false && ui.step !== 'checking' && at - stableSince >= settleMs) {
      return { observations: observations.map(({ signature, ...item }) => item), timedOut: false, elapsedMs: at - start,
        settled: { dialogVisible: ui.dialogVisible, step: ui.step, heading: ui.heading, statusState: status?.state ?? null } }
    }
    if (seenDialog && !ui.dialogVisible && at - stableSince >= settleMs) {
      return { observations: observations.map(({ signature, ...item }) => item), timedOut: false, elapsedMs: at - start,
        settled: { dialogVisible: false, step: null, heading: null, statusState: status?.state ?? null } }
    }
    await pause(interval)
  }
  return { observations: observations.map(({ signature, ...item }) => item), timedOut: true, elapsedMs: now() - start, settled: null }
}
