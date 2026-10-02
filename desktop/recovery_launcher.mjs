// SPDX-License-Identifier: AGPL-3.0-only
// This module is copied into the per-user recovery directory.  It deliberately
// has no Electron dependency, so a broken target application cannot prevent a
// rollback.
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function recoveredLaunchEnvironment(source = process.env) {
  const environment = { ...source }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.SINGHOUSE_RECOVERY_KIT
  return environment
}
function exactJSON(value) {
  if (Array.isArray(value)) return `[${value.map(exactJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${exactJSON(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function cmdQuotedLiteral(value) {
  if (typeof value !== 'string' || /["\r\n]/.test(value)) throw new Error('Recovery launcher path is not safe for a Windows command file')
  return `"${value.replaceAll('%', '%%')}"`
}

export function trustedSourceFileMetadata(info, { requireOwner = true, currentUid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  return currentUid === null || ((!requireOwner || info.uid === currentUid) && !(info.mode & 0o022))
}

function safeFile(path, label, { required = true, source = false, requireOwner = true } = {}) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  let info
  try { info = lstatSync(path) } catch (error) {
    if (!required && error.code === 'ENOENT') return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`)
  if (typeof process.getuid === 'function' && (source ? !trustedSourceFileMetadata(info, { requireOwner }) : info.uid !== process.getuid() || info.mode & 0o077)) {
    throw new Error(`${label} must be private and owned by the current user`)
  }
  return info
}

function safeDirectory(path, label, { source = false, requireOwner = true } = {}) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a non-symlink directory`)
  if (typeof process.getuid === 'function' && ((requireOwner && info.uid !== process.getuid()) || info.mode & (source ? 0o022 : 0o077))) {
    throw new Error(`${label} must be private and owned by the current user`)
  }
  return info
}

function canonicalFile(path, label, { requireOwner = true } = {}) {
  if (!isAbsolute(path || '') || path !== resolve(path)) throw new Error(`${label} must use its exact canonical path`)
  let canonical
  try { canonical = realpathSync(path) } catch { throw new Error(`${label} must use its exact canonical path`) }
  if (canonical !== path) throw new Error(`${label} must use its exact canonical path`)
  safeFile(path, label, { source: true, requireOwner })
  return path
}

function mountedFile(path, label, mount) {
  if (!isAbsolute(path || '') || path !== resolve(path)) throw new Error(`${label} must use its exact canonical path`)
  let target
  try { target = realpathSync(path) } catch { throw new Error(`${label} must stay inside the verified AppImage mount`) }
  const rel = relative(mount, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} must stay inside the verified AppImage mount`)
  safeFile(target, label, { source: true, requireOwner: false })
  return target
}

const APPIMAGE_LAYOUT = Object.freeze({
  actualExecutablePath: 'Singhouse',
  bootstrapPath: 'resources/app.asar/bootstrap.mjs',
  pythonPath: 'resources/native/python/bin/python3',
  helperPath: 'resources/native/backend.py',
})

