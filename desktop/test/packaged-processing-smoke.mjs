// SPDX-License-Identifier: AGPL-3.0-only
// Explicit, real local inference. Run only with licensed evaluation audio.
import assert from 'node:assert/strict'
import { X509Certificate, createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isInside, packagedLayout, samePath } from './packaged-smoke-paths.mjs'
import { closePackagedApplication, processTable, shutdownEvidence } from './packaged-smoke-shutdown.mjs'
import { WIZARD_LIMITATIONS, acceptConsent, assertArchiveRetryResumed, assertCatalogLock, assertWizardHooks, assertPlanIdentity, assertPostRestart, assertWizardPlan, cancelFromUi,
  catalogLimitations, chooseLocalAndContinue, classifyRetry, clickRestart, consentSnapshot, control, createStatusTracker, installedModelsIdentity,
  installedRuntimeIdentity, interceptRelaunch, judgePostRestart, observePostRestart, parsePackServerLog, partialRuntimeBytes,
  readPlan, readStatus, resolveRetryTarget, retryFromUi, shouldInterrupt, stagedArchivePartBytes, summarizeCatalog, waitForIdle,
  waitForSetupStart, waitForStep } from './packaged-wizard-driver.mjs'

const BOOLEAN_FLAGS = { '--resume': 'resume', '--download-models': 'downloadModels', '--wizard': 'wizard', '--interrupt-runtime-retrieval': 'interruptRuntimeRetrieval',
  '--expect-retrieval-failure-then-retry': 'expectRetrievalFailure' }
// Setup must leave `idle` this soon after the install click.
export const SETUP_START_TIMEOUT_MS = 60000
// The wizard's own post-restart preflight re-hashes the runtime and runs its
// self-test (up to about 120 s); this bound adds margin.
export const POST_RESTART_SETTLE_TIMEOUT_MS = 240000

