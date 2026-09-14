// SPDX-License-Identifier: AGPL-3.0-only
// Stable first-install launcher for authenticated managed application slots.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RecoveryStore, UpdateStore } from './update_manager.mjs'
import { canonicalJson } from './release.mjs'
import { exactComponentLayout, readRecoveryAnchor, stableFirstInstallerExecutable } from './recovery_launcher.mjs'
import { checkedFile } from './runtime_manager.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function exactDirectory(path, label) {
  let info, canonical
  try { info = await lstat(path); canonical = await realpath(path) } catch {
    throw new Error(`${label} is missing or not canonical`)
  }
  if (path !== resolve(path) || canonical !== path || info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is missing or not canonical`)
  }
  return path
}

async function exactFile(path, label) {
  let info, canonical
  try { info = await lstat(path); canonical = await realpath(path) } catch {
    throw new Error(`${label} is missing or not canonical`)
  }
  if (path !== resolve(path) || canonical !== path || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} is missing or not canonical`)
  }
  return path
}

export function waitForReady(child, { timeoutMs = 5000 } = {}) {
  return new Promise((resolveReady, reject) => {
    let buffer = '', settled = false
    const timer = setTimeout(() => finish(new Error('Managed launcher readiness timed out')), timeoutMs)
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer)
      child.stdout.off('data', onData); child.off('error', onError); child.off('exit', onExit)
      if (error) reject(error); else resolveReady()
    }
    const onData = bytes => {
      buffer += bytes.toString('utf8')
      if (buffer.length > 128) return finish(new Error('Invalid managed launcher readiness handshake'))
      const newline = buffer.indexOf('\n'); if (newline < 0) return
      if (buffer.slice(0, newline) !== 'READY' || buffer.slice(newline + 1) !== '') return finish(new Error('Invalid managed launcher readiness handshake'))
      finish()
    }
    const onError = () => finish(new Error('Could not start managed launcher'))
    const onExit = () => finish(new Error('Managed launcher exited before handoff'))
    child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit)
  })
}

export async function waitForExit(pid, { probe = value => process.kill(value, 0), delay = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Managed launcher requires its parent process identity')
  for (;;) {
    try { probe(pid) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await delay(100)
  }
}

export function managedLaunchEnvironment(source = process.env) {
  const environment = { ...source }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.SINGHOUSE_RECOVERY_KIT
  return environment
}

export async function acquireActivationLock({ stateRoot, pythonPath, helperPath, spawnImpl = spawn,
  timeoutMs = 190000 } = {}) {
  if (!pythonPath || !helperPath) throw new Error('Managed launcher requires its retained native activation-lock helper')
  const child = spawnImpl(pythonPath, ['-I', '-B', helperPath, '--activation-lock', resolve(stateRoot)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  try { await waitForReady(child, { timeoutMs }) }
  catch (error) { try { child.stdin?.end() } catch {} throw error }
  let released = false, rejectLost
  const controller = new AbortController()
  const lost = new Promise((resolveLost, reject) => { rejectLost = reject })
  // The rejection is also observed by callers through raceActivation. Keep a
  // handler attached immediately so loss between bootstrap phases is never an
  // unhandled rejection.
  lost.catch(() => {})
  const leaseFailure = () => {
    if (released) return
    const error = new Error('Native activation-lock lease was lost')
    controller.abort(error); rejectLost(error)
  }
  child.once('error', leaseFailure); child.once('exit', leaseFailure)
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) leaseFailure()
  return { child, signal: controller.signal, lost, async release() {
    if (released) return
    released = true
    child.off('error', leaseFailure); child.off('exit', leaseFailure)
    if (controller.signal.aborted) { try { child.stdin?.end() } catch {}; return }
    const ended = exited(child)
    child.stdin.end()
    await ended
    if (child.exitCode !== 0) throw new Error('Native activation-lock helper failed while releasing the lock')
  } }
}

export async function launchManaged(active, { platform = process.platform, spawnImpl = spawn,
  openExecutable = checkedFile, environment = process.env, signal } = {}) {
  signal?.throwIfAborted()
  const executable = await openExecutable(active.path, constants.O_RDONLY)
  try {
    signal?.throwIfAborted()
    const options = { detached: true, windowsHide: true, stdio: 'ignore', env: managedLaunchEnvironment(environment), ...(signal ? { signal } : {}) }
    let command = active.path, args = []
    if (platform === 'linux') {
      command = '/proc/self/fd/3'; options.stdio = ['ignore', 'ignore', 'ignore', executable.fd]
    } else if (platform !== 'win32' && platform !== 'darwin') throw new Error(`No managed launch primitive for ${platform}`)
    const child = spawnImpl(command, args, options)
    if (typeof child.once === 'function') {
      try { await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject) }) }
      catch (error) {
        // Preserve the partially-created process as evidence for the bootstrap.
        // The lease owner must reap it before restoring the paired recovery point.
        Object.defineProperty(error, 'managedChild', { value: child, configurable: true })
        throw error
      }
    }
    // The bootstrap remains the target's supervisor until presentation is
    // durably acknowledged.  Detaching here would turn a startup crash into
    // an apparently successful update and strand its paired recovery point.
    const result = { launched: true, releaseId: active.releaseId, pid: child.pid }
    Object.defineProperty(result, 'child', { value: child })
    return result
  } finally { await executable.close() }
}

