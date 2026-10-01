// SPDX-License-Identifier: AGPL-3.0-only
// Test-only process observations. Only the retained ChildProcess may be signalled.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forceChild } from '../lifecycle.mjs'
const exec = promisify(execFile)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function parseDarwinProcessTable(stdout) {
  const rows = JSON.parse(stdout), seen = new Set()
  assert.ok(Array.isArray(rows) && rows.length > 0, 'Empty or invalid macOS process observation')
  for (const row of rows) {
    assert.ok(row && Number.isSafeInteger(row.pid) && row.pid > 0
      && Number.isSafeInteger(row.parent) && row.parent >= 0 && row.parent !== row.pid
      && typeof row.birth === 'string' && /^[1-9][0-9]*$/.test(row.birth)
      && !seen.has(row.pid), 'Malformed macOS process identity')
    seen.add(row.pid)
  }
  return rows
}

export async function processTable({ platform = process.platform, python, execImpl = exec } = {}) {
  if (platform === 'darwin') {
    assert.ok(typeof python === 'string' && isAbsolute(python), 'macOS observation requires the explicit bundled Python path')
    const { stdout } = await execImpl(python, ['-I', '-B', fileURLToPath(new URL('./packaged-smoke-processes.py', import.meta.url))],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return parseDarwinProcessTable(stdout)
  }
  if (platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="birth";e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}})'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    return JSON.parse(stdout).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, birth: row.birth }))
  }
  assert.equal(platform, 'linux', 'Unsupported process observation platform')
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return [{ pid: Number(name), parent: Number(fields[1]), birth: fields[19], state: fields[0] }]
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return []
      throw error
    }
  })
}

export function collectOwned(table, known) {
  const owned = table.filter(row => known.some(item => item.pid === row.pid && item.birth === row.birth))
  let added
  do {
    added = false
    for (const row of table) {
      if (!owned.includes(row) && owned.some(parent => parent.pid === row.parent && BigInt(row.birth) >= BigInt(parent.birth))) { owned.push(row); added = true }
    }
  } while (added)
  return owned
}

// A Linux zombie (state Z) has exited and holds no resources but its exit
// status; it is not "still running". Its parent has not reaped it yet.
export const isZombie = row => row.state === 'Z'
export const liveProcesses = rows => rows.filter(row => !isZombie(row))
const zombieProcesses = rows => rows.filter(isZombie)

// Pure mapping from a shutdown report to durable evidence. Process rows keep
// only {pid, parent}; birth values are ownership internals, not evidence.
// Zombies are listed separately and only when present.
// `forced` is true when the retained root was still running at failure, the
// only case in which closePackagedApplication signals it.
export function shutdownEvidence({ event, processes, zombies, error, closeSettled, exitCode, signalCode, cleanupErrors } = {}) {
  assert.equal(typeof event, 'string', 'Shutdown report requires an event')
  const entry = { event }
  if (Array.isArray(processes)) {
    entry.processCount = processes.length
    entry.processes = processes.map(({ pid, parent }) => ({ pid, parent }))
  }
  if (Array.isArray(zombies) && zombies.length) {
    entry.zombieCount = zombies.length
    entry.zombies = zombies.map(({ pid, parent }) => ({ pid, parent }))
  }
  if (error !== undefined) entry.error = String(error)
  for (const [key, value] of Object.entries({ closeSettled, exitCode, signalCode })) if (value !== undefined) entry[key] = value
  if (cleanupErrors !== undefined) entry.cleanupErrors = cleanupErrors.map(String)
  return { entry, forced: event === 'shutdown-failed' && exitCode === null && signalCode === null }
}

// Ownership is traced by parent lineage from the first observation (close
// time): the root and every process whose parent is owned and born no earlier.
// A descendant reparented before that first observation is not seen.
// No launch race: callers must await electron.launch's own timeout and retain
// the returned application before entering this function. `initiate` starts
// the shutdown (default: Playwright close). An application that is already
// quitting on its own passes a promise for its exit instead; it is observed
// to completion the same way and is never signalled unless it fails.
export async function closePackagedApplication(application, {
  timeout = 20000, table = processTable, report = () => {}, initiate = () => application.close(),
} = {}) {
  const child = application.process()
  let known = [], failure
  try {
    const initial = await table()
    const root = child.exitCode === null && child.signalCode === null && initial.find(row => row.pid === child.pid)
    if (root) known = collectOwned(initial, [root])
    else throw new Error('Cannot establish ownership of packaged application before shutdown')
    report({ event: 'before-close', processes: liveProcesses(known), zombies: zombieProcesses(known) })
  } catch (error) { failure = error }
  let settled = false, closeError
  // Rejection is consumed even if close settles after the deadline.
  void Promise.resolve().then(() => initiate()).then(
    () => { settled = true }, error => { settled = true; closeError = error },
  )
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && !failure) {
    try { known = collectOwned(await table(), known) } catch (error) { failure = error; break }
    if (settled && closeError) { failure = closeError; break }
    if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) {
      failure = new Error(`Packaged application exited abnormally (code=${child.exitCode}, signal=${child.signalCode})`)
      break
    }
    if (settled && liveProcesses(known).length === 0 && child.exitCode === 0 && child.signalCode === null) {
      report({ event: 'closed', processes: [], zombies: zombieProcesses(known) })
      return
    }
    await delay(100)
  }
  try { known = collectOwned(await table(), known) } catch (error) { failure ??= error }
  failure ??= new Error(`Packaged application did not shut down cleanly within ${timeout}ms`)
  report({ event: 'shutdown-failed', error: String(failure), closeSettled: settled, exitCode: child.exitCode, signalCode: child.signalCode,
    processes: liveProcesses(known), zombies: zombieProcesses(known) })
  // A process-table snapshot cannot safely authorize killing arbitrary PIDs.
  // Force only the retained live ChildProcess; descendants are diagnostic
  // evidence and may remain. Escalation always leaves this smoke test failed.
  const cleanupErrors = []
  try { forceChild(child) } catch (error) { cleanupErrors.push(String(error)) }
  await delay(250)
  try {
    const after = collectOwned(await table(), known)
    report({ event: 'after-forced-cleanup', processes: liveProcesses(after), zombies: zombieProcesses(after), cleanupErrors })
  }
  catch (error) { report({ event: 'cleanup-inspection-failed', error: String(error), cleanupErrors }) }
  throw failure
}
