// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readOnlyAppImageMount, stableFirstInstallerExecutable } from './recovery_launcher.mjs'


// Setup restarts may use the Type-2 runtime's daemonized FUSE keeper. This
// grants no recovery/update authority: those callers retain ancestor evidence.
export function verifiedSetupAppImageRuntime({ platform = process.platform, executablePath = process.execPath, procRoot = '/proc' } = {}) {
  const mount = readOnlyAppImageMount({ platform, executablePath, procRoot })
  if (!mount) throw new Error('Setup restart requires a verified AppImage mount')
  const self = join(procRoot, 'self')
  const mountLine = readFileSync(join(self, 'mountinfo'), 'utf8').split('\n').find(line => {
    const parts = line.split(' ')
    return parts[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === mount.mountPath
  })
  const [mountId, , device] = (mountLine || '').split(' ')
  if (!/^0:\d+$/.test(device || '')) throw new Error('AppImage FUSE connection is unavailable')
  const connection = device.slice(2)
  const descriptors = directory => readdirSync(join(directory, 'fd')).filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const path = join(directory, 'fd', name), info = readFileSync(join(directory, 'fdinfo', name), 'utf8')
      const field = key => new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(info)?.[1]
      return [{ path, target: readlinkSync(path), mode: parseInt(field('flags'), 8) & 3,
        mountId: field('mnt_id'), connection: field('fuse_connection') }]
    } catch { return [] }
  })
  const own = descriptors(self)
  const rootFd = own.find(fd => fd.target === mount.mountPath && fd.mountId === mountId)
  const readers = own.filter(fd => /^pipe:\[\d+\]$/.test(fd.target) && fd.mode === 0)
  if (!rootFd || !statSync(rootFd.path).isDirectory() || !readers.length) throw new Error('AppImage runtime descriptors are unavailable')
  const owner = statSync(self).uid
  for (const pid of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    let descriptor
    try {
      const directory = join(procRoot, pid)
      if (statSync(directory).uid !== owner) continue
      const fds = descriptors(directory)
      const fuse = fds.find(fd => fd.target === '/dev/fuse' && fd.connection === connection)
      const writer = fds.find(fd => fd.mode === 1 && readers.some(reader => reader.target === fd.target))
      if (!fuse || !writer) continue
      const reader = readers.find(fd => fd.target === writer.target)
      const procExe = join(directory, 'exe'), outerPath = realpathSync(procExe)
      const outerFd = fds.find(fd => fd.target === outerPath && fd.mode === 0)
      if (!outerFd || realpathSync(outerPath) !== outerPath) continue
      descriptor = openSync(outerFd.path, 'r')
      const before = fstatSync(descriptor), executable = statSync(procExe), named = statSync(outerPath)
      if (!before.isFile() || [executable, named].some(info => info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)) continue
      const header = Buffer.alloc(11)
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length || header.subarray(0, 4).toString('hex') !== '7f454c46'
          || header.subarray(8, 11).toString('hex') !== '414902') continue
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
      let offset = 0, count
      while ((count = readSync(descriptor, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0, count)); offset += count }
      const after = fstatSync(descriptor)
      if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
          || realpathSync(procExe) !== outerPath || realpathSync(outerPath) !== outerPath
          || readlinkSync(outerFd.path) !== outerPath || readlinkSync(reader.path) !== reader.target
          || readlinkSync(writer.path) !== writer.target || readlinkSync(rootFd.path) !== mount.mountPath
          || !descriptors(directory).some(fd => fd.path === fuse.path && fd.target === '/dev/fuse' && fd.connection === connection)) continue
      const currentMount = readOnlyAppImageMount({ platform, executablePath, procRoot })
      if (currentMount?.mountPath !== mount.mountPath || currentMount.actualExecutablePath !== mount.actualExecutablePath) continue
      return { verified: true, outerPath, outerSha256: hash.digest('hex'), mountPath: mount.mountPath, actualExecutablePath: mount.actualExecutablePath }
    } catch { /* Processes and descriptors may disappear during enumeration. */ }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  throw new Error('The running AppImage has no authenticated runtime keeper')
}

// A mounted AppImage's inner executable can disappear when the old process
// exits. Relaunch its authenticated outer image, retaining the exact arguments
// (including an isolated user-data-dir). Ambient APPIMAGE/APPDIR are not inputs.
export function setupRelaunchOptions({ platform = process.platform, executablePath = process.execPath,
  args = process.argv.slice(1), detectMount = readOnlyAppImageMount, verifyImage = verifiedSetupAppImageRuntime } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Invalid setup relaunch arguments')
  }
  let execPath = executablePath
  if (platform === 'linux' && detectMount({ platform, executablePath })) {
    const verifiedAppImage = verifyImage({ platform, executablePath })
    execPath = stableFirstInstallerExecutable({ platform, executablePath, verifiedAppImage })
  }
  return { execPath, args: [...args] }
}