function procMountValue(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function appImageMount(mountInfo, executablePath) {
  const matches = []
  for (const line of mountInfo.split('\n')) {
    if (!line) continue
    const separator = line.indexOf(' - ')
    if (separator < 0) continue
    const before = line.slice(0, separator).split(' '), after = line.slice(separator + 3).split(' ')
    if (before.length < 6 || after.length < 3) continue
    const mountPath = procMountValue(before[4]), options = before[5].split(','), filesystem = after[0]
    const rel = relative(mountPath, executablePath)
    if ((rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) && /^fuse(?:\.|$)/.test(filesystem) && options.includes('ro')) {
      matches.push({ mountPath, filesystem })
    }
  }
  matches.sort((left, right) => right.mountPath.length - left.mountPath.length)
  return matches[0] || null
}

function procParent(stat) {
  const end = stat.lastIndexOf(')')
  if (end < 0) throw new Error('Invalid Linux process ancestry')
  const fields = stat.slice(end + 1).trim().split(/\s+/)
  if (!/^\d+$/.test(fields[1] || '')) throw new Error('Invalid Linux process ancestry')
  return fields[1]
}

function appImageHeader(bytes) {
  return bytes.length >= 11 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString() === 'ELF' &&
    bytes[8] === 0x41 && bytes[9] === 0x49 && bytes[10] === 0x02
}

function ancestorImageBytes(procExecutable, outerPath) {
  let ancestor, path
  try {
    ancestor = openSync(procExecutable, 'r')
    path = openSync(outerPath, 'r')
    const before = fstatSync(ancestor), found = fstatSync(path)
    if (before.dev !== found.dev || before.ino !== found.ino || before.size !== found.size) {
      throw new Error('Outer AppImage path does not name the running ancestor image')
    }
    const bytes = readFileSync(ancestor), after = fstatSync(ancestor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Outer AppImage changed while it was authenticated')
    }
    return bytes
  } finally {
    if (path !== undefined) closeSync(path)
    if (ancestor !== undefined) closeSync(ancestor)
  }
}

// Bind the running Electron executable to the immutable outer AppImage using
// kernel-owned process ancestry and mount-table evidence. APPIMAGE and APPDIR
// are deliberately not consulted: either can be replaced by the caller.
export function verifiedAppImageRuntime({ platform = process.platform, executablePath = process.execPath,
  procRoot = '/proc', maximumAncestors = 64 } = {}) {
  if (platform !== 'linux') return null
  let actualExecutablePath, selfExecutable
  try {
    actualExecutablePath = realpathSync(executablePath)
    selfExecutable = realpathSync(join(procRoot, 'self', 'exe'))
  } catch { throw new Error('AppImage runtime evidence is unavailable') }
  if (executablePath !== resolve(executablePath) || actualExecutablePath !== executablePath || selfExecutable !== actualExecutablePath) {
    throw new Error('AppImage runtime executable is not canonical')
  }
  // AppImageKit's `-all-root` SquashFS contents are root-owned even when an
  // ordinary desktop user mounts and launches the image. The read-only FUSE
  // mount and authenticated outer-image ancestry provide ownership here.
  canonicalFile(actualExecutablePath, 'AppImage runtime executable', { requireOwner: false })
  let mount
  try { mount = appImageMount(readFileSync(join(procRoot, 'self', 'mountinfo'), 'utf8'), actualExecutablePath) } catch {}
  if (!mount || mount.mountPath !== dirname(actualExecutablePath) || basename(actualExecutablePath) !== APPIMAGE_LAYOUT.actualExecutablePath) {
    throw new Error('AppImage runtime is not executing from its read-only FUSE root')
  }
  let pid
  try { pid = procParent(readFileSync(join(procRoot, 'self', 'stat'), 'utf8')) } catch {
    throw new Error('AppImage runtime ancestry is unavailable')
  }
  const visited = new Set()
  for (let depth = 0; depth < maximumAncestors && pid !== '0' && !visited.has(pid); depth += 1) {
    visited.add(pid)
    const procExecutable = join(procRoot, pid, 'exe')
    let outerPath
    try { outerPath = realpathSync(procExecutable) } catch { outerPath = null }
    if (outerPath && outerPath !== actualExecutablePath) {
      try {
        canonicalFile(outerPath, 'Outer AppImage')
        const bytes = ancestorImageBytes(procExecutable, outerPath)
        if (appImageHeader(bytes)) {
          const outerSha256 = sha256(bytes)
          if (realpathSync(procExecutable) !== outerPath || realpathSync(outerPath) !== outerPath) {
            throw new Error('Outer AppImage changed while it was authenticated')
          }
          return { verified: true, outerPath, outerSha256, mountPath: mount.mountPath, actualExecutablePath }
        }
      } catch (error) {
        if (error.message === 'Outer AppImage changed while it was authenticated') throw error
      }
    }
    try { pid = procParent(readFileSync(join(procRoot, pid, 'stat'), 'utf8')) } catch { break }
  }
  throw new Error('The running AppImage has no authenticated outer-image ancestor')
}

export function exactComponentLayout(platform, paths, verifiedAppImage = null) {
  if (platform === 'linux') {
    const outer = stableFirstInstallerExecutable({ platform, executablePath: verifiedAppImage?.actualExecutablePath,
      verifiedAppImage })
    canonicalFile(paths.executablePath, 'Recovery anchor executablePath')
    for (const name of ['bootstrapPath', 'pythonPath', 'helperPath']) {
      mountedFile(paths[name], `Recovery anchor ${name}`, verifiedAppImage.mountPath)
    }
    if (paths.executablePath !== outer) throw new Error('Recovery anchor executable does not match the verified outer AppImage')
    const mount = verifiedAppImage.mountPath
    for (const [name, logical] of Object.entries(APPIMAGE_LAYOUT)) {
      const actual = name === 'actualExecutablePath' ? verifiedAppImage.actualExecutablePath : paths[name]
      if (actual !== join(mount, ...logical.split('/'))) throw new Error(`Recovery anchor ${name} does not match the AppImage component layout`)
    }
    return { kind: 'appimage-v1', ...APPIMAGE_LAYOUT }
  }
  for (const [name, path] of Object.entries(paths)) canonicalFile(path, `Recovery anchor ${name}`)
  let expected
  if (platform === 'win32') {
    const root = dirname(paths.executablePath)
    expected = { executablePath: join(root, 'Singhouse.exe'), bootstrapPath: join(root, 'resources', 'app.asar', 'bootstrap.mjs'),
      pythonPath: join(root, 'resources', 'native', 'python', 'python.exe'), helperPath: join(root, 'resources', 'native', 'backend.py') }
  } else {
    const marker = `${sep}Singhouse.app${sep}Contents${sep}MacOS${sep}Singhouse`
    if (!paths.executablePath.endsWith(marker)) throw new Error('Recovery anchor executable does not match the application component layout')
    const bundle = paths.executablePath.slice(0, -`${sep}Contents${sep}MacOS${sep}Singhouse`.length)
    expected = { executablePath: join(bundle, 'Contents', 'MacOS', 'Singhouse'), bootstrapPath: join(bundle, 'Contents', 'Resources', 'app.asar', 'bootstrap.mjs'),
      pythonPath: join(bundle, 'Contents', 'Resources', 'native', 'python', 'bin', 'python3'), helperPath: join(bundle, 'Contents', 'Resources', 'native', 'backend.py') }
  }
  if (!Object.keys(paths).every(name => paths[name] === expected[name])) throw new Error('Recovery anchor components do not match the application component layout')
  return { kind: 'fixed-v1', ...expected }
}

function inside(path, root) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function safeEntrypoint(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 1024 && !isAbsolute(value) && !value.includes('\\') &&
    value.split('/').every(part => /^[A-Za-z0-9._+() -]+$/.test(part) && !['', '.', '..'].includes(part))
}

function syncDirectory(path) {
  let descriptor
  try { descriptor = openSync(path, 'r') } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) return
    throw error
  }
  try { fsyncSync(descriptor) } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally { closeSync(descriptor) }
}
function syncTreeDirectories(path) {
  for (const name of readdirSync(path)) {
    const child = resolve(path, name), info = lstatSync(child)
    if (info.isDirectory() && !info.isSymbolicLink()) syncTreeDirectories(child)
  }
  syncDirectory(path)
}

