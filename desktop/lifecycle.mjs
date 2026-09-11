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

export function projectorBlocker(power) {
  let id = null
  return {
    start() { if (id === null) id = power.start('prevent-display-sleep') },
    stop() { if (id !== null) { power.stop(id); id = null } },
  }
}

export function stopChild(child, timeout = 5000) {
  // Failed spawn has no PID and never emits exit. Do not wait on that event.
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

export async function stopRuntime(child, runtime, timeout = 5000) {
  await stopChild(child, timeout)
  runtime.remove()
}
