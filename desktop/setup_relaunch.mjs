// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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

export function relaunchForSetup(app, options) {
  // All selection/verification must succeed before quitting, so the caller's
  // restartForSetup catch can resume the backend on a rejected relaunch.
  app.relaunch(setupRelaunchOptions(options))
  app.quit()
}