function sameHandoff(left, right) {
  const withoutCompletion = value => {
    const { state, completedAt, ...binding } = value || {}
    return binding
  }
  return canonicalJson(withoutCompletion(left)) === canonicalJson(withoutCompletion(right))
}

export async function presentationAcknowledged(store, handoff, recovery) {
  const current = await store.journal()
  if (current?.state !== 'completed' || !sameHandoff(current, handoff)) return false
  await store.verifyHandoff(current, recovery)
  const active = await store.active({ handoff: current })
  if (active?.releaseId !== handoff.targetIdentity.releaseId) return false
  await store.verifyCompletion(current)
  return true
}

function activationError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Native activation-lock lease was lost')
}

async function raceActivation(held, operation) {
  if (held.signal?.aborted) throw activationError(held.signal)
  const result = held.lost ? await Promise.race([Promise.resolve(operation), held.lost]) : await operation
  if (held.signal?.aborted) throw activationError(held.signal)
  return result
}

async function launchWithActivation(held, launch, active, options) {
  const pending = Promise.resolve().then(() => launch(active, { ...options, signal: held.signal }))
  try { return await raceActivation(held, pending) }
  catch (error) {
    // If the launch crossed lease loss, wait for its bounded spawn handshake
    // and reap the target before allowing another bootstrap to recover.
    try { const launched = await pending; await stopManagedTarget(launched?.child) }
    catch (launchError) { try { await stopManagedTarget(launchError.managedChild) } catch {} }
    throw error
  }
}

async function launchAwaitingTarget(held, launch, active, launchOptions, recoveryOptions) {
  try { return await launchWithActivation(held, launch, active, launchOptions) }
  catch (error) {
    if (held.signal?.aborted) throw activationError(held.signal)
    await stopManagedTarget(error.managedChild)
    if (held.signal?.aborted) throw activationError(held.signal)
    await raceActivation(held, recoveryOptions.recover(recoveryOptions.handoff, {
      stateRoot: recoveryOptions.stateRoot, platform: recoveryOptions.platform, arch: recoveryOptions.arch,
      signal: held.signal, pythonPath: recoveryOptions.pythonPath, helperPath: recoveryOptions.helperPath,
    }))
    return { launched: false, releaseId: active.releaseId, recovered: true, failure: error.message }
  }
}

function abortRejection(signal) {
  if (!signal) return new Promise(() => {})
  if (signal.aborted) return Promise.reject(activationError(signal))
  return new Promise((resolveAbort, reject) => signal.addEventListener('abort', () => reject(activationError(signal)), { once: true }))
}

function exited(child) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}