// No code or executable is loaded from the disappearing AppImage mount after
// shutdown. Positional arguments preserve the authenticated path and argv.
const handoffScript = `set -eu
set -f
parent=$1
expected=$2
shift 2
printf 'READY\\n' >&3
exec 3>&-
IFS= read -r armed
[ "$armed" = ARM ] || exit 70
# Any extra input cancels. Only the owning parent's descriptor closing arms EOF.
if IFS= read -r cancelled; then exit 70; fi
tries=0
while [ -r "/proc/$parent/stat" ]; do
  IFS= read -r record 2>/dev/null < "/proc/$parent/stat" || break
  rest=\${record##*) }
  index=0
  current=
  state=
  for field in $rest; do
    index=$((index + 1))
    if [ "$index" -eq 1 ]; then state=$field; fi
    if [ "$index" -eq 20 ]; then current=$field; break; fi
  done
  [ "$current" = "$expected" ] || break
  # A zombie has exited; waiting for its launcher to reap it can hang forever.
  case "$state" in Z|X) break ;; esac
  tries=$((tries + 1))
  [ "$tries" -lt 1200 ] || exit 71
  /bin/sleep 0.1
done
exec "$@"
`

export async function prepareAppImageHandoff({ execPath, args }, { signal, readinessTimeout = 5000, shutdownTimeout = 120000 } = {}) {
  signal?.throwIfAborted()
  const stat = readFileSync('/proc/self/stat', 'utf8')
  const startTime = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]
  if (!/^\d+$/.test(startTime || '')) throw new Error('Restart process identity is unavailable')
  const helper = spawn('/bin/sh', ['-c', handoffScript, 'singhouse-restart', String(process.pid), startTime, execPath, ...args],
    { detached: true, cwd: '/', stdio: ['pipe', 'inherit', 'inherit', 'pipe'] })
  let exited = false, failure, rejectReady, readinessTimer, shutdownTimer
  const cancel = () => {
    failure ??= signal?.reason || new Error('Application restart handoff cancelled')
    if (!exited) helper.kill('SIGKILL')
    rejectReady?.(failure)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const cleanup = () => {
    clearTimeout(readinessTimer); clearTimeout(shutdownTimer)
    signal?.removeEventListener('abort', cancel)
  }
  helper.once('exit', () => { exited = true; cleanup(); rejectReady?.(new Error('Application restart helper stopped before readiness')) })
  helper.on('error', error => { failure = error; cleanup(); rejectReady?.(error) })
  helper.stdin.on('error', error => { failure = error; cancel() })
  try {
    await new Promise((resolve, reject) => {
      rejectReady = reject
      let received = ''
      readinessTimer = setTimeout(() => { failure = new Error('Application restart helper readiness timed out'); cancel() }, readinessTimeout)
      helper.stdio[3].on('data', chunk => {
        received += chunk.toString()
        if (received.length > 6 || !'READY\n'.startsWith(received)) {
          failure = new Error('Invalid application restart helper acknowledgement'); cancel(); return
        }
        if (received === 'READY\n') resolve()
      })
      if (signal?.aborted) cancel()
    })
    clearTimeout(readinessTimer)
    if (failure || exited) throw failure || new Error('Application restart helper stopped')
    await new Promise((resolve, reject) => helper.stdin.write('ARM\n', error => error ? reject(error) : resolve()))
    if (failure || signal?.aborted) throw failure || signal.reason
    rejectReady = null
    // If normal shutdown stalls while this process lives, cancel the handoff.
    // After process exit the helper's own bounded identity wait takes over.
    shutdownTimer = setTimeout(cancel, shutdownTimeout)
    shutdownTimer.unref()
    helper.unref()
    helper.stdin.unref()
    helper.stdio[3].unref()
    return { cancel }
  } catch (error) { cancel(); cleanup(); throw error }
}

export async function relaunchForSetup(app, options = {}) {
  const selected = setupRelaunchOptions(options)
  const platform = options.platform ?? process.platform
  if (platform === 'linux' && selected.execPath !== (options.executablePath ?? process.execPath)) {
    const handoff = await prepareAppImageHandoff(selected)
    try { app.quit() } catch (error) { handoff.cancel(); throw error }
  } else {
    if (app.relaunch(selected) === false) throw new Error('The application could not schedule a restart. Please try again.')
    app.quit()
  }
}