export function parseArguments(args) {
  const options = {}, valued = new Set(['--executable', '--runtime-manifest', '--audio', '--output', '--timeout-seconds', '--upgrade-from-executable-sha256',
    '--retained-profile', '--expected-source-commit', '--expected-runtime-lock-sha256', '--extra-ca-cert', '--pack-server-log'])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      assert.ok(!options[BOOLEAN_FLAGS[flag]], `Duplicate ${flag}`); options[BOOLEAN_FLAGS[flag]] = true; continue
    }
    if (flag === '--model-folder') throw new Error('Offline model-folder import is unavailable in this qualification harness. Use --wizard with --expected-runtime-lock-sha256; do not transplant cache pointers.')
    if (!valued.has(flag) || options[flag] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}`)
    options[flag] = args[++i]
  }
  for (const key of ['--executable', '--audio', '--output']) assert.ok(options[key], `Missing ${key}`)
  const seconds = Number(options['--timeout-seconds'] ?? 3600)
  assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 14400, 'Timeout must be 60–14400 seconds')
  const common = { executable: resolve(options['--executable']), audio: resolve(options['--audio']), output: resolve(options['--output']),
    timeoutMs: seconds * 1000, extraCaCert: options['--extra-ca-cert'] ? resolve(options['--extra-ca-cert']) : undefined }
  if (options.wizard) {
    // The wizard's own consent screen covers runtime and model retrieval;
    // it installs into a new profile only, with no operator manifest.
    for (const [present, flag] of [[options['--runtime-manifest'], '--runtime-manifest'], [options.downloadModels, '--download-models'],
      [options['--retained-profile'], '--retained-profile'], [options.resume, '--resume'], [options['--upgrade-from-executable-sha256'], '--upgrade-from-executable-sha256'],
      [options['--expected-source-commit'], '--expected-source-commit']]) {
      assert.ok(!present, `Wizard mode excludes ${flag}`)
    }
    const lock = options['--expected-runtime-lock-sha256']
    assert.match(lock ?? '', /^[a-fA-F0-9]{64}$/u, 'Wizard mode requires --expected-runtime-lock-sha256 with 64 hex characters')
    assert.ok(!(options.interruptRuntimeRetrieval && options.expectRetrievalFailure),
      'Choose one of --interrupt-runtime-retrieval and --expect-retrieval-failure-then-retry')
    assert.ok(!options['--pack-server-log'] || options.interruptRuntimeRetrieval || options.expectRetrievalFailure,
      '--pack-server-log requires --interrupt-runtime-retrieval or --expect-retrieval-failure-then-retry')
    return { ...common, mode: 'wizard', expectedRuntimeLockSha256: lock.toLowerCase(), interruptRuntimeRetrieval: options.interruptRuntimeRetrieval === true,
      expectRetrievalFailure: options.expectRetrievalFailure === true,
      packServerLog: options['--pack-server-log'] ? resolve(options['--pack-server-log']) : undefined, resume: false }
  }
  for (const [present, flag] of [[options.interruptRuntimeRetrieval, '--interrupt-runtime-retrieval'],
    [options.expectRetrievalFailure, '--expect-retrieval-failure-then-retry'], [options['--pack-server-log'], '--pack-server-log'],
    [options['--expected-runtime-lock-sha256'], '--expected-runtime-lock-sha256']]) {
    assert.ok(!present, `${flag} requires --wizard`)
  }
  assert.ok(options['--runtime-manifest'], 'Missing --runtime-manifest')
  const retainedProfile = options['--retained-profile'], expectedSourceCommit = options['--expected-source-commit']
  if (retainedProfile) {
    assert.ok(!options.resume && !options.downloadModels && !options['--upgrade-from-executable-sha256'], 'Retained setup excludes resume, upgrades and model retrieval')
    assert.match(expectedSourceCommit ?? '', /^[a-fA-F0-9]{40}$/, 'Retained setup requires a full expected source commit')
  } else {
    assert.ok(!expectedSourceCommit, 'Expected source commit requires retained setup')
    assert.ok(options.downloadModels, 'Explicit --download-models consent is required to retrieve the three model sets from policy-defined upstreams')
  }
  const upgradeFrom = options['--upgrade-from-executable-sha256']
  if (upgradeFrom !== undefined) {
    assert.ok(options.resume, 'Executable upgrade requires --resume')
    assert.match(upgradeFrom, /^[a-fA-F0-9]{64}$/, 'Upgrade prior executable SHA-256 must be 64 hex characters')
  }
  assert.ok(retainedProfile, 'Legacy manifest-install qualification is retired. Use --wizard with --expected-runtime-lock-sha256 on a fresh evidence directory.')
  return { ...common, mode: 'retained', manifest: resolve(options['--runtime-manifest']),
    retainedProfile: retainedProfile ? resolve(retainedProfile) : undefined, expectedSourceCommit: expectedSourceCommit?.toLowerCase(),
    resume: options.resume === true, upgradeFromExecutableSha256: upgradeFrom?.toLowerCase() }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const MODEL_IDS = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']
const PLATFORMS = ['win32', 'darwin', 'linux']
export const EVIDENCE_SCHEMA = 2

// Every local file this harness loads, relative to the desktop directory.
// A unit test checks this list is closed over the harness's relative imports.
export const HARNESS_FILES = Object.freeze(['test/packaged-processing-smoke.mjs', 'test/packaged-smoke-paths.mjs',
  'test/packaged-smoke-shutdown.mjs', 'test/packaged-wizard-driver.mjs', 'test/packaged-smoke-processes.py', 'lifecycle.mjs',
  // The driver takes the runtime store's directory naming from the store itself.
  'runtime_manager.mjs', 'processing_probe.py'])
export function playwrightVersion() {
  try { return createRequire(import.meta.url)('playwright/package.json').version } catch { return null }
}
export function harnessIdentity(root = fileURLToPath(new URL('../', import.meta.url))) {
  return { files: Object.fromEntries(HARNESS_FILES.map(file => [file, hash(readFileSync(join(root, ...file.split('/'))))])),
    playwright: { version: playwrightVersion() } }
}

// Refuses a path with a symbolic link (or junction) in any component.
export function assertNoLinkedComponents(path, label) {
  assert.ok(isAbsolute(path), `${label} path must be absolute`)
  for (let current = path; ; current = dirname(current)) {
    assert.ok(!lstatSync(current).isSymbolicLink(), `${label} path has a linked component: ${current}`)
    if (dirname(current) === current) break
  }
}

// An operator-supplied PEM bundle of extra trust anchors for a private test
// source. It adds roots for the application's Node TLS; verification stays on.
// Every certificate must be a CA certificate (basic constraints CA:TRUE).
export function extraCaCertificate(path) {
  assertNoLinkedComponents(path, 'Extra CA certificate')
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Extra CA certificate must be a regular file')
  assert.ok(info.size > 0 && info.size <= 1024 * 1024, 'Extra CA certificate must be a small PEM file')
  const bytes = readFileSync(path), text = bytes.toString('utf8')
  assert.ok(!/PRIVATE KEY/u.test(text), 'Extra CA file must not contain a private key')
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/gu) ?? []
  assert.ok(blocks.length > 0, 'Extra CA file must contain PEM certificates')
  const residue = text.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/gu, '').trim()
  assert.equal(residue, '', 'Extra CA file may contain only PEM certificates')
  const certificates = blocks.map(block => {
    let certificate
    try { certificate = new X509Certificate(block) } catch { throw new Error('Extra CA file contains a certificate that does not parse') }
    assert.equal(certificate.ca, true, 'Extra CA file may contain only CA certificates (basic constraints CA:TRUE)')
    return { subject: certificate.subject.split('\n').join(', '), fingerprint256: certificate.fingerprint256, validTo: certificate.validTo }
  })
  return { path, bytes, sha256: hash(bytes), certificates }
}

// The application trusts a copy kept with the evidence, never the operator's
// original, so the hashed bytes are the bytes it used.
export function copyExtraCaCertificate(trust, directory) {
  const copy = join(directory, 'extra-ca.pem')
  writeFileSync(copy, trust.bytes, { flag: 'wx', mode: 0o444 })
  const written = readFileSync(copy)
  assert.equal(hash(written), trust.sha256, 'Extra CA copy differs from the validated certificate')
  return { source: trust.path, copy, sha256: hash(written), certificates: trust.certificates }
}

export function readPackServerLog(path) {
  assertNoLinkedComponents(path, 'Pack server log')
  const info = lstatSync(path)
  assert.ok(info.isFile(), 'Pack server log must be a regular file')
  const bytes = readFileSync(path)
  return { path, sha256: hash(bytes), entries: parsePackServerLog(bytes.toString('utf8')) }
}

// Allowlisted launch environment. Windows keeps its established set unchanged.
// POSIX hosts need HOME and, on Linux, the display/session variables; a
// Wayland socket travels with its session type so Electron selects the same
// display backend as the desktop session. Service, loader, Node/Electron and
// backend overrides never pass through; NODE_EXTRA_CA_CERTS is set only from
// an explicit --extra-ca-cert, never inherited. --user-data-dir remains the
// only profile selector and is asserted after launch.
export function applicationEnvironment(source, platform, output, { extraCaCertificate: caPath } = {}) {
  assert.ok(PLATFORMS.includes(platform), 'Unsupported processing smoke platform')
  const allowed = {
    win32: /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|windir|COMSPEC|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|LANG|LC_[A-Z_]+)$/u,
    darwin: /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+)$/u,
    linux: /^(PATH|HOME|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_SESSION_TYPE|XAUTHORITY|XDG_RUNTIME_DIR|LANG|LC_[A-Z_]+)$/u,
  }[platform]
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.test(key) && typeof value === 'string'))
  if (platform === 'linux' && (env.WAYLAND_DISPLAY === undefined) !== (env.XDG_SESSION_TYPE === undefined)) {
    // Never pass half of a Wayland session description.
    delete env.WAYLAND_DISPLAY; delete env.XDG_SESSION_TYPE
  }
  env.XDG_CONFIG_HOME = output
  if (caPath !== undefined) {
    assert.ok(isAbsolute(caPath), 'Extra CA certificate path must be absolute')
    env.NODE_EXTRA_CA_CERTS = caPath
  }
  return env
}

// Windows retains its established owned-child close. On POSIX the packaged
// backend runs in its own detached session, and the Heart transcription
// worker starts yet another session below it; neither is in Electron's
// process group, so a clean Electron exit alone is not shutdown. Observe the
// owned process tree (by parent lineage, not group) to completion.
export const shutdownStrategy = platform => {
  assert.ok(PLATFORMS.includes(platform), 'Unsupported processing smoke platform')
  return platform === 'win32' ? 'owned-child' : 'owned-process-tree'
}

// Candidate identity recorded in every mode. The executable alone does not
// identify a build: on Linux it is the stock Electron binary.
export const CANDIDATE_KEYS = Object.freeze(['executableSha256', 'applicationArchiveSha256', 'nativeManifestSha256',
  'nativeProvenanceSha256', 'releaseReceiptSha256'])
export function candidateIdentity(executable, platform = process.platform) {
  const { resources, native } = packagedLayout(executable, platform)
  const file = path => hash(readFileSync(path))
  const receipt = join(resources, 'release-receipt.json')
  return { executableSha256: file(executable), applicationArchiveSha256: file(join(resources, 'app.asar')),
    nativeManifestSha256: file(join(native, 'manifest.json')), nativeProvenanceSha256: file(join(native, 'provenance.json')),
    // A signed macOS bundle keeps its receipt outside the sealed bundle.
    releaseReceiptSha256: existsSync(receipt) ? file(receipt) : null }
}

export function executableIdentityLimitation(platform) {
  return {
    linux: 'executableSha256 is the stock Electron binary on Linux and is identical across builds; the candidate is identified by the application archive, native manifest/provenance and receipt hashes, not by every native payload file',
    darwin: 'executableSha256 is the Contents/MacOS launcher (the Electron binary, as signed); it does not identify the application archive, native payload or the rest of the bundle, which the candidate tuple records in part (archive, native manifest/provenance, receipt when present)',
    win32: 'executableSha256 is the Windows launcher (the Electron binary with embedded resources and any signature); it does not by itself identify the application archive or native payload, which the candidate tuple records in part',
  }[platform] ?? assert.fail('Unsupported processing smoke platform')
}

// Prior evidence identity. Evidence without the tuple predates it: only a
// Windows executable hash is accepted as a legacy identity there; on Linux
// and macOS that hash does not distinguish builds, so resume is refused.
export function recordedCandidate(prior, platform) {
  if (Object.hasOwn(prior, 'candidate')) {
    assert.equal(prior.schema, EVIDENCE_SCHEMA, 'Prior evidence schema does not match its candidate identity')
    assert.ok(prior.candidate && CANDIDATE_KEYS.every(key => Object.hasOwn(prior.candidate, key))
      && CANDIDATE_KEYS.filter(key => key !== 'releaseReceiptSha256').every(key => /^[a-f0-9]{64}$/u.test(prior.candidate[key] ?? '')),
    'Prior evidence has a malformed candidate identity')
    assert.equal(prior.candidate.executableSha256, prior.executableSha256, 'Prior evidence candidate identity is inconsistent')
    return { identity: prior.candidate, legacy: false }
  }
  assert.equal(prior.schema, 1, 'Prior evidence lacks a candidate identity')
  assert.equal(platform, 'win32', `Prior evidence lacks the candidate identity tuple; on ${platform} its executable hash does not identify the candidate. Start a new evidence directory.`)
  assert.match(prior.executableSha256 ?? '', /^[a-f0-9]{64}$/u, 'Prior evidence has no executable identity')
  return { identity: { executableSha256: prior.executableSha256 }, legacy: true }
}
export function sameCandidate(recorded, current) {
  return recorded.legacy ? recorded.identity.executableSha256 === current.executableSha256
    : CANDIDATE_KEYS.every(key => recorded.identity[key] === current[key])
}

// A resume relaunches in the original profile on the same OS and architecture
// that recorded it; other hosts are a new qualification, never a continuation.
export function validateResumedApplication(prior, identity, platform = process.platform) {
  assert.equal(identity.platform, prior.platform, 'Resume evidence was recorded on a different platform')
  assert.equal(identity.arch, prior.arch, 'Resume evidence was recorded on a different architecture')
  assert.ok(typeof identity.userData === 'string' && samePath(prior.userData, identity.userData, platform),
    'Relaunched application selected a different profile than the recorded attempt')
}

// The application reports its own architecture; the harness's Node must match
// it so process observation, bundled tools and evidence describe one target.
export function validateHarnessArchitecture(harness, identity) {
  assert.equal(identity.platform, harness.platform, 'Packaged application platform differs from the harness host')
  assert.equal(identity.arch, harness.arch,
    `Packaged application architecture (${identity.arch}) differs from the harness Node (${harness.arch}); run the harness with a Node build native to the application architecture`)
}

// Output directories are created only beneath a physical, existing parent.
export function assertPhysicalOutputParent(output, platform = process.platform) {
  const parent = dirname(output)
  const info = lstatSync(parent)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Evidence parent must be a physical directory')
  assert.ok(samePath(realpathSync(parent), parent, platform), 'Evidence parent must be a physical path')
  assert.ok(!existsSync(output), 'Evidence directory must not already exist; use --resume only for an interrupted installation')
}

const UPGRADE_QUALIFICATION = 'Application upgrade with retained setup; not clean-install proof'
const LEGACY_UPGRADE_KEYS = ['fromExecutableSha256', 'toExecutableSha256', 'qualification']

// Resumption only continues installation in the original empty qualification
// profile. A submitted inference is never silently adopted or declared passed.
// `expected.candidate` is the current candidate tuple. The upgrade flag
// selects the original candidate by its executable hash; lineage then binds
// the original and current tuples, so a Linux upgrade may keep the same
// stock executable while its archive or native payload changes.
export function validateResume(output, expected, upgradeFromExecutableSha256, platform = process.platform, arch = process.arch) {
  assert.ok(PLATFORMS.includes(platform), 'Unsupported processing smoke platform')
  const current = expected.candidate
  assert.ok(current && CANDIDATE_KEYS.every(key => Object.hasOwn(current, key)), 'Current candidate identity is required')
  if (upgradeFromExecutableSha256 !== undefined) {
    assert.match(upgradeFromExecutableSha256, /^[a-f0-9]{64}$/, 'Invalid upgrade prior executable SHA-256')
  }
  const physicalDirectory = path => {
    assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Resume directory must not be a link')
    assert.ok(samePath(realpathSync(path), path, platform), 'Resume path must be physical')
  }
  physicalDirectory(output)
  const profile = join(output, 'profile')
  physicalDirectory(profile)
  function readAttempt(directory) {
    assert.ok(!existsSync(join(directory, 'inference-started.json')), 'Resume refuses an attempted or ambiguous inference submission')
    const evidencePath = join(directory, 'evidence.json')
    assert.ok(lstatSync(evidencePath).isFile() && !lstatSync(evidencePath).isSymbolicLink(), 'Prior evidence must be a regular file')
    const bytes = readFileSync(evidencePath), prior = JSON.parse(bytes)
    assert.ok([1, EVIDENCE_SCHEMA].includes(prior.schema), 'Unsupported prior evidence schema'); assert.equal(prior.kind, 'packaged-local-processing-smoke')
    assert.ok(prior.mode === undefined || prior.mode === 'advanced', 'Only advanced-route installation evidence can resume')
    assert.ok(['running', 'failed'].includes(prior.status), 'Only incomplete qualification evidence can resume')
    assert.ok(!['inferenceStartedAt', 'songId', 'jobId', 'outputs', 'transcription'].some(key => Object.hasOwn(prior, key)),
      'Resume supports installation interruptions only; use a new output for inference retries')
    const candidate = recordedCandidate(prior, platform)
    assert.equal(prior.runtimeManifestSha256, expected.runtimeManifestSha256, 'Resume runtime manifest changed')
    assert.equal(prior.input?.sha256, expected.input.sha256, 'Resume audio changed')
    assert.equal(prior.input?.bytes, expected.input.bytes, 'Resume audio size changed')
    assert.equal(prior.application?.packaged, true)
    assert.equal(prior.application?.platform, platform, 'Resume evidence was recorded on a different platform')
    assert.equal(prior.application?.arch, arch, 'Resume evidence was recorded for a different architecture')
    assert.ok(samePath(prior.application.userData, profile, platform), 'Prior profile identity does not match isolated profile')
    return { prior, candidate, sha256: hash(bytes) }
  }
  const original = readAttempt(output), attempts = []
  assert.ok(!Object.hasOwn(original.prior, 'upgrade'), 'Original evidence cannot be an upgrade attempt')
  let upgrade
  if (upgradeFromExecutableSha256 === undefined) {
    assert.ok(sameCandidate(original.candidate, current), 'Resume candidate changed outside the explicit upgrade lineage')
  } else {
    assert.equal(original.prior.executableSha256, upgradeFromExecutableSha256, 'Upgrade prior executable SHA-256 does not match original evidence')
    assert.ok(!sameCandidate(original.candidate, current), 'Candidate upgrade must change the candidate identity')
    upgrade = { fromExecutableSha256: upgradeFromExecutableSha256, toExecutableSha256: current.executableSha256,
      fromCandidate: original.candidate.identity, toCandidate: current, qualification: UPGRADE_QUALIFICATION }
  }

  // Every previous resume is relevant, even if the original evidence still
  // says installation was interrupted and the library was later emptied.
  // Tuples recorded on the original (non-upgrade) lineage: once any attempt
  // carries one, every other attempt and a non-upgrade resume must match it.
  const lineageTuples = original.candidate.legacy ? [] : [original.candidate.identity]
  for (const name of readdirSync(output).filter(name => name.startsWith('resume-')).sort()) {
    const directory = join(output, name)
    physicalDirectory(directory)
    const attempt = readAttempt(directory)
    assert.equal(attempt.prior.resume?.priorEvidence, '../evidence.json', 'Resume attempt has invalid lineage')
    assert.equal(attempt.prior.resume?.priorEvidenceSha256, original.sha256, 'Resume attempt has changed lineage')
    if (upgrade && sameCandidate(attempt.candidate, current)) {
      const recorded = attempt.prior.upgrade
      if (attempt.candidate.legacy) {
        assert.ok(recorded && LEGACY_UPGRADE_KEYS.every(key => recorded[key] === upgrade[key]), 'Resume attempt lacks explicit matching upgrade lineage')
      } else assert.deepEqual(recorded, upgrade, 'Resume attempt lacks explicit matching upgrade lineage')
    } else if (original.candidate.legacy ? attempt.prior.executableSha256 === original.prior.executableSha256
      : sameCandidate(attempt.candidate, original.candidate.identity)) {
      assert.ok(!Object.hasOwn(attempt.prior, 'upgrade'), 'Resume attempt has unexpected upgrade lineage')
      if (!attempt.candidate.legacy) lineageTuples.push(attempt.candidate.identity)
    } else {
      assert.fail('Resume candidate changed outside the explicit upgrade lineage')
    }
    attempts.push({ evidence: `../${name}/evidence.json`, sha256: attempt.sha256, status: attempt.prior.status })
  }
  const bound = lineageTuples[0], equalTuple = (left, right) => CANDIDATE_KEYS.every(key => left[key] === right[key])
  assert.ok(lineageTuples.every(tuple => equalTuple(tuple, bound)), 'Resume attempts on the original candidate recorded different candidate tuples')
  if (upgrade === undefined && bound) {
    assert.ok(equalTuple(bound, current), 'Resume candidate differs from the candidate tuple recorded earlier in this evidence chain')
  }
  return { ...original, attempts, upgrade, ...(bound && original.candidate.legacy && { boundCandidate: bound }) }
}

export function reusableRuntime(readiness, manifest) {
  // The backend exposes runtime only after its normal verified admission.
  return readiness?.runtime?.id === hash(Buffer.from(JSON.stringify(manifest)))
    && readiness.runtime.accelerator === manifest.accelerator
}

export function validateRetainedCandidate(executable, expectedSourceCommit, platform = process.platform) {
  assert.match(expectedSourceCommit ?? '', /^[a-f0-9]{40}$/, 'Expected full source identity required')
  // A signed macOS bundle keeps its receipt outside the sealed bundle; it fails closed here.
  const { resources } = packagedLayout(executable, platform), records = {}
  for (const [name, path] of Object.entries({ provenance: join(resources, 'native', 'provenance.json'),
    nativeManifest: join(resources, 'native', 'manifest.json'), receipt: join(resources, 'release-receipt.json') })) {
    const bytes = readFileSync(path)
    records[name] = { value: JSON.parse(bytes), sha256: hash(bytes) }
  }
  assert.equal(records.provenance.value.sourceCommit, expectedSourceCommit, 'Native source identity changed')
  assert.equal(records.provenance.value.sourceDirty, false, 'Native source must be clean')
  assert.equal(records.provenance.value.sourceExport, false, 'Native source must have committed provenance')
  assert.equal(records.receipt.value.identity.sourceCommit, expectedSourceCommit, 'Release source identity changed')
  assert.equal(records.receipt.value.identity.nativeRuntimeId, records.nativeManifest.value.runtimeId, 'Native release identity changed')
  return { sourceCommit: expectedSourceCommit, provenanceSha256: records.provenance.sha256,
    nativeManifestSha256: records.nativeManifest.sha256, receiptSha256: records.receipt.sha256,
    identity: records.receipt.value.identity, applicationArchiveSha256: hash(readFileSync(join(resources, 'app.asar'))) }
}

export function validateRetainedProfile(profile, output, platform = process.platform) {
  const info = lstatSync(profile)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Retained profile must be a physical directory')
  assert.ok(samePath(realpathSync(profile), profile, platform), 'Retained profile must be physical')
  assert.ok(samePath(realpathSync(dirname(output)), dirname(output), platform), 'Evidence parent must be physical')
  assert.ok(!samePath(profile, output, platform) && !isInside(profile, output, platform) && !isInside(output, profile, platform),
    'Retained profile and evidence must be separate directories')
}

export function validateFreshSubmission(submitted, priorSongs, priorJobs) {
  assert.ok(Number.isInteger(submitted.song_id) && submitted.song_id > 0, 'New song identity required')
  assert.ok(typeof submitted.job_id === 'string' && submitted.job_id.length > 0, 'New job identity required')
  assert.ok(!priorSongs.includes(submitted.song_id), 'Submission reused an existing song')
  assert.ok(!priorJobs.includes(submitted.job_id), 'Submission reused an existing job')
}

// Immutable mode prevents SQLite from creating or modifying DB/WAL/SHM files.
// Refuse a nonempty WAL rather than silently omitting uncheckpointed records.
export function retainedDatabaseSnapshot(python, database, requireQuiescent = false) {
  const script = `import hashlib,json,pathlib,sqlite3,sys
