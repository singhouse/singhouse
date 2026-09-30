// SPDX-License-Identifier: AGPL-3.0-only
// node desktop/test/appimage-native-smoke.mjs --appimage /absolute/image.AppImage --output /absolute/new-directory
// Primitive native evidence only: no updater enablement or end-to-end recovery claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, createReadStream, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function identity(path) {
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Expected a regular non-symlink file')
  return { path, dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}
// detached creates a private Linux session/process group; signals never target the caller's group.
export function supervise(command, args, { env, cwd, timeoutMs = 180000, maxOutputBytes = 8 * 1024 * 1024,
  termGraceMs = 1000, killGraceMs = 1000 } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = { stdout: [], stderr: [] }, signals = []
    let bytes = 0, status = null, signal = null, error, exited = false, closed = false, stopping = false, done = false
    let deadline, escalation, finalDeadline, poll
    const groupExists = () => {
      if (!child.pid) return false
      try { process.kill(-child.pid, 0); return true } catch (failure) {
        if (failure.code === 'ESRCH') return false
        error ||= new Error(`Cannot inspect owned process group: ${failure.message}`)
        return true
      }
    }
    const send = selected => {
      if (!child.pid) return
      try { process.kill(-child.pid, selected); signals.push(selected) } catch (failure) {
        if (failure.code !== 'ESRCH') error ||= new Error(`Cannot signal owned process group: ${failure.message}`)
      }
    }
    const finish = () => {
      if (done) return
      done = true
      for (const timer of [deadline, escalation, finalDeadline]) clearTimeout(timer)
      clearInterval(poll)
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', terminated)
      const groupRemaining = groupExists()
      if (groupRemaining || (child.pid && !exited)) error ||= new Error('Owned process group did not exit within cleanup deadline')
      // Bound even a kernel-stuck child or inherited pipe. Keep evidence and fail; never wait indefinitely.
      child.stdout.destroy(); child.stderr.destroy(); child.unref()
      resolveResult({ status, signal, error, exited, closed, groupRemaining, signals,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') })
    }
    const stop = reason => {
      error ||= new Error(reason)
      if (stopping || done) return
      stopping = true
      clearTimeout(deadline)
      send('SIGTERM')
      escalation = setTimeout(() => {
        send('SIGKILL')
        finalDeadline = setTimeout(finish, killGraceMs)
      }, termGraceMs)
      poll = setInterval(() => { if (exited && !groupExists()) finish() }, 25)
    }
    const interrupted = () => stop('Supervisor interrupted by SIGINT')
    const terminated = () => stop('Supervisor interrupted by SIGTERM')
    process.on('SIGINT', interrupted); process.on('SIGTERM', terminated)
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      const available = Math.max(0, maxOutputBytes - bytes)
      if (available) chunks[name].push(chunk.subarray(0, available))
      bytes += chunk.length
      if (bytes > maxOutputBytes) stop('Child output exceeded capture limit')
    })
    child.once('error', failure => {
      error = failure
      if (!child.pid) finish()
      else stop(`Child process error: ${failure.message}`)
    })
    child.once('exit', (code, selected) => {
      status = code; signal = selected; exited = true
      // Descendants can retain pipes after the leader exits. The main deadline still applies.
      if (stopping && !groupExists()) finish()
    })
    child.once('close', () => {
      closed = true
      if (done) return
      if (stopping) { if (!groupExists()) finish() }
      else if (groupExists()) stop('Child exited with descendants still in its owned process group')
      else finish()
    })
    deadline = setTimeout(() => stop('Child exceeded execution timeout'), timeoutMs)
  })
}

async function main() {
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  assert.ok(['--appimage', '--output'].includes(key) && !options[key] && process.argv[i + 1], 'Use --appimage PATH --output NEW_DIRECTORY')
  options[key] = process.argv[i + 1]
}
assert.equal(process.platform, 'linux')
for (const key of ['--appimage', '--output']) assert.ok(isAbsolute(options[key] || ''), `${key} must be absolute`)
const source = options['--appimage'], output = options['--output']
assert.equal(source, realpathSync(source), 'AppImage must use its canonical path')
assert.equal(output, resolve(output), 'Output must use its canonical path')
assert.equal(dirname(output), realpathSync(dirname(output)), 'Output parent must be canonical and exist')
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputRelative = relative(checkout, output)
assert.ok(outputRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(outputRelative), 'Output must be outside the source checkout')
const before = identity(source), originalSha256 = await digest(source)
assert.deepEqual(identity(source), before, 'Input changed during hashing')
// Exclusive creation prevents reusing, following, or cleaning up someone else's output.
mkdirSync(output, { mode: 0o700 })
const copied = join(output, 'Singhouse.AppImage')
copyFileSync(source, copied, 1); chmodSync(copied, 0o700)
assert.equal(await digest(copied), originalSha256)
assert.deepEqual(identity(source), before, 'Input changed during copying')
const profile = join(output, 'profile')
mkdirSync(profile, { mode: 0o700 })
for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(profile, name), { mode: 0o700 })
const childScript = join(output, 'appimage-native-child.mjs')
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'appimage-native-child.mjs'), childScript, 1)
const requestPath = join(output, 'request.json')
writeFileSync(requestPath, JSON.stringify({ output, copied, originalSha256 }), { flag: 'wx', mode: 0o600 })
const env = { ...process.env, HOME: profile, XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'),
  XDG_DATA_HOME: join(profile, 'data'), TMPDIR: join(profile, 'tmp'), ELECTRON_RUN_AS_NODE: '1' }
for (const key of Object.keys(env)) {
  if (/^(APPIMAGE|APPDIR|ARGV0|OWD|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|SINGHOUSE_|KARAOKE_)/.test(key) || key === 'ELECTRON_NO_ASAR') delete env[key]
}
// No extraction fallback, sandbox-disabling switch, application startup, or updater invocation.
const result = await supervise(copied, [childScript, requestPath], { env, cwd: profile })
writeFileSync(join(output, 'stdout.log'), result.stdout || '', { flag: 'wx', mode: 0o600 })
writeFileSync(join(output, 'stderr.log'), result.stderr || '', { flag: 'wx', mode: 0o600 })
const report = { schema: 1, scope: 'native AppImage runtime and anchor primitives; not publisher trust, updater or full recovery qualification',
  original: { ...before, sha256: originalSha256 }, copy: { ...identity(copied), sha256: await digest(copied) },
  child: { status: result.status, signal: result.signal, error: result.error?.message, exited: result.exited,
    closed: result.closed, groupRemaining: result.groupRemaining, cleanupSignals: result.signals }, passed: false,
  artifactsRetained: true }
try {
  assert.deepEqual(identity(source), before, 'Original input identity changed')
  assert.equal(await digest(source), originalSha256, 'Original input bytes changed')
  assert.equal(report.copy.sha256, originalSha256, 'Private image copy changed')
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, 'Native child failed; see stderr.log and child-result.json (no synthetic fallback)')
  report.evidence = JSON.parse(readFileSync(join(output, 'child-result.json'), 'utf8'))
  assert.equal(report.evidence.passed, true)
  report.passed = true
} catch (error) { report.failure = error.stack; process.exitCode = 1 }
writeFileSync(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${join(output, 'result.json')}`)
// All output is retained intentionally. No recursive cleanup, shared profile, or input mutation.

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
