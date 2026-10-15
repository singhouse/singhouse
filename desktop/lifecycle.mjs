// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'karaoke-desktop-'))
  const backend = join(root, 'backend')
  const electron = join(root, 'electron')
  try {
    mkdirSync(backend, { mode: 0o700 })
    mkdirSync(electron, { mode: 0o700 })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  // This closure can delete only the path this process created, never a
  // child-provided path. The child owns the backend subtree during its life.
  return { root, backend, electron, remove: () => rmSync(root, { recursive: true, force: true }) }
}

export function persistentRuntime(userData) {
  const backend = join(userData, 'backend')
  mkdirSync(backend, { recursive: true, mode: 0o700 })
  return { root: userData, backend, electron: userData, remove() {} }
}

// Backend arguments for the verified stores. The install root lets the backend
// check that each selected pack lives in that root's own store.
export function processingLaunchArguments({ installRoot, processing, probe, models } = {}) {
  const args = []
  if (installRoot) args.push('--processing-root', installRoot)
  if (processing) args.push('--processing', processing.directory, '--processing-id', processing.id)
  if (probe) args.push('--processing-probe', JSON.stringify(probe))
  if (models) args.push('--models', models.directory, '--models-id', models.id)
  return args
}

export function projectorBlocker(power) {
  let id = null
  return {
    start() { if (id === null) id = power.start('prevent-display-sleep') },
    stop() { if (id !== null) { power.stop(id); id = null } },
  }
}

export function watchOwnedGroup(child) {
  // Install immediately after detached spawn, before UI/startup exit handlers.
  // Consume the group ID on the first kill, including ESRCH: never retain an
  // exited process's group ID for a later shutdown or PID-reuse window.
  let groupId = child.pid
  child.killOwnedGroup = () => {
    if (!groupId) return
    const owned = groupId
    groupId = null
    try { process.kill(-owned, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') child.treeCleanupError = error }
    if (child.treeCleanupError) throw child.treeCleanupError
  }
  child.once('exit', () => {
    try { child.killOwnedGroup() }
    catch { /* The shutdown promise reports this stored cleanup failure. */ }
  })
}

export function forceChild(child) {
  if (child?.killOwnedGroup) child.killOwnedGroup()
  else if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export function stopChild(child, timeout = 5000) {
  // Failed spawn has no PID and never emits exit. Do not wait on that event.
  if (child?.treeCleanupError) return Promise.reject(child.treeCleanupError)
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let escalation, deadline, settled = false
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(escalation)
      clearTimeout(deadline)
      child.off('exit', onExit)
      child.off('error', onError)
      child.stdin?.off?.('error', onPipeError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish(child.treeCleanupError)
    const onError = error => finish(error)
    // A pipe can close concurrently with exit; escalation still owns cleanup.
    const onPipeError = () => {}
    child.once('exit', onExit)
    child.once('error', onError)
    child.stdin?.on?.('error', onPipeError)
    escalation = setTimeout(() => {
      try {
        forceChild(child)
      } catch (error) {
        if (error.code !== 'ESRCH') { finish(error); return }
      }
      if (!settled) deadline = setTimeout(() => finish(new Error('Owned backend did not exit after forced shutdown')), timeout)
    }, timeout)
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end()
      else child.kill('SIGTERM')
    } catch (error) { finish(error) }
  })
}

export async function stopRuntime(child, runtime, timeout = 5000) {
  await stopChild(child, timeout)
  runtime.remove()
}