export function atomicJSON(path, value) {
  if (!isAbsolute(path)) throw new Error('Recovery state path must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  safeFile(path, 'Recovery state', { required: false })
  const temporary = `${path}.new-${process.pid}`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  renameSync(temporary, path)
  syncDirectory(dirname(path))
}

export function recoveryAnchorRecord({ executablePath, bootstrapPath, pythonPath, helperPath,
  platform = process.platform, arch = process.arch, stateRoot, anchorPath, verifiedAppImage = null }) {
  const paths = { executablePath, bootstrapPath, pythonPath, helperPath }
  if (!['linux', 'win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch) ||
      (platform === 'win32' && arch !== 'x64') || (platform === 'darwin' && arch !== 'arm64')) {
    throw new Error('Invalid recovery anchor target')
  }
  if (!isAbsolute(stateRoot || '') || !isAbsolute(anchorPath || '') ||
      stateRoot !== resolve(stateRoot) || anchorPath !== resolve(anchorPath) ||
      anchorPath !== join(stateRoot, 'recovery-tool', 'anchor.json')) {
    throw new Error('Invalid recovery anchor state root or path')
  }
  const componentLayout = exactComponentLayout(platform, paths, verifiedAppImage)
  const canonicalAnchor = resolve(anchorPath)
  const componentDigests = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, sha256(readFileSync(path))]))
  if (platform === 'linux') componentDigests.actualExecutablePath = sha256(readFileSync(verifiedAppImage.actualExecutablePath))
  return { schema: 3, kind: 'recovery-anchor', platform, arch, executablePath,
    stateRoot: resolve(stateRoot), anchorPath: canonicalAnchor, componentLayout,
    digests: { ...componentDigests,
      anchorPath: sha256(Buffer.from(canonicalAnchor)) } }
}