path=pathlib.Path(sys.argv[1]).resolve(strict=True)
wal=pathlib.Path(str(path)+'-wal')
def no_wal():
 if wal.exists() and wal.stat().st_size: raise RuntimeError('Retained database has a nonempty WAL; stop without checkpointing')
no_wal()
before=path.read_bytes()
connection=sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)
connection.row_factory=sqlite3.Row
result={}
try:
 for table,terminal in [('songs',('ready','failed')),('jobs',('done','failed'))]:
  rows=[dict(row) for row in connection.execute('SELECT * FROM '+table+' ORDER BY id')]
  if sys.argv[2]=='true' and any(row.get('status') not in terminal for row in rows):
   raise RuntimeError('Retained database has nonterminal '+table+'; application must not launch')
  result[table]=[{'id':row['id'],'sha256':hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()} for row in rows]
finally: connection.close()
no_wal()
if path.read_bytes()!=before: raise RuntimeError('Retained database changed during read-only snapshot')
print(json.dumps(result))`
  return JSON.parse(execFileSync(python, ['-I', '-B', '-c', script, database, String(requireQuiescent)],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }))
}

export function auditRetainedDatabase(baseline, current) {
  for (const table of ['songs', 'jobs']) {
    for (const prior of baseline[table]) {
      const observed = current[table].find(row => row.id === prior.id)
      assert.deepEqual(observed, prior, `Retained ${table} row changed or disappeared`)
    }
  }
  return { status: 'passed', songs: baseline.songs.length, jobs: baseline.jobs.length }
}

export async function run(options) {
  assert.ok(!options.upgradeFromExecutableSha256 || options.resume, 'Executable upgrade requires --resume')
  assert.ok(PLATFORMS.includes(process.platform), 'This qualification harness supports Windows, macOS and Linux packaged applications')
  assert.ok(statSync(options.executable).isFile(), 'Packaged executable is required')
  const layout = packagedLayout(options.executable)
  assert.ok(statSync(layout.resources).isDirectory(), 'Packaged resources are required; pass the unpacked or installed application executable')
  const { ffmpeg, ffprobe, python: nativePython } = layout
  const inputProbe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', options.audio], { timeout: 30000, encoding: 'utf8' }))
  const inputDuration = Number(inputProbe.format?.duration)
  assert.ok(Number.isFinite(inputDuration) && inputDuration > 0 && inputDuration <= 120, 'Supply a vocal excerpt no longer than 120 seconds')
  assert.ok(statSync(options.audio).size > 0 && statSync(options.audio).size <= 64 * 1024 * 1024, 'Supply a short licensed audio excerpt of at most 64 MiB')
  const input = readFileSync(options.audio)
  const wizardMode = options.mode === 'wizard'
  // Wizard mode takes its runtime from the application's own catalog later.
  const manifestBytes = wizardMode ? null : readFileSync(options.manifest)
  let manifest = wizardMode ? null : JSON.parse(manifestBytes)
  if (!wizardMode) assert.equal(manifest.kind, 'processing')
  const trust = options.extraCaCert === undefined ? null : extraCaCertificate(options.extraCaCert)
  // The real app, not this harness, decides whether this lock is trusted.
  const profile = options.retainedProfile ?? join(options.output, 'profile')
  if (options.retainedProfile) {
    assert.ok(!options.resume && !options.upgradeFromExecutableSha256, 'Retained setup cannot resume')
    validateRetainedProfile(profile, options.output)
  }
  if (!options.resume) {
    // Never adopt an existing output implicitly; a wizard profile is new by construction.
    assertPhysicalOutputParent(options.output)
    mkdirSync(options.output)
  }
  const started = Date.now(), deadline = started + options.timeoutMs
  const candidate = candidateIdentity(options.executable)
  const evidence = { schema: EVIDENCE_SCHEMA, kind: 'packaged-local-processing-smoke', mode: options.mode, startedAt: new Date(started).toISOString(),
    status: 'running', harness: { platform: process.platform, arch: process.arch, ...harnessIdentity() },
    layout: { kind: layout.kind, resources: layout.resources, python: layout.python, ffmpeg: layout.ffmpeg, ffprobe: layout.ffprobe }, input: { sha256: hash(input), bytes: input.length, durationSeconds: inputDuration },
    candidate, executableSha256: candidate.executableSha256,
    candidateObservations: [{ label: 'start', at: new Date(started).toISOString(), matches: true, identity: candidate }],
    runtimeManifestSha256: wizardMode ? null : hash(manifestBytes),
    // Wizard mode records the operator's expectation here and the observed
    // installed lock in runtimeLockSha256 only once it is verified.
    ...(wizardMode ? { expectedRuntimeLockSha256: options.expectedRuntimeLockSha256 } : { runtimeLockSha256: manifest.provenance?.lockSha256 }),
    // Wizard mode: set when the consent screen's install control is accepted.
    consent: { modelRetrieval: wizardMode ? null : !options.retainedProfile, localInference: true },
    shutdownStrategy: shutdownStrategy(process.platform), trust: { extraCaCertificate: null },
    timingsMs: {}, transitions: [],
    limitations: ['Not corpus accuracy or listening evidence', 'Not physical output or show qualification',
      'No representative RAM/VRAM measurement', 'Does not qualify a release catalog', executableIdentityLimitation(process.platform)] }
  // Compatibility field: the main harness file only; see harness.files.
  evidence.harnessSha256 = evidence.harness.files['test/packaged-processing-smoke.mjs']
  if (trust) evidence.limitations.push('An operator-supplied extra CA was trusted by the application\'s Node TLS for a private test source')
  if (wizardMode) evidence.limitations.push(...WIZARD_LIMITATIONS)
  if (options.retainedProfile) {
    evidence.release = validateRetainedCandidate(options.executable, options.expectedSourceCommit)
    evidence.retainedSetup = { profile, qualification: 'Fresh local inference with retained setup; not installation proof' }
    evidence.limitations.push(evidence.retainedSetup.qualification)
  }
  let artifactDirectory = options.output
  let resumed
  if (options.resume) {
    resumed = validateResume(options.output, evidence, options.upgradeFromExecutableSha256)
    // Each attempt has separate evidence and outputs; original bytes stay intact.
    artifactDirectory = join(options.output, `resume-${randomUUID()}`)
    mkdirSync(artifactDirectory)
    evidence.resume = { priorEvidence: '../evidence.json', priorEvidenceSha256: resumed.sha256,
      priorAttempts: resumed.attempts, priorStatus: resumed.prior.status, classification: resumed.prior.status === 'running'
        ? 'Prior attempt ended without a recorded outcome; interruption is not a pass'
        : 'Prior attempt failed; this is a new qualification attempt',
      priorCandidateIdentity: resumed.candidate.legacy ? 'legacy-executable-only' : 'candidate-tuple' }
    if (resumed.candidate.legacy) {
      evidence.limitations.push('Resumed from legacy evidence that recorded only the executable hash; the earlier application archive and native payload are unverified')
    }
    if (resumed.upgrade) {
      evidence.upgrade = resumed.upgrade
      evidence.limitations.push(resumed.upgrade.qualification)
    }
    evidence.application = resumed.prior.application
  }
  const save = () => writeFileSync(join(artifactDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  // Passed as NODE_EXTRA_CA_CERTS, which the application's managed child
  // processes inherit; it takes effect only while Electron's node-options
  // fuse remains enabled in the candidate.
  if (trust) evidence.trust = { extraCaCertificate: copyExtraCaCertificate(trust, artifactDirectory), inheritedByChildren: true }
  save()
  const observeCandidate = label => {
    const identity = candidateIdentity(options.executable)
    const matches = CANDIDATE_KEYS.every(key => identity[key] === candidate[key])
    evidence.candidateObservations.push({ label, at: new Date().toISOString(), matches, identity }); save()
    assert.ok(matches, `Candidate identity changed (${label}); the executable, archive, native payload records or receipt were modified during the run`)
  }
  const env = applicationEnvironment(process.env, process.platform, options.output, { extraCaCertificate: evidence.trust.extraCaCertificate?.copy })
  let application, host, databaseBaseline
  const database = join(profile, 'backend', 'desktop.db')
  const remaining = () => { const value = deadline - Date.now(); assert.ok(value > 0, 'Total processing smoke deadline exceeded'); return value }
  const bounded = async (operation, milliseconds = remaining()) => {
    let timer
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Processing smoke operation timed out')), Math.min(milliseconds, remaining())) })]) }
    finally { clearTimeout(timer) }
  }
  async function api(path) {
    return bounded(host.evaluate(async path => {
      const response = await fetch(path, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Application API returned ${response.status}`)
      return response.json()
    }, path), 20000)
  }
  async function close({ initiate, timeout = 30000 } = {}) {
    // `initiate(child, exited)` replaces Playwright close when the application
    // quits itself (the setup restart control); observation is identical.
    if (!application) return
    const owned = application; application = null
    const child = owned.process()
    let timer, onExit
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolveExit => { onExit = resolveExit; child.once('exit', onExit) })
    const start = initiate ? () => initiate(child, exited) : () => owned.close()
    if (shutdownStrategy(process.platform) === 'owned-process-tree') {
      evidence.shutdown ??= []
      // Same bounded close as the packaged smoke; it forces only the retained child.
      try {
        return await closePackagedApplication(owned, { timeout, table: () => processTable({ python: nativePython }), initiate: start,
          report: report => {
            const { entry, forced } = shutdownEvidence(report)
            if (forced) evidence.forcedShutdown = true
            if (entry.cleanupErrors?.length) evidence.shutdownCleanupError = entry.cleanupErrors.join('; ')
            evidence.shutdown.push(entry)
          } })
      } finally { if (onExit) child.removeListener('exit', onExit) }
    }
    try {
      await Promise.race([(async () => { await start(); await exited })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Application close timed out')), timeout) })])
      assert.equal(child.exitCode, 0, 'Owned application exited unsuccessfully')
      assert.equal(child.signalCode, null, 'Owned application exited by signal')
      ;(evidence.shutdown ??= []).push(shutdownEvidence({ event: 'closed', exitCode: child.exitCode, signalCode: child.signalCode }).entry)
    } catch (error) {
      ;(evidence.shutdown ??= []).push(shutdownEvidence({ event: 'shutdown-failed', error, exitCode: child.exitCode, signalCode: child.signalCode }).entry)
      // Force only the still-running owned process. Cleanup cannot turn an
      // unsuccessful or timed-out normal shutdown into qualification evidence.
      if (child.exitCode === null && child.signalCode === null) {
        evidence.forcedShutdown = true
        try {
          assert.equal(child.kill('SIGKILL'), true, 'Owned application forced cleanup did not send a signal')
        } catch { evidence.shutdownCleanupError = 'Owned application forced cleanup failed' }
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (onExit) child.removeListener('exit', onExit)
    }
  }
  async function launch() {
    const { _electron: electron } = await import('playwright')
    // Playwright owns launch timeout cleanup. An outer Promise.race could
    // abandon a late successful handle before it becomes ours to close.
    application = await electron.launch({ chromiumSandbox: true, executablePath: options.executable,
      args: [`--user-data-dir=${profile}`], env, timeout: Math.min(300000, remaining()) })
    remaining() // Assign ownership first so an expired deadline still closes it.
    const identity = await bounded(application.evaluate(({ app }) => ({ packaged: app.isPackaged,
      sandboxBypassSwitches: ['no-sandbox', 'disable-sandbox', 'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox', 'disable-gpu-sandbox', 'disable-namespace-sandbox', 'single-process', 'in-process-gpu'].filter(flag => app.commandLine.hasSwitch(flag)),
      ownsInstance: app.hasSingleInstanceLock(), userData: app.getPath('userData'), appVersion: app.getVersion(), platform: process.platform, arch: process.arch })))
    assert.equal(identity.packaged, true)
    validateHarnessArchitecture(evidence.harness, identity)
    assert.deepEqual(identity.sandboxBypassSwitches, [], 'Electron must run without sandbox bypass switches')
    assert.equal(identity.ownsInstance, true, 'Qualification profile is already in use')
    assert.ok(samePath(identity.userData, profile), 'Application selected a different profile')
    if (!options.retainedProfile) {
      assert.ok(isInside(options.output, identity.userData), 'Application profile escaped the isolated directory')
    }
    if (evidence.application) validateResumedApplication(evidence.application, identity)
    // Every launch is kept; `application` is the current one.
    evidence.applicationLaunches ??= []
    evidence.applicationLaunches.push({ at: new Date().toISOString(), ...identity })
    evidence.application = identity
    if (evidence.applicationLaunches.length > 1) observeCandidate(`relaunch-${evidence.applicationLaunches.length}`)
    const launchDeadline = Date.now() + Math.min(300000, remaining())
    while (!(host = application.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url())))) {
      assert.ok(Date.now() < launchDeadline, 'Application host did not start'); remaining(); await pause(200)
    }
    await bounded(host.waitForLoadState('domcontentloaded'))
    const preferences = await bounded(application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
      sandbox: window.webContents.getLastWebPreferences().sandbox,
      isolation: window.webContents.getLastWebPreferences().contextIsolation,
      node: window.webContents.getLastWebPreferences().nodeIntegration,
    }))))
    assert.ok(preferences.length > 0, 'Packaged application must have a sandboxed host window')
    for (const preference of preferences) assert.deepEqual(preference, { sandbox: true, isolation: true, node: false })
    assert.equal((await api('/health')).status, 'ok')
  }
  // The ordinary first-launch path: only visible UI controls act. The harness
  // reads setup status freely, but calls preflightSetup only before consent
  // (nothing installed) and only while the wizard is idle. Ends with the
  // promised runtime active after restart.
  async function wizardSetup() {
    const expectedLock = options.expectedRuntimeLockSha256, stepTimeout = () => Math.min(120000, remaining())
    const wizard = evidence.wizard = {}
    const readArchive = name => bounded(application.evaluate(({ app }, name) => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      const file = path.join(app.getAppPath(), name)
      return fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null
    }, name))
    const catalogEncoded = await readArchive('processing-catalog.json')
    assert.ok(catalogEncoded, 'This candidate ships no processing catalog; its setup wizard cannot offer local processing')
    const catalogBytes = Buffer.from(catalogEncoded, 'base64'), summary = summarizeCatalog(catalogBytes)
    wizard.catalog = summary
    evidence.limitations.push(...catalogLimitations(summary)); save()
    assertCatalogLock(summary, expectedLock, evidence.application)
    manifest = JSON.parse(catalogBytes.toString('utf8')).runtime
    const policyEncoded = await readArchive('models.json')
    assert.ok(policyEncoded, 'This candidate ships no model policy')
    const policyBytes = Buffer.from(policyEncoded, 'base64'), policy = JSON.parse(policyBytes.toString('utf8'))
    evidence.modelPolicySha256 = hash(policyBytes); save()

    await assertWizardHooks(host, { timeoutMs: stepTimeout() })
    const firstStep = await waitForStep(host, 'welcome', { timeoutMs: stepTimeout() })
    wizard.onboarding = { shownOnFirstLaunch: true, firstStep, harnessUsedAdvancedRoute: false }
    await waitForIdle(host, { timeoutMs: stepTimeout() })
    await control(host, 'onboarding-get-started').click()
    await chooseLocalAndContinue(host, { timeoutMs: stepTimeout() })
    // Before consent nothing is installed, so this preflight is a read.
    const plan = await bounded(readPlan(host), 60000)
    wizard.statusBeforeConsent = await bounded(readStatus(host), 20000)
    wizard.plan = assertWizardPlan(plan, summary, expectedLock)
    wizard.plan.identity = assertPlanIdentity(plan, { catalogRuntime: manifest, policy })
    wizard.consent = await bounded(consentSnapshot(host, plan), 20000)
    save()

    const setupStarted = Date.now(), tracker = createStatusTracker({ runtimeBytes: summary.runtimeBytes, start: setupStarted })
    const readLiveStatus = () => bounded(readStatus(host), 20000)
    // Accept the consent screen, then require setup to leave its prior state.
    async function accept() {
      const before = await readLiveStatus()
      await acceptConsent(host, { timeoutMs: stepTimeout() })
      const acceptedAt = new Date().toISOString()
      tracker.observe(await bounded(waitForSetupStart(readLiveStatus, { before, timeoutMs: SETUP_START_TIMEOUT_MS }), SETUP_START_TIMEOUT_MS + 30000))
      return acceptedAt
    }
    wizard.consent.acceptedAt = await accept()
    evidence.consent.modelRetrieval = 'application-setup-consent-screen'; save()

    // Optional recovery exercise: a cancel from the UI, or an injected source
    // failure, followed by "Review setup and retry" and the same plan.
    const recoveryMode = options.interruptRuntimeRetrieval ? 'cancel' : options.expectRetrievalFailure ? 'injected-failure' : null
    let recovery = null, lastRuntimeFile = null
    async function retryAfter(stoppedStep) {
      await waitForStep(host, stoppedStep, { timeoutMs: stepTimeout() })
      // Every archive part's staged size, read now: the part the server
      // failed is known only from its log, after retrieval is over.
      if (summary.delivery === 'archive') recovery.stagedPartsAfterStop = stagedArchivePartBytes(profile, summary.runtimeId, manifest)
      recovery.bytesPresentAfterStop = !recovery.file ? null
        : recovery.stagedPartsAfterStop ? recovery.stagedPartsAfterStop[recovery.file] ?? null
          : partialRuntimeBytes(profile, summary.runtimeId, recovery.file, manifest)
      tracker.nextAttempt()
      await retryFromUi(host, { timeoutMs: stepTimeout() })
      const retryPlan = await bounded(readPlan(host), 60000)
      assert.equal(retryPlan.planId, plan.planId, 'Retry offered a different installation plan')
      recovery.retryAcceptedAt = await accept()
      save()
    }
    for (;;) {
      remaining()
      const status = await readLiveStatus(), observation = tracker.observe(status)
      if (observation.transition) { wizard.transitions = tracker.transitions; save() }
      // Unpacking progress names unpacked files, never a retrieved unit.
      if (status.phase === 'runtime' && typeof status.progress?.file === 'string' && status.progress.phase !== 'extract') lastRuntimeFile = status.progress.file
      if (recoveryMode === 'cancel' && !recovery && shouldInterrupt(observation, status)) {
        recovery = wizard.recovery = { kind: 'cancel', at: new Date().toISOString(), elapsedMs: Date.now() - setupStarted,
          atFraction: observation.runtimeFraction, file: observation.progress.file, receivedAtCancel: observation.progress.received }
        await cancelFromUi(host)
        let after = status
        while (after.state === 'running') { remaining(); await pause(250); after = await readLiveStatus(); tracker.observe(after) }
        recovery.statusAfterStop = { state: after.state, retryable: after.retryable === true, message: after.message ?? null }
        save()
        assert.equal(after.state, 'cancelled', `Cancelling runtime retrieval ended in ${after.state}`)
        assert.equal(after.retryable, true, 'Cancelled setup is not retryable')
        await retryAfter('cancelled')
        continue
      }
      if (recoveryMode === 'injected-failure' && !recovery && observation.terminal === 'error') {
        recovery = wizard.recovery = { kind: 'injected-failure', at: new Date().toISOString(), elapsedMs: Date.now() - setupStarted,
          failedPhase: tracker.lastRunningPhase(), file: lastRuntimeFile, error: status.error ?? status.message ?? null,
          statusAfterStop: { state: status.state, retryable: status.retryable === true, message: status.message ?? null } }
        save()
        assert.equal(recovery.failedPhase, 'runtime', `Setup failed during ${recovery.failedPhase ?? 'an unknown phase'}, not runtime retrieval: ${recovery.error}`)
        assert.equal(status.retryable, true, 'Failed setup is not retryable')
        await retryAfter('error')
        continue
      }
      if (observation.terminal === 'error' || observation.terminal === 'cancelled') {
        throw new Error(`Setup ${observation.terminal}: ${status.error || status.message || 'no details supplied'}`)
      }
      // A fresh profile never loaded a runtime, so completion requires restart.
      assert.notEqual(observation.terminal, 'ready', 'Fresh setup reported ready without the required restart')
      if (observation.terminal === 'restart-required') break
      await pause(500)
    }
    wizard.transitions = tracker.transitions
    wizard.phases = tracker.summary()
    evidence.timingsMs.wizardSetup = Date.now() - setupStarted
    save()
    if (recoveryMode) {
      assert.ok(recovery, recoveryMode === 'cancel'
        ? 'Runtime retrieval finished before the 5% interruption point was observed; throttle the pack server (--throttle-bytes-per-second) or use a larger runtime'
        : 'Setup completed without the expected retrieval failure; start the pack server with --fail-after-bytes smaller than a runtime file')
      // Classified only from the source server's request log, read now that
      // retrieval is over; without it the retry is unproven.
      const log = options.packServerLog ? readPackServerLog(options.packServerLog) : null
      if (log) wizard.packServerLog = { path: log.path, sha256: log.sha256, requests: log.entries.length }
      const target = resolveRetryTarget({ runtime: manifest, recovery, log: log?.entries ?? null })
      if (target.serverInjectedFailure) {
        recovery.serverInjectedFailure = target.serverInjectedFailure
        recovery.serverFile = target.file
      }
      // The kept bytes of the unit the retry is judged on (the server's
      // failed part when its log names one).
      recovery.bytesPresentAfterStop = target.bytesPresent
      recovery.retry = classifyRetry({ bytesPresent: target.bytesPresent,
        retry: target.file ? tracker.fileObservations('runtime', target.file) : null,
        log: log?.entries ?? null, path: target.path, after: target.after, size: target.size })
      save()
      assertArchiveRetryResumed(summary, recovery.retry, { logged: Boolean(log) })
    }

    // Restart through the UI. The application's own relaunch would start an
    // instance the harness does not own, holding this profile's single-instance
    // lock; the request is recorded and the harness relaunches instead.
    await waitForStep(host, 'restart', { timeoutMs: stepTimeout() })
    await waitForIdle(host, { timeoutMs: stepTimeout() })
    const marker = join(artifactDirectory, 'application-relaunch-request.json')
    await bounded(interceptRelaunch(application, marker), 20000)
    wizard.restart = { relaunchedBy: 'harness', applicationRelaunch: 'intercepted-and-recorded' }
    save()
    const restartPage = host
    let clickError = null
    try {
      await close({ timeout: 120000, initiate: async (child, exited) => {
        // The page may close mid-click as the application quits; the relaunch
        // marker, not the click result, decides whether the request was made.
        try { await clickRestart(restartPage) } catch (error) { clickError = error.message }
        await exited
      } })
    } finally {
      host = null
      wizard.restart.relaunchRequest = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null
      if (wizard.restart.relaunchRequest) wizard.restart.initiatedBy = 'application-ui'
      else if (clickError) wizard.restart.clickError = clickError
      save()
    }
    assert.ok(wizard.restart.relaunchRequest, 'The restart control exited the application without requesting a relaunch')
    await launch()

    // Let the wizard's own preflight re-verify the runtime and settle; the
    // harness starts no verification of its own here.
    const settleTimeout = Math.min(POST_RESTART_SETTLE_TIMEOUT_MS, remaining())
    const post = await bounded(observePostRestart(host, { timeoutMs: settleTimeout }), settleTimeout + 30000)
    wizard.postRestart = { observations: post.observations, settled: post.settled, timedOut: post.timedOut, elapsedMs: post.elapsedMs }
    save()
    judgePostRestart({ ...post, timeoutMs: settleTimeout })
    const postReadiness = await api('/api/features/processing')
    let installed, installedModels
    try { installed = installedRuntimeIdentity(profile, postReadiness.runtime?.id) } catch (error) { installed = { error: error.message } }
    try { installedModels = installedModelsIdentity(profile) } catch (error) { installedModels = { error: error.message } }
    Object.assign(wizard.postRestart, { runtime: postReadiness.runtime, installed, installedModels })
    save()
    assert.ok(!installed.error, installed.error)
    assert.ok(!installedModels.error, installedModels.error)
    assertPostRestart({ settled: post.settled, readiness: postReadiness, installed, installedModels }, summary, expectedLock,
      wizard.plan.identity.modelsManifestId)
    evidence.runtimeLockSha256 = installed.runtimeLockSha256
    evidence.installedModelsId = installedModels.modelsId
    save()
  }
  try {
    if (options.retainedProfile) {
      databaseBaseline = retainedDatabaseSnapshot(nativePython, database, true)
      evidence.retainedSetup.databaseBaseline = databaseBaseline
      save()
    }
    await launch()
    const songs = await api('/api/songs?page_size=500')
    const priorSongs = [], priorJobs = [], retainedRecords = []
    const priorStemIds = options.retainedProfile && existsSync(join(profile, 'backend', 'stems'))
      ? readdirSync(join(profile, 'backend', 'stems')) : []
    if (options.retainedProfile) {
      assert.equal(songs.songs.length, songs.total, 'Retained qualification requires at most 500 songs')
      for (const summary of songs.songs) {
        const record = await api(`/api/songs/${summary.id}`)
        assert.ok(['ready', 'failed'].includes(record.status), 'Retained profile has an unfinished song')
        priorSongs.push(record.id)
        if (record.job_id) {
          const job = await api(`/api/jobs/${encodeURIComponent(record.job_id)}`)
          assert.ok(['done', 'failed'].includes(job.status), 'Retained profile has an active job')
          priorJobs.push(record.job_id)
          retainedRecords.push({ songId: record.id, jobId: record.job_id, job, song: record })
        } else retainedRecords.push({ songId: record.id, jobId: record.job_id, song: record })
      }
      evidence.retainedSetup.priorSongs = priorSongs
      evidence.retainedSetup.priorJobs = priorJobs
      evidence.retainedSetup.priorRecordsSha256 = hash(Buffer.from(JSON.stringify(retainedRecords)))
      save()
    } else assert.equal(songs.total, 0, 'Qualification profile must have an empty library')
    const featurePolicy = await api('/api/features')
    assert.equal(featurePolicy.lyrics_lookup.enabled, false, 'External lyric lookup must be disabled')
    const initialReadiness = await api('/api/features/processing')
    evidence.initialReadiness = initialReadiness
    if (wizardMode) {
      assert.equal(initialReadiness.runtime, null, 'Wizard mode requires a profile with no admitted processing runtime')
      evidence.runtimeReused = false; save()
      await wizardSetup()
    } else {
      evidence.runtimeReused = Boolean((resumed || options.retainedProfile) && reusableRuntime(initialReadiness, manifest)); save()
      assert.ok(options.retainedProfile && evidence.runtimeReused, 'Retained runtime must be admitted without installation')
      const policyEncoded = await bounded(application.evaluate(({ app }) => {
        const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
        return fs.readFileSync(path.join(app.getAppPath(), 'models.json')).toString('base64')
      }))
      const policyBytes = Buffer.from(policyEncoded, 'base64')
      const policy = JSON.parse(policyBytes.toString('utf8'))
      const entries = MODEL_IDS.map(id => { const matches = policy.models.filter(entry => entry.id === id); assert.equal(matches.length, 1); return matches[0] })
      const modelManifest = { schema: 1, kind: 'models', models: MODEL_IDS, files: entries.flatMap(entry => entry.files) }
      const modelPath = join(artifactDirectory, 'model-manifest.json')
      const modelManifestBytes = Buffer.from(`${JSON.stringify(modelManifest, null, 2)}\n`)
      if (resumed) {
        if (resumed.prior.modelPolicySha256) assert.equal(hash(policyBytes), resumed.prior.modelPolicySha256, 'Packaged model policy changed')
        if (resumed.prior.modelManifestSha256) assert.equal(hash(modelManifestBytes), resumed.prior.modelManifestSha256, 'Model manifest changed')
        const oldModelPath = join(options.output, 'model-manifest.json')
        if (existsSync(oldModelPath)) {
          assert.ok(lstatSync(oldModelPath).isFile() && !lstatSync(oldModelPath).isSymbolicLink(), 'Prior model manifest must be a regular file')
          assert.equal(hash(readFileSync(oldModelPath)), hash(modelManifestBytes), 'Prior model manifest changed')
        }
      }
      writeFileSync(modelPath, modelManifestBytes, { flag: 'wx' })
      evidence.modelPolicySha256 = hash(policyBytes)
      evidence.modelManifestSha256 = hash(modelManifestBytes)
    }
    const readiness = await api('/api/features/processing')
    evidence.readiness = readiness
    assert.equal(readiness.separation.ready, true); assert.equal(readiness.transcription.ready, true)
    assert.equal(readiness.modal.selected, false); assert.equal(readiness.modal.ready, false)
    assert.equal(readiness.runtime.accelerator, manifest.accelerator)
    assert.equal(readiness.runtime.id, hash(Buffer.from(JSON.stringify(manifest))), 'Application selected a different processing runtime')
    const inferenceStarted = Date.now()
    // Persist before POST: a crash after server acceptance but before its reply
    // must never make a later resume treat the profile as installation-only.
    evidence.inferenceStartedAt = new Date(inferenceStarted).toISOString()
    writeFileSync(join(artifactDirectory, 'inference-started.json'),
      `${JSON.stringify({ startedAt: evidence.inferenceStartedAt })}\n`, { flag: 'wx', flush: true })
    save()
    const submitted = await bounded(host.evaluate(async ({ bytes, filename }) => {
      const data = Uint8Array.from(atob(bytes), value => value.charCodeAt(0)), form = new FormData()
      form.append('file', new Blob([data], { type: 'application/octet-stream' }), filename)
      form.append('artist', 'Licensed qualification audio'); form.append('title', 'Isolated processing smoke')
      form.append('karaoke_model', 'roformer'); form.append('llm_correction', 'false'); form.append('llm_paging', 'false')
      // Ingest selects Heart internally; there is no whisper_model upload field.
      const response = await fetch('/api/separate', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
      if (response.status !== 202) throw new Error(`Audio upload returned ${response.status}`)
      return response.json()
    }, { bytes: input.toString('base64'), filename: basename(options.audio) }), 65000)
    validateFreshSubmission(submitted, priorSongs, priorJobs)
    assert.ok(!priorStemIds.includes(String(submitted.song_id)), 'Submission reused existing stem storage')
    evidence.songId = submitted.song_id; evidence.jobId = submitted.job_id
    save()
    let job, previous
    while (true) {
      remaining(); job = await api(`/api/jobs/${encodeURIComponent(submitted.job_id)}`)
      const state = `${job.status}/${job.phase}`
      if (state !== previous) { evidence.transitions.push({ elapsedMs: Date.now() - inferenceStarted, status: job.status, phase: job.phase }); previous = state; save() }
      if (job.status === 'failed') { evidence.jobError = job.error || 'No error details supplied'; throw new Error('Application processing job failed; inspect evidence.json and isolated application diagnostics') }
      if (job.status === 'done') break
      await pause(2000)
    }
    evidence.timingsMs.localPipeline = Date.now() - inferenceStarted
    const song = await api(`/api/songs/${submitted.song_id}`)
    assert.equal(song.status, 'ready'); assert.equal(song.word_sync?.metadata?.model, 'heart')
    const words = song.word_sync.lines?.flat() || []
    assert.equal(song.word_sync?.metadata?.pipeline_config?.correction?.enabled, false, 'External correction must remain disabled')
    assert.ok(words.length > 0, 'Real Heart inference must produce word timings for the vocal excerpt')
    assert.ok(words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start), 'Invalid word intervals')
    assert.ok(words.every((word, index) => index === 0 || word.start >= words[index - 1].start), 'Word intervals are not ordered')
    evidence.transcription = { model: 'heart', words: words.length, lastWordEnd: Math.max(...words.map(word => word.end)) }
    evidence.outputs = {}
    for (const role of ['lead_vocals', 'backing_vocals', 'instrumental', 'karaoke']) {
      const url = song.stems?.[role]; assert.ok(url, `Missing ${role} output`)
      const encoded = await bounded(host.evaluate(async url => {
        const target = new URL(url, location.href)
        if (target.origin !== location.origin) throw new Error('Unexpected nonlocal output URL')
        const response = await fetch(target, { signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error('Output could not be read')
        const bytes = new Uint8Array(await response.arrayBuffer())
        let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return btoa(binary)
      }, url), 35000)
      const bytes = Buffer.from(encoded, 'base64'), path = join(artifactDirectory, `${role}.wav`)
      writeFileSync(path, bytes, { flag: 'wx' })
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration_ts,time_base:format=duration', '-of', 'json', path], { timeout: Math.min(30000, remaining()), encoding: 'utf8' }))
      execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', path, '-f', 'null', '-'], { timeout: Math.min(60000, remaining()), stdio: 'pipe' })
      assert.equal(probe.streams?.[0]?.codec_name, 'pcm_s16le', 'Expected finite PCM16 playback output')
      evidence.outputs[role] = { sha256: hash(bytes), bytes: bytes.length, probe, decodePassed: true }
    }
    const reference = evidence.outputs.lead_vocals.probe.streams[0]
    assert.equal(reference.channels, 2, 'Expected stereo playback outputs')
    assert.ok(Number(reference.duration_ts) > 0 && Number(reference.sample_rate) > 0, 'Output audio is empty')
    assert.ok(Math.abs(Number(evidence.outputs.lead_vocals.probe.format.duration) - inputDuration) <= 0.1, 'Processing truncated or extended the input duration')
    for (const item of Object.values(evidence.outputs)) assert.deepEqual(item.probe.streams[0], reference, 'Output stems are not aligned')
    assert.ok(evidence.transcription.lastWordEnd <= Number(evidence.outputs.lead_vocals.probe.format.duration) + 0.5, 'Word timing exceeds audio duration')
    if (options.retainedProfile) {
      for (const prior of retainedRecords) {
        const record = await api(`/api/songs/${prior.songId}`)
        assert.deepEqual(record, prior.song, 'Retained song changed')
        if (prior.jobId) assert.deepEqual(await api(`/api/jobs/${encodeURIComponent(prior.jobId)}`), prior.job, 'Retained job changed')
      }
      assert.ok(evidence.transitions.some(item => item.phase === 'separating'), 'Fresh separation phase was not observed')
      evidence.retainedSetup.priorRecordsPreserved = true
    }
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message
    if (host && !options.retainedProfile) await bounded(host.evaluate(() => window.karaokeDesktop?.cancelSetup()), 5000).catch(() => {})
    throw error
  } finally {
    try { await close() }
    catch (error) { evidence.status = 'failed'; evidence.shutdownError = 'Owned application shutdown failed'; throw error }
    finally {
      if (databaseBaseline) {
        try {
          evidence.retainedSetup.preservationAudit = auditRetainedDatabase(databaseBaseline,
            retainedDatabaseSnapshot(nativePython, database))
        } catch (error) {
          evidence.status = 'failed'
          evidence.retainedSetup.preservationAudit = { status: 'failed', error: error.message }
        }
      }
      try { observeCandidate('after-final-shutdown') } catch (error) {
        evidence.status = 'failed'; evidence.candidateChangeError = error.message
      }
      evidence.finishedAt = new Date().toISOString(); evidence.timingsMs.total = Date.now() - started; save()
    }
  }
  assert.equal(evidence.status, 'passed', 'Processing qualification failed; inspect evidence.json')
  console.log(`Real local processing smoke passed. Evidence: ${join(artifactDirectory, 'evidence.json')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