export async function stopManagedTarget(child, { timeoutMs = 5000,
  delay = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  // A spawn error without a PID created no process to reap and may never emit
  // exit. A failed handshake with a PID is still a live partial target.
  if (!child || !child.pid || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return
  const ended = exited(child)
  try { child.kill('SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  if (await Promise.race([ended.then(() => true), delay(timeoutMs).then(() => false)])) return
  try { child.kill('SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  if (!await Promise.race([ended.then(() => true), delay(timeoutMs).then(() => false)])) {
    throw new Error('Managed target did not exit after forced shutdown')
  }
}

export async function invokePairedRecovery(journal, { stateRoot, platform = process.platform, arch = process.arch,
  spawnImpl = spawn, environment = process.env, signal, pythonPath, helperPath } = {}) {
  signal?.throwIfAborted()
  if (!pythonPath || !helperPath) throw new Error('Automatic recovery requires the verified native trust anchor')
  const kitRoot = join(resolve(stateRoot), 'recovery-tool', 'kits', journal.recoveryKit.id)
  const manifestBytes = await readFile(join(kitRoot, 'manifest.json'))
  let manifest
  try { manifest = JSON.parse(manifestBytes) } catch { throw new Error('Invalid handoff-bound recovery kit manifest') }
  if (manifest.target?.platform !== platform || manifest.target?.arch !== arch ||
      sha256(Buffer.from(canonicalJson(manifest))) !== journal.recoveryKit.manifestSha256) {
    throw new Error('Recovery kit does not match the exact managed handoff target')
  }
  const recoveryArgs = [resolve(stateRoot), journal.recoveryPoint, join(resolve(stateRoot), 'backend')]
  const child = spawnImpl(pythonPath, ['-I', '-B', helperPath, '--launch-recovery-kit', kitRoot,
    journal.recoveryKit.manifestSha256, platform, arch, JSON.stringify(recoveryArgs)], {
    env: { ...environment },
    windowsHide: true, stdio: 'ignore',
  })
  await new Promise((done, reject) => {
    const abort = () => {
      stopManagedTarget(child).then(() => reject(activationError(signal)), reject)
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('exit', code => {
      signal?.removeEventListener('abort', abort)
      code === 0 ? done() : reject(signal?.aborted ? activationError(signal) : new Error('Automatic paired recovery failed'))
    })
  })
  return { recovered: true, releaseId: journal.previousIdentity.releaseId }
}

export async function superviseManagedTarget(launched, { store, handoff, recovery, stateRoot,
  platform = process.platform, arch = process.arch, timeoutMs = 30000,
  pollMs = 100, now = Date.now, delay = ms => new Promise(done => setTimeout(done, ms)),
  stop = stopManagedTarget, recover = invokePairedRecovery, signal, pythonPath, helperPath } = {}) {
  const child = launched?.child
  if (!child) throw new Error('Managed launch did not provide a supervised target')
  const targetExited = exited(child).then(() => true)
  const leaseLost = abortRejection(signal)
  const deadline = now() + timeoutMs
  try {
    for (;;) {
      signal?.throwIfAborted()
      if (await Promise.race([presentationAcknowledged(store, handoff, recovery), leaseLost])) {
        child.unref?.()
        return { ...launched, acknowledged: true }
      }
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error('Managed target presentation acknowledgement timed out')
      if (await Promise.race([targetExited, delay(Math.min(pollMs, remaining)).then(() => false), leaseLost])) {
        throw new Error('Managed target exited before durable presentation')
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      await stop(child)
      throw activationError(signal)
    }
    // Completion can race the exit/timeout signal. Once the exact durable
    // acknowledgement exists, a later target exit must never roll it back.
    let acknowledged = false
    try { acknowledged = await Promise.race([presentationAcknowledged(store, handoff, recovery), leaseLost]) }
    catch (completionError) {
      if (signal?.aborted) { await stop(child); throw activationError(signal) }
      // An incoherent completion record is not an acknowledgement. The exact
      // retained handoff remains the authority for paired recovery below.
    }
    if (signal?.aborted) { await stop(child); throw activationError(signal) }
    if (acknowledged) {
      child.unref?.()
      return { ...launched, acknowledged: true }
    }
    await stop(child)
    await recover(handoff, { stateRoot, platform, arch, signal, pythonPath, helperPath })
    return { ...launched, acknowledged: false, recovered: true, failure: error.message }
  }
}

export async function runBootstrap({ stateRoot, parentPid, contract, platform = process.platform, arch = process.arch,
  durableReplace, platformTrust, wait = waitForExit, launch = launchManaged, ready = () => {}, storeFactory,
  recoveryFactory, supervise = superviseManagedTarget, recover = invokePairedRecovery, pythonPath, helperPath,
  activation = acquireActivationLock } = {}) {
  const held = await activation({ stateRoot, pythonPath, helperPath })
  try {
    // Do not even invoke the readiness writer when acquisition returned an
    // already-lost lease. Function arguments are evaluated before
    // raceActivation can inspect the signal.
    held.signal?.throwIfAborted()
    await raceActivation(held, ready())
    await raceActivation(held, wait(parentPid))
    const factory = storeFactory || ((...args) => new UpdateStore(...args))
    const store = factory(join(resolve(stateRoot), 'updates'), contract, { platform, arch }, { stateRoot: resolve(stateRoot), durableReplace, platformTrust })
    const journal = await raceActivation(held, store.journal())
    if (!journal) throw new Error('No authenticated update handoff is available')
    const makeRecovery = recoveryFactory || ((root, options) => new RecoveryStore(root, options))
    const recovery = makeRecovery(join(resolve(stateRoot), 'recovery'), { stateRoot: resolve(stateRoot), durableReplace })
    // A second bootstrap may have waited while the singleton winner completed
    // recovery. Re-authenticate the selection after taking the lock; a loser
    // launches that recovered selection and never initiates another rollback.
    const active = await raceActivation(held, store.authenticatedActive())
    if (!active) throw new Error('No authenticated managed application is selected')
    if (active.releaseId !== journal.targetIdentity.releaseId) {
      if (active.releaseId !== journal.previousIdentity.releaseId) throw new Error('Managed selection is not authorized by the authenticated handoff')
      const launched = await launchWithActivation(held, launch, active, { platform })
      launched.child?.unref?.()
      return { ...launched, reconciled: true }
    }
    await raceActivation(held, store.verifyHandoff(journal, recovery))
    const launched = await launchAwaitingTarget(held, launch, active, { platform },
      { recover, handoff: journal, stateRoot, platform, arch, pythonPath, helperPath })
    if (launched.recovered) return launched
    return await supervise(launched, { store, handoff: journal, recovery, stateRoot, platform, arch, signal: held.signal, pythonPath, helperPath })
  } finally { await held.release() }
}

export async function runStableBootstrap({ stateRoot, parentPid, contract, platform = process.platform, arch = process.arch,
  durableReplace, platformTrust, wait = waitForExit, launch = launchManaged, ready = () => {}, storeFactory,
  recoveryFactory, supervise = superviseManagedTarget, recover = invokePairedRecovery, pythonPath, helperPath,
  activation = acquireActivationLock } = {}) {
  const held = await activation({ stateRoot, pythonPath, helperPath })
  try {
    held.signal?.throwIfAborted()
    await raceActivation(held, ready())
    await raceActivation(held, wait(parentPid))
    const factory = storeFactory || ((...args) => new UpdateStore(...args))
    const store = factory(join(resolve(stateRoot), 'updates'), contract, { platform, arch }, { stateRoot: resolve(stateRoot), durableReplace, platformTrust })
    const journal = await raceActivation(held, store.journal())
    const active = await raceActivation(held, store.authenticatedActive())
    if (!active) throw new Error('No authenticated managed application is selected')
    if (journal?.state !== 'completed' && active.releaseId === journal?.targetIdentity?.releaseId) {
      const makeRecovery = recoveryFactory || ((root, options) => new RecoveryStore(root, options))
      const recovery = makeRecovery(join(resolve(stateRoot), 'recovery'), { stateRoot: resolve(stateRoot), durableReplace })
      await raceActivation(held, store.verifyHandoff(journal, recovery))
      const launched = await launchAwaitingTarget(held, launch, active, { platform },
        { recover, handoff: journal, stateRoot, platform, arch, pythonPath, helperPath })
      if (launched.recovered) return launched
      return await supervise(launched, { store, handoff: journal, recovery, stateRoot, platform, arch, signal: held.signal, pythonPath, helperPath })
    }
    const launched = await launchWithActivation(held, launch, active, { platform })
    launched.child?.unref?.()
    return launched
  } finally { await held.release() }
}

async function defaultAnchorPlatformTrust(anchor, { spawnImpl = spawn } = {}) {
  // Linux remains disabled until a qualified release supplies a native/detached verifier for
  // the exact outer AppImage bytes. A digest recorded by an untrusted first
  // launch is integrity evidence, not publisher authentication.
  if (anchor.platform === 'linux') return false
  const command = anchor.platform === 'darwin' ? '/usr/bin/codesign' : 'powershell.exe'
  const args = anchor.platform === 'darwin'
    ? ['--verify', '--deep', '--strict', anchor.executablePath]
    : ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${anchor.executablePath.replaceAll("'", "''")}').Status -eq 'Valid' | ForEach-Object { if ($_){exit 0}else{exit 1} }`]
  return new Promise(resolveTrust => {
    const child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolveTrust(false)); child.once('exit', code => resolveTrust(code === 0))
  })
}

export async function verifyRecoveryAnchor(anchorPath, { platform = process.platform, arch = process.arch,
  executablePath = process.execPath, bootstrapPath = fileURLToPath(import.meta.url), pythonPath = process.execPath,
  helperPath = fileURLToPath(import.meta.url), verifiedAppImage = null, platformTrust = defaultAnchorPlatformTrust } = {}) {
  const anchor = readRecoveryAnchor(anchorPath)
  if (anchor.platform !== platform || anchor.arch !== arch) {
    throw new Error('Recovery trust anchor path or target changed; reinstall Singhouse before attempting recovery')
  }
  const selectedAnchor = resolve(anchorPath), canonicalAnchor = await realpath(anchorPath), stateRoot = dirname(dirname(canonicalAnchor))
  if (anchorPath !== selectedAnchor || selectedAnchor !== canonicalAnchor || anchor.anchorPath !== canonicalAnchor ||
      canonicalAnchor !== join(stateRoot, 'recovery-tool', 'anchor.json') || anchor.stateRoot !== stateRoot) {
    throw new Error('Recovery trust anchor state root changed; reinstall Singhouse before attempting recovery')
  }
  const paths = { executablePath, bootstrapPath, pythonPath, helperPath }
  let currentLayout
  try { currentLayout = exactComponentLayout(platform, paths, verifiedAppImage) } catch {
    throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
  }
  if (canonicalJson(currentLayout) !== canonicalJson(anchor.componentLayout)) {
    throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
  }
  if (platform === 'linux') {
    let outer
    try { outer = stableFirstInstallerExecutable({ platform, executablePath: verifiedAppImage?.actualExecutablePath, verifiedAppImage }) } catch {
      throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
    }
    if (outer !== anchor.executablePath || executablePath !== outer) throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
    let actualBytes
    try { actualBytes = await readFile(verifiedAppImage.actualExecutablePath) } catch {
      throw new Error('Recovery trust anchor is missing or corrupt; reinstall Singhouse before attempting recovery')
    }
    if (sha256(actualBytes) !== anchor.digests.actualExecutablePath) throw new Error('Recovery trust anchor is missing or corrupt; reinstall Singhouse before attempting recovery')
    for (const name of ['bootstrapPath', 'pythonPath', 'helperPath']) {
      const logical = anchor.componentLayout[name]
      if (paths[name] !== join(verifiedAppImage.mountPath, ...logical.split('/'))) {
        throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
      }
    }
  } else if (!Object.keys(paths).every(name => paths[name] === anchor.componentLayout[name])) {
    throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
  }
  for (const [name, path] of Object.entries(paths)) {
    let canonical, info
    try { canonical = await realpath(path); info = await lstat(path) } catch {
      throw new Error('Recovery trust anchor is missing or corrupt; reinstall Singhouse before attempting recovery')
    }
    if (path !== resolve(path) || canonical !== path || info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Recovery trust anchor component layout changed; reinstall Singhouse before attempting recovery')
    }
    let bytes
    try { bytes = await readFile(path) } catch { throw new Error('Recovery trust anchor is missing or corrupt; reinstall Singhouse before attempting recovery') }
    if (sha256(bytes) !== anchor.digests?.[name]) throw new Error('Recovery trust anchor is missing or corrupt; reinstall Singhouse before attempting recovery')
  }
  if (!await platformTrust(anchor, { verifiedAppImage })) throw new Error('Recovery trust anchor platform signature is invalid; reinstall Singhouse before attempting recovery')
  return anchor
}

export async function runRecoveryAnchor({ anchorPath, kitRoot, recoveryArgs, spawnImpl = spawn,
  platformTrust, platform = process.platform, arch = process.arch, executablePath = process.execPath,
  bootstrapPath = fileURLToPath(import.meta.url), pythonPath = process.execPath, helperPath = fileURLToPath(import.meta.url), verifiedAppImage = null } = {}) {
  if (!Array.isArray(recoveryArgs) || recoveryArgs.length !== 3 || !recoveryArgs.every(value => typeof value === 'string')) {
    throw new Error('Invalid standalone recovery arguments')
  }
  const selectedAnchor = resolve(anchorPath)
  if (anchorPath !== selectedAnchor) throw new Error('Recovery invocation does not use the exact canonical trust anchor path')
  const boundAnchor = readRecoveryAnchor(anchorPath)
  const canonicalAnchor = await realpath(selectedAnchor)
  const stateRoot = dirname(dirname(canonicalAnchor))
  if (selectedAnchor !== canonicalAnchor || boundAnchor.anchorPath !== canonicalAnchor ||
      canonicalAnchor !== join(stateRoot, 'recovery-tool', 'anchor.json') ||
      boundAnchor.stateRoot !== stateRoot ||
      recoveryArgs[0] !== stateRoot || recoveryArgs[2] !== join(stateRoot, 'backend')) {
    throw new Error('Recovery invocation does not match the trust anchor state root')
  }
  await exactDirectory(stateRoot, 'Recovery state root')
  await exactDirectory(join(stateRoot, 'updates'), 'Recovery update state')
  const handoffPath = join(stateRoot, 'updates', 'handoff.json')
  await exactFile(handoffPath, 'Recovery handoff')
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'))
  const expectedKit = join(stateRoot, 'recovery-tool', 'kits', handoff.recoveryKit?.id || '')
  let canonicalKit
  try { canonicalKit = await realpath(kitRoot) } catch { throw new Error('Recovery kit does not match the authenticated handoff') }
  if (handoff.recoveryPoint !== recoveryArgs[1] || kitRoot !== resolve(kitRoot) || kitRoot !== canonicalKit || kitRoot !== expectedKit) {
    throw new Error('Recovery kit does not match the authenticated handoff')
  }
  await exactDirectory(join(stateRoot, 'recovery-tool'), 'Recovery tool directory')
  await exactDirectory(join(stateRoot, 'recovery-tool', 'kits'), 'Recovery kits directory')
  await exactDirectory(kitRoot, 'Recovery kit')
  const anchor = await verifyRecoveryAnchor(anchorPath, { platform, arch, platformTrust, executablePath, bootstrapPath, pythonPath, helperPath, verifiedAppImage })
  if (anchor.anchorPath !== boundAnchor.anchorPath) throw new Error('Recovery trust anchor changed during verification')
  const child = spawnImpl(pythonPath, ['-I', '-B', helperPath, '--launch-recovery-kit', kitRoot,
    handoff.recoveryKit.manifestSha256, platform, arch, JSON.stringify(recoveryArgs)], { stdio: 'inherit', windowsHide: true })
  await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? done() : reject(new Error('Recovery kit verification or execution failed')))
  })
  return { recovered: true }
}

async function main(args) {
  if (args[0] === '--recovery-anchor') {
    if (args.length !== 6) throw new Error('Usage: bootstrap.mjs --recovery-anchor <anchor> <kit> <state-root> <point-id> <library-directory>')
    await runRecoveryAnchor({ anchorPath: args[1], kitRoot: args[2], recoveryArgs: args.slice(3) })
    return
  }
  if (args.length < 4 || args.length > 5 || (args[4] && args[4] !== '--stable')) {
    throw new Error('Usage: bootstrap.mjs <state-root> <parent-pid> <python> <native-helper> [--stable]')
  }
  const [stateRoot, parent, pythonPath, helperPath, mode] = args
  const contract = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'))
  const ready = () => new Promise((done, reject) => process.stdout.write('READY\n', error => error ? reject(error) : done()))
  // Platform trust hooks intentionally fail closed until the release contract
  // carries an enabled signing policy. Metadata signatures still authenticate
  // every byte; these hooks additionally enforce the OS launch policy.
  const platformTrust = async ({ root, manifest }) => {
    if (process.platform === 'linux') return true
    const policy = contract.platformTrust?.[process.platform]
    if (!policy?.enabled) return false
    if (process.platform === 'darwin') {
      const app = manifest.entrypoint.split('/').slice(0, manifest.entrypoint.split('/').findIndex(part => part.endsWith('.app')) + 1)
      return new Promise(resolveTrust => {
        const child = spawn('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, ...app)], { stdio: 'ignore' })
        child.once('error', () => resolveTrust(false)); child.once('exit', code => resolveTrust(code === 0))
      })
    }
    // Windows Authenticode verification is supplied by the signed release's
    // native helper in the qualification step; absent that exact hook, close.
    return false
  }
  const runner = mode === '--stable' ? runStableBootstrap : runBootstrap
  await runner({ stateRoot, parentPid: Number(parent), contract, ready, platformTrust, pythonPath, helperPath })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Managed launcher failed: ${error.message}`); process.exitCode = 1 })
}