function recoveryAnchorInvocation(anchorPath, anchor) {
  const quotedAnchor = anchorPath.replaceAll("'", "'\\''"), quotedExecutable = anchor.executablePath.replaceAll("'", "'\\''")
  if (anchor.platform === 'win32') {
    const cmdAnchor = cmdQuotedLiteral(anchorPath), cmdExecutable = cmdQuotedLiteral(anchor.executablePath)
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not exist ${cmdExecutable} goto missing\r\nif not exist ${cmdAnchor} goto missing\r\nset ELECTRON_RUN_AS_NODE=\r\nset SINGHOUSE_RECOVERY_ANCHOR=1\r\n${cmdExecutable} --recovery-anchor ${cmdAnchor} %*\r\nexit /b %errorlevel%\r\n:missing\r\necho Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery. 1>&2\r\nexit /b 1\r\n`
  }
  return `#!/bin/sh\nset -eu\nANCHOR='${quotedAnchor}'\nEXECUTABLE='${quotedExecutable}'\nif [ ! -f "$EXECUTABLE" ] || [ ! -f "$ANCHOR" ]; then\n  echo 'Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery.' >&2\n  exit 1\nfi\nunset ELECTRON_RUN_AS_NODE\nexport SINGHOUSE_RECOVERY_ANCHOR=1\nexec "$EXECUTABLE" --recovery-anchor "$ANCHOR" "$@"\n`
}

export function recoveryAnchorInvocationPath(anchorPath, platform) {
  return resolve(dirname(anchorPath), platform === 'win32' ? 'invoke.cmd' : 'invoke.sh')
}

export function stableFirstInstallerExecutable({ platform = process.platform, environment = process.env,
  executablePath = process.execPath, verifiedAppImage = null } = {}) {
  if (platform === 'linux') {
    // APPIMAGE and APPDIR are ordinary process environment variables. They
    // are diagnostic hints only. The injected native evidence is the sole
    // positive seam and binds the outer bytes, mount and actual executable.
    if (verifiedAppImage?.verified !== true || !isAbsolute(verifiedAppImage.outerPath || '') ||
        !isAbsolute(verifiedAppImage.mountPath || '') || !isAbsolute(verifiedAppImage.actualExecutablePath || '') ||
        !/^[a-f0-9]{64}$/.test(verifiedAppImage.outerSha256 || '')) {
      throw new Error('AppImage recovery anchor requires explicit verified outer-image and mount evidence')
    }
    let outer, mount, actual, current
    try {
      outer = realpathSync(verifiedAppImage.outerPath)
      mount = realpathSync(verifiedAppImage.mountPath)
      actual = realpathSync(verifiedAppImage.actualExecutablePath)
      current = realpathSync(executablePath)
    } catch {
      throw new Error('AppImage recovery anchor requires canonical verified outer-image and mount evidence')
    }
    if (verifiedAppImage.outerPath !== resolve(verifiedAppImage.outerPath) ||
        verifiedAppImage.mountPath !== resolve(verifiedAppImage.mountPath) ||
        verifiedAppImage.actualExecutablePath !== resolve(verifiedAppImage.actualExecutablePath) ||
        resolve(verifiedAppImage.outerPath) !== outer || resolve(verifiedAppImage.mountPath) !== mount ||
        resolve(verifiedAppImage.actualExecutablePath) !== actual || actual !== current) {
      throw new Error('AppImage recovery anchor requires canonical verified outer-image and mount evidence')
    }
    safeFile(outer, 'Verified outer AppImage', { source: true })
    safeDirectory(mount, 'Verified AppImage mount', { source: true, requireOwner: false })
    safeFile(actual, 'Verified AppImage executable', { source: true, requireOwner: false })
    const mountedRelative = relative(mount, actual)
    if (!mountedRelative || mountedRelative.startsWith('..') || isAbsolute(mountedRelative)) {
      throw new Error('AppImage recovery anchor requires explicit verified outer-image and mount evidence')
    }
    if (sha256(readFileSync(outer)) !== verifiedAppImage.outerSha256) {
      throw new Error('Verified outer AppImage bytes changed')
    }
    return outer
  }
  if (!isAbsolute(executablePath)) throw new Error('Stable first-installer executable path must be absolute')
  return resolve(executablePath)
}

export function ensureRecoveryAnchor(path, expected, { verifiedFirstInstaller = false, verifiedAppImage = null } = {}) {
  if (verifiedFirstInstaller !== true) throw new Error('Only a verified first installer may create or rotate the recovery trust anchor')
  if (!isAbsolute(path) || path !== resolve(path)) throw new Error('Recovery anchor must use its exact canonical path')
  const selectedAnchor = resolve(path), selectedStateRoot = dirname(dirname(selectedAnchor))
  const stateRoot = realpathSync(selectedStateRoot)
  if (selectedStateRoot !== stateRoot || selectedAnchor !== join(stateRoot, 'recovery-tool', 'anchor.json')) {
    throw new Error('Recovery anchor must use the canonical state root')
  }
  // Validate every source component before creating the recovery directory or
  // any temporary file.  A verified installer must not persist aliases.
  const record = recoveryAnchorRecord({ ...expected, stateRoot, anchorPath: selectedAnchor, verifiedAppImage })
  mkdirSync(dirname(selectedAnchor), { recursive: true, mode: 0o700 })
  if (realpathSync(dirname(selectedAnchor)) !== dirname(selectedAnchor)) throw new Error('Recovery anchor must use its exact canonical path')
  if (existsSync(selectedAnchor) && realpathSync(selectedAnchor) !== selectedAnchor) throw new Error('Recovery anchor must use its exact canonical path')
  const invocationPath = recoveryAnchorInvocationPath(path, record.platform)
  const invocation = recoveryAnchorInvocation(path, record)
  safeDirectory(dirname(path), 'Recovery anchor directory')
  if (existsSync(path)) {
    // safeFile rejects links, non-files, foreign ownership and unsafe POSIX
    // permissions before replacement. A verified reinstall owns rotation of a
    // stale or corrupt regular-file anchor; managed releases never enter here.
    safeFile(path, 'Recovery anchor')
    try {
      const found = readJSONFile(path, 'Recovery anchor').value
      if (sameObject(found, record) && existsSync(invocationPath) &&
          sha256(readFileSync(invocationPath)) === sha256(Buffer.from(invocation))) return found
    } catch {}
  }
  safeFile(invocationPath, 'Recovery anchor invocation', { required: false })
  const temporary = `${invocationPath}.new-${process.pid}`
  writeFileSync(temporary, invocation, { flag: 'wx', mode: record.platform === 'win32' ? 0o600 : 0o700 })
  const descriptor = openSync(temporary, 'r'); try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  renameSync(temporary, invocationPath); syncDirectory(dirname(invocationPath))
  atomicJSON(path, record)
  return record
}

export function readRecoveryAnchor(path) {
  let record
  let canonical
  try {
    if (!isAbsolute(path) || path !== resolve(path)) throw new Error('non-canonical')
    canonical = realpathSync(path)
    if (resolve(path) !== canonical) throw new Error('alias')
    record = readJSONFile(path, 'Recovery anchor').value
  } catch {
    throw new Error('Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery')
  }
  const expectedStateRoot = dirname(dirname(canonical))
  if (record?.schema !== 3 || record.kind !== 'recovery-anchor' || !['linux', 'win32', 'darwin'].includes(record.platform) ||
      !['x64', 'arm64'].includes(record.arch) || !isAbsolute(record.executablePath) || !isAbsolute(record.stateRoot) ||
      !isAbsolute(record.anchorPath) || record.stateRoot !== expectedStateRoot || record.anchorPath !== canonical ||
      canonical !== join(expectedStateRoot, 'recovery-tool', 'anchor.json') ||
      !record.digests || !['executablePath', 'bootstrapPath', 'pythonPath', 'helperPath'].every(name => /^[a-f0-9]{64}$/.test(record.digests[name] || '')) ||
      (record.platform === 'linux' && !/^[a-f0-9]{64}$/.test(record.digests.actualExecutablePath || '')) ||
      record.digests.anchorPath !== sha256(Buffer.from(canonical))) {
    throw new Error('Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery')
  }
  const layout = record.componentLayout
  if (!layout || (record.platform === 'linux'
    ? layout.kind !== 'appimage-v1' || !Object.entries(APPIMAGE_LAYOUT).every(([name, value]) => layout[name] === value) ||
      Object.keys(layout).sort().join(',') !== ['actualExecutablePath', 'bootstrapPath', 'helperPath', 'kind', 'pythonPath'].sort().join(',')
    : layout.kind !== 'fixed-v1' || !['executablePath', 'bootstrapPath', 'pythonPath', 'helperPath'].every(name =>
      isAbsolute(layout[name] || '') && layout[name] === resolve(layout[name])))) {
    throw new Error('Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery')
  }
  return record
}

function copyTree(sourceRoot, destinationRoot, prefix, inventory, runtimeRoot = destinationRoot) {
  for (const name of readdirSync(sourceRoot).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    const source = resolve(sourceRoot, name), destination = resolve(destinationRoot, name)
    const path = `${prefix}${name}`.split(sep).join('/'), info = lstatSync(source)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(source)
      if (isAbsolute(target)) throw new Error('Recovery runtime contains an absolute symbolic link')
      const resolvedTarget = resolve(dirname(destination), target)
      if (!inside(resolvedTarget, runtimeRoot)) throw new Error('Recovery runtime symbolic link escapes its root')
      symlinkSync(target, destination)
      inventory.push({ path, type: 'symlink', target })
    } else if (info.isDirectory()) {
      mkdirSync(destination, { mode: 0o700 })
      inventory.push({ path, type: 'directory', mode: 0o700 })
      copyTree(source, destination, `${path}/`, inventory, runtimeRoot)
    } else if (info.isFile()) {
      copyFileSync(source, destination)
      const mode = info.mode & 0o111 ? 0o700 : 0o600
      chmodSync(destination, mode)
      const descriptor = openSync(destination, 'r'); try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      const bytes = readFileSync(destination)
      inventory.push({ path, type: 'file', size: bytes.length, sha256: sha256(bytes), mode })
    } else throw new Error('Recovery runtime contains an unsupported filesystem entry')
  }
}

export function recoveryInvocation(manifest, recoveryRoot, args = []) {
  if (!manifest || manifest.schema !== 2 || manifest.kind !== 'recovery-kit' ||
      !['linux', 'win32', 'darwin'].includes(manifest.target?.platform) ||
      !['x64', 'arm64'].includes(manifest.target?.arch) ||
      (manifest.target.platform === 'win32' && manifest.target.arch !== 'x64') ||
      (manifest.target.platform === 'darwin' && manifest.target.arch !== 'arm64') ||
      !safeEntrypoint(manifest.runtimeEntrypoint.replace(/^runtime\//, ''))) throw new Error('Invalid recovery kit manifest')
  const runtime = resolve(recoveryRoot, ...manifest.runtimeEntrypoint.split('/'))
  if (!inside(runtime, recoveryRoot)) throw new Error('Recovery runtime entrypoint escapes its kit')
  return { command: runtime, args: [resolve(recoveryRoot, 'tools', 'recovery_cli.mjs'), ...args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SINGHOUSE_RECOVERY_KIT: '1' } }
}

export function installRecoveryKit({ recoveryRoot, targetRoot, files, target, binding, anchor,
  pythonPath, backendHelperPath, run = spawnSync, durableReplace }) {
  if (!isAbsolute(recoveryRoot) || !isAbsolute(targetRoot) || inside(recoveryRoot, targetRoot)) {
    throw new Error('Recovery kit must be installed outside the replaceable application target')
  }
  safeDirectory(targetRoot, 'Managed prior application', { source: true })
  if (!target || !['linux', 'win32', 'darwin'].includes(target.platform) || !['x64', 'arm64'].includes(target.arch) ||
      (target.platform === 'win32' && target.arch !== 'x64') || (target.platform === 'darwin' && target.arch !== 'arm64') ||
      !safeEntrypoint(target.entrypoint)) {
    throw new Error('Invalid recovery runtime target')
  }
  if (!binding || binding.schema !== 1 || !/^point-[A-Za-z0-9]+$/.test(binding.recoveryPoint || '') ||
      !/^[a-f0-9]{64}$/.test(binding.recoveryManifestSha256 || '') || !/^[a-f0-9]{64}$/.test(binding.updateMetadataSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(binding.previousReleaseId || '') || !/^[a-f0-9]{64}$/.test(binding.targetReleaseId || '') ||
      !Number.isSafeInteger(binding.sequence) || binding.sequence < 1) throw new Error('Invalid recovery kit handoff binding')
  const canonicalRecoveryRoot = resolve(recoveryRoot), recoveryToolRoot = dirname(dirname(canonicalRecoveryRoot))
  const expectedStateRoot = dirname(recoveryToolRoot), expectedAnchorPath = join(recoveryToolRoot, 'anchor.json')
  if (recoveryRoot !== canonicalRecoveryRoot || !anchor || anchor.schema !== 3 || anchor.kind !== 'recovery-anchor' || anchor.platform !== target.platform ||
      anchor.arch !== target.arch || !isAbsolute(anchor.executablePath) || anchor.stateRoot !== expectedStateRoot ||
      anchor.anchorPath !== expectedAnchorPath || anchor.digests?.anchorPath !== sha256(Buffer.from(expectedAnchorPath))) {
    throw new Error('Recovery kit requires the exact bound stable first-install trust anchor')
  }
  const parent = dirname(recoveryRoot), temporaryRoot = `${recoveryRoot}.new-${process.pid}`, lastGood = `${recoveryRoot}.last-good`
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  safeDirectory(parent, 'Recovery kit parent')
  if (existsSync(temporaryRoot)) { safeDirectory(temporaryRoot, 'Temporary recovery kit'); rmSync(temporaryRoot, { recursive: true }) }
  mkdirSync(temporaryRoot, { mode: 0o700 })
  const inventory = []
  const runtimeRoot = resolve(temporaryRoot, 'runtime'), toolsRoot = resolve(temporaryRoot, 'tools')
  mkdirSync(runtimeRoot, { mode: 0o700 }); mkdirSync(toolsRoot, { mode: 0o700 })
  inventory.push({ path: 'runtime', type: 'directory', mode: 0o700 }, { path: 'tools', type: 'directory', mode: 0o700 })
  copyTree(targetRoot, runtimeRoot, 'runtime/', inventory)
  for (const [name, source] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid recovery kit filename')
    const sourceInfo = safeFile(source, 'Recovery kit source', { source: true })
    const destination = resolve(toolsRoot, name)
    if (!inside(destination, toolsRoot)) throw new Error('Invalid recovery kit destination')
    safeFile(destination, 'Recovery kit destination', { required: false })
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
    const descriptor = openSync(destination, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    const bytes = readFileSync(destination)
    if (bytes.length !== sourceInfo.size) throw new Error('Recovery kit copy was incomplete')
    inventory.push({ path: `tools/${name}`, type: 'file', size: bytes.length, sha256: sha256(bytes), mode: 0o600 })
  }
  const launcherName = target.platform === 'win32' ? 'recover.cmd' : 'recover.sh'
  const anchorPath = resolve(dirname(parent), 'anchor.json')
  const invocationPath = recoveryAnchorInvocationPath(anchorPath, target.platform)
  const launcher = target.platform === 'win32'
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor %%I in ("%~dp0.") do set "KIT=%%~fI"\r\nif not exist ${cmdQuotedLiteral(invocationPath)} goto missing\r\n${cmdQuotedLiteral(invocationPath)} "%KIT%" %*\r\nexit /b %errorlevel%\r\n:missing\r\necho Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery. 1>&2\r\nexit /b 1\r\n`
    : `#!/bin/sh\nset -eu\nKIT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nINVOKE='${invocationPath.replaceAll("'", "'\\''")}'\nif [ ! -f "$INVOKE" ]; then\n  echo 'Recovery trust anchor is missing or corrupt; reinstall singhouse before attempting recovery.' >&2\n  exit 1\nfi\nexec "$INVOKE" "$KIT" "$@"\n`
  const launcherPath = resolve(temporaryRoot, launcherName), launcherMode = target.platform === 'win32' ? 0o600 : 0o700
  writeFileSync(launcherPath, launcher, { mode: launcherMode }); const launcherDescriptor = openSync(launcherPath, 'r')
  try { fsyncSync(launcherDescriptor) } finally { closeSync(launcherDescriptor) }
  inventory.push({ path: launcherName, type: 'file', size: Buffer.byteLength(launcher), sha256: sha256(Buffer.from(launcher)), mode: launcherMode })
  const runtimeEntrypoint = `runtime/${target.entrypoint}`.split(sep).join('/')
  if (!inventory.some(record => record.path === runtimeEntrypoint && record.type === 'file')) throw new Error('Recovery runtime entrypoint is absent')
  const manifest = { schema: 2, kind: 'recovery-kit', target: { platform: target.platform, arch: target.arch }, binding,
    runtimeEntrypoint, files: inventory.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path))) }
  atomicJSON(resolve(temporaryRoot, 'manifest.json'), manifest)
  syncTreeDirectories(temporaryRoot)
  const replace = durableReplace || ((source, destination) => {
    if (!pythonPath || !backendHelperPath) throw new Error('Recovery kit publication requires the native durability helper')
    const result = run(pythonPath, ['-I', '-B', backendHelperPath, '--durable-application-replace', source, destination],
      { encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('Could not durably publish recovery kit')
    let confirmation
    try { confirmation = JSON.parse(result.stdout) } catch { throw new Error('Invalid recovery kit durability confirmation') }
    if (confirmation?.schema !== 1 || confirmation.durable !== true) throw new Error('Invalid recovery kit durability confirmation')
  })
  try {
    if (existsSync(lastGood)) { safeDirectory(lastGood, 'Prior recovery kit'); rmSync(lastGood, { recursive: true }) }
    if (existsSync(recoveryRoot)) { safeDirectory(recoveryRoot, 'Recovery kit'); replace(recoveryRoot, lastGood) }
    replace(temporaryRoot, recoveryRoot)
  } catch (error) {
    if (!existsSync(recoveryRoot) && existsSync(lastGood)) { try { replace(lastGood, recoveryRoot) } catch {} }
    throw error
  }
  return manifest
}

export function validateRecoveryPoint(point) {
  if (!point || point.schema !== 1 || point.kind !== 'recovery-point' ||
      typeof point.createdAt !== 'string' || Number.isNaN(Date.parse(point.createdAt)) ||
      !point.release || typeof point.release.releaseId !== 'string' ||
      typeof point.release.appVersion !== 'string' || !Array.isArray(point.files) || point.files.length !== 1 ||
      point.files[0].path !== 'database.sqlite3' || point.files[0].executable !== false ||
      !Number.isSafeInteger(point.files[0].size) || point.files[0].size < 0 ||
      !/^[a-f0-9]{64}$/.test(point.files[0].sha256) ||
      typeof point.files[0].url !== 'string' || point.files[0].url.length === 0 ||
      !point.application || point.application.schema !== 1 ||
      point.application.releaseId !== point.release.releaseId) {
    throw new Error('Invalid recovery point')
  }
  if (point.update !== null && typeof point.update !== 'string') throw new Error('Invalid recovery update binding')
  return point
}

function sameObject(left, right) {
  const a = Buffer.from(exactJSON(left)); const b = Buffer.from(exactJSON(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function readJSONFile(path, label) {
  safeFile(path, label)
  return { raw: readFileSync(path), value: JSON.parse(readFileSync(path, 'utf8')) }
}

function durableJSON(path, value, { run, pythonPath, backendHelperPath }) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  safeFile(path, 'Recovery state', { required: false })
  const temporary = `${path}.new-${process.pid}`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  const result = run(pythonPath, ['-I', '-B', backendHelperPath, '--durable-replace', temporary, path],
    { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    try { unlinkSync(temporary) } catch {}
    throw new Error('Could not durably commit recovery state')
  }
}

/**
 * Restore a recovery point after validating its exact update transaction.
 * `verifyMetadata` is the release module's pinned-key verifier and must return
 * the authenticated metadata object (never a caller-provided parsed object).
 */
export function recover({ pointPath, handoffPath, metadataPath,
  activeApplicationPath, transactionPath = resolve(dirname(dirname(activeApplicationPath)), 'recovery-transaction.json'),
  applicationSourcePath, applicationDestinationPath, applicationInventory,
  dataDirectory, pythonPath, backendHelperPath, verifyMetadata, recoveryKitManifest,
  run = spawnSync, crashAfterDatabase = false, crashAfterSelection = false }) {
  for (const [path, label] of [[pointPath, 'Recovery point'], [handoffPath, 'Recovery handoff'],
    [metadataPath, 'Signed update metadata'],
    [pythonPath, 'Recovery Python'], [backendHelperPath, 'Recovery helper']]) safeFile(path, label)
  if (!isAbsolute(activeApplicationPath) || !isAbsolute(transactionPath) || !isAbsolute(dataDirectory) || dataDirectory === resolve('/')) throw new Error('Invalid recovery destinations')
  safeFile(activeApplicationPath, 'Active application pointer', { required: false })
  if (!isAbsolute(applicationSourcePath) || !isAbsolute(applicationDestinationPath) || applicationSourcePath === applicationDestinationPath ||
      !Array.isArray(applicationInventory)) throw new Error('Invalid recovered application source')
  safeDirectory(applicationSourcePath, 'Verified recovery-kit application')
  const retainedApplicationPath = resolve(applicationSourcePath, 'installed.json')
  safeFile(retainedApplicationPath, 'Retained application manifest')
  // Reject the path object before resolve: resolving a symlink first defeats
  // the recovery boundary even if its target happens to be inside the store.
  if (existsSync(dataDirectory) && lstatSync(dataDirectory).isSymbolicLink()) throw new Error('Database destination must not be a symbolic link')

  const pointRecord = readJSONFile(pointPath, 'Recovery point')
  const point = validateRecoveryPoint(pointRecord.value)
  const handoffRecord = readJSONFile(handoffPath, 'Recovery handoff')
  const metadataRecord = readJSONFile(metadataPath, 'Signed update metadata')
  const installed = readJSONFile(retainedApplicationPath, 'Retained application manifest').value
  const handoff = handoffRecord.value
  if (!handoff || handoff.schema !== 1 || handoff.kind !== 'update-handoff' ||
      !['preparing', 'awaiting-target', 'retryable', 'completed'].includes(handoff.state) ||
      handoff.stagedRelease !== point.update || handoff.recoveryPoint !== dirname(pointPath).split(/[\\/]/).at(-1) ||
      handoff.recoveryManifestSha256 !== sha256(Buffer.from(exactJSON(point))) ||
      !sameObject(handoff.previousApplication, point.application) ||
      !sameObject(installed, point.application)) throw new Error('Recovery point is not bound to the installed prior application')
  const expectedKitBinding = { schema: 1, recoveryPoint: handoff.recoveryPoint,
    recoveryManifestSha256: handoff.recoveryManifestSha256, updateMetadataSha256: handoff.updateMetadataSha256,
    previousReleaseId: handoff.previousIdentity?.releaseId, targetReleaseId: handoff.targetIdentity?.releaseId,
    sequence: handoff.sequence }
  if (!recoveryKitManifest || !sameObject(recoveryKitManifest.binding, expectedKitBinding) ||
      handoff.recoveryKit?.id !== `kit-${handoff.recoveryPoint}` ||
      handoff.recoveryKit?.manifestSha256 !== sha256(Buffer.from(exactJSON(recoveryKitManifest)))) {
    throw new Error('Recovery kit is not bound to this authenticated handoff')
  }
  const active = readJSONFile(activeApplicationPath, 'Active application pointer').value
  let priorTransaction = null
  if (existsSync(transactionPath)) priorTransaction = readJSONFile(transactionPath, 'Recovery transaction').value
  const retrying = priorTransaction?.schema === 1 && priorTransaction.kind === 'recovery-transaction' &&
    priorTransaction.state === 'in-progress' && priorTransaction.releaseId === point.release.releaseId &&
    priorTransaction.recoveryPoint === handoff.recoveryPoint &&
    priorTransaction.recoveryManifestSha256 === handoff.recoveryManifestSha256 &&
    priorTransaction.updateMetadataSha256 === handoff.updateMetadataSha256
  const { sequence: activeSequence, ...activeApplication } = active || {}
  const selectedTarget = Number.isSafeInteger(handoff.sequence) && activeSequence === handoff.sequence &&
    sameObject(activeApplication, handoff.targetApplication)
  if (!(selectedTarget || (retrying && sameObject(active, point.application))) ||
      handoff.targetApplication.releaseId !== handoff.targetIdentity?.releaseId ||
      handoff.previousApplication.releaseId !== handoff.previousIdentity?.releaseId) throw new Error('Active application does not match the exact update handoff')
  const authenticated = verifyMetadata(metadataRecord.value)
  if (!authenticated || authenticated.identity?.releaseId !== handoff.stagedRelease ||
      (handoff.sequence !== undefined && authenticated.sequence !== handoff.sequence) ||
      authenticated.identity?.releaseId !== handoff.targetIdentity.releaseId ||
      !sameObject(authenticated.identity, handoff.targetIdentity) ||
      !Array.isArray(authenticated.supersedes) || authenticated.supersedes.length !== 1 ||
      authenticated.supersedes[0] !== handoff.previousIdentity.releaseId ||
      handoff.updateMetadataSha256 !== sha256(Buffer.from(exactJSON(authenticated)))) {
    throw new Error('Signed metadata does not authorize this exact rollback')
  }

  let databaseFile
  try { databaseFile = fileURLToPath(point.files[0].url) } catch { throw new Error('Recovery database URL is invalid') }
  databaseFile = resolve(databaseFile)
  if (!inside(databaseFile, dirname(pointPath)) || pathToFileURL(databaseFile).href !== point.files[0].url ||
      databaseFile !== resolve(dirname(pointPath), point.files[0].path)) throw new Error('Recovery database escapes its point')
  safeFile(databaseFile, 'Recovery database')
  const databaseBytes = readFileSync(databaseFile)
  if (databaseBytes.length !== point.files[0].size || sha256(databaseBytes) !== point.files[0].sha256) {
    throw new Error('Recovery database verification failed')
  }
  const transaction = { schema: 1, kind: 'recovery-transaction', state: 'in-progress',
    releaseId: point.release.releaseId, installationSha256: sha256(Buffer.from(exactJSON(point.application))),
    recoveryPoint: handoff.recoveryPoint, recoveryManifestSha256: handoff.recoveryManifestSha256,
    updateMetadataSha256: handoff.updateMetadataSha256, startedAt: new Date().toISOString() }
  if (crashAfterDatabase || crashAfterSelection) throw new Error('JavaScript recovery crash injection is unsupported by the paired native transaction')
  const planPath = `${transactionPath}.plan-${process.pid}`
  const plan = { schema: 1, dataDirectory, databaseSource: databaseFile,
    applicationSource: applicationSourcePath, applicationDestination: applicationDestinationPath,
    applicationInventory, application: point.application, activePath: activeApplicationPath,
    transactionPath, transaction }
  const descriptor = openSync(planPath, 'wx', 0o600)
  try { writeFileSync(descriptor, `${exactJSON(plan)}\n`); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  try {
    const recovered = run(pythonPath, ['-I', '-B', backendHelperPath, '--paired-recovery', planPath],
      { encoding: 'utf8', windowsHide: true, env: recoveredLaunchEnvironment() })
    if (recovered.error || recovered.status !== 0) throw new Error('Paired recovery failed; the retained recovery kit remains available')
    let confirmation
    try { confirmation = JSON.parse(recovered.stdout) } catch { throw new Error('Invalid paired recovery confirmation') }
    if (confirmation?.schema !== 1 || confirmation.recovered !== true ||
        confirmation.releaseId !== point.release.releaseId || typeof confirmation.launched !== 'string') {
      throw new Error('Invalid paired recovery confirmation')
    }
  } finally { try { unlinkSync(planPath) } catch {} }
  return { releaseId: point.release.releaseId, completed: true, launched: true }
}

export function recoveryTransaction(path) {
  if (!existsSync(path)) return null
  return readJSONFile(path, 'Recovery transaction').value
}
