// SPDX-License-Identifier: AGPL-3.0-only
// Manifests are administrator-selected inputs, not a remotely trusted catalog.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, lstat, statfs, readdir } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchOwnedGroup, forceChild } from './lifecycle.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const token = /^[A-Za-z0-9._+-]{1,128}$/
const safePath = value => typeof value === 'string' && value.length < 512
  && value.split('/').every(part => /^[A-Za-z0-9._+-]+$/.test(part) && !part.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))

// This is a fixed application-owned protocol, never a command from a manifest.
const PROBE = `import importlib, importlib.metadata, json, platform, sys
capabilities = json.loads(sys.argv[1])
accelerator = sys.argv[2]
modules = json.loads(sys.argv[3])
components = {}
for package in modules:
    imported = importlib.import_module(package)
    components[package] = getattr(imported, '__version__', None) or importlib.metadata.version(package.split('.')[0].replace('_', '-'))
torch = importlib.import_module('torch')
hardware = accelerator == 'cpu' or (accelerator == 'cuda' and torch.cuda.is_available()) or (accelerator == 'metal' and torch.backends.mps.is_available())
print(json.dumps({'schema': 1, 'pythonVersion': platform.python_version(), 'backendVersion': importlib.metadata.version('karaoke-backend'), 'lyricsyncVersion': importlib.metadata.version('lyricsync'), 'capabilities': capabilities, 'accelerator': accelerator, 'hardwareAvailable': bool(hardware), 'components': components}))
`

// The playback interpreter holds a kernel lock on a stable inode. Crashes
// release ownership automatically; there is no PID-based unlink/recreate race.
const LOCK = `import json, os, pathlib, sys, time
path = pathlib.Path(sys.argv[1])
if path.is_symlink():
    sys.exit(74)
fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
with os.fdopen(fd, 'r+b') as stream:
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(73)
    metadata = {'schema': 1, 'pid': os.getpid(), 'parentPid': int(sys.argv[2]), 'startedAtNs': str(time.time_ns()), 'nonce': os.urandom(16).hex()}
    try:
        metadata['startTicks'] = pathlib.Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
        metadata['bootId'] = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except (OSError, IndexError):
        pass
    stream.seek(0)
    stream.write(json.dumps(metadata).encode())
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())
    print(json.dumps(metadata), flush=True)
    sys.stdin.buffer.read()
`

export async function acquireInstallLock(path, python) {
  if (typeof python !== 'string' || !python) throw new Error('A bundled playback interpreter is required for the runtime lock')
  const child = spawn(python, ['-I', '-B', '-c', LOCK, path, String(process.pid)],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  child.stdin.on('error', () => {})
  const lost = new AbortController()
  let releasing = false, acquired = false
  const closed = new Promise(resolveClosed => child.once('close', code => {
    if (!releasing) lost.abort(new Error('Runtime installation lock owner exited'))
    resolveClosed(code)
  }))
  return new Promise((resolveLock, reject) => {
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime lock acquisition timed out')) }, 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (!acquired) reject(new Error(code === 73 ? 'Another live installation owns the runtime lock' : 'Runtime lock could not be acquired'))
    })
    child.stdout.on('data', chunk => {
      if (acquired) return
      output += chunk.toString('utf8')
      if (output.length > 4096) { child.kill('SIGKILL'); reject(new Error('Invalid runtime lock handshake')); return }
      if (!output.includes('\n')) return
      try {
        const metadata = JSON.parse(output)
        if (metadata.schema !== 1 || metadata.pid !== child.pid || metadata.parentPid !== process.pid) throw new Error('Invalid runtime lock identity')
        clearTimeout(timer)
        acquired = true
        resolveLock({ metadata, signal: lost.signal, release: async () => {
          releasing = true
          child.stdin.end()
          const code = await closed
          if (code !== 0) throw new Error('Runtime installation lock ended unexpectedly')
        } })
      } catch (error) { child.kill('SIGKILL'); reject(error) }
    })
  })
}

export function validateProcessingManifest(value, expected, trustedLocks = []) {
  let inputLock
  try { inputLock = JSON.parse(value?.provenance?.inputLock) } catch { throw new Error('Processing manifest provenance is missing or malformed') }
  if (!value || value.schema !== 1 || value.kind !== 'processing'
      || value.probe?.schema !== 1 || value.probe?.type !== 'python-imports-v1'
      || !Array.isArray(value.probe.modules) || !value.probe.modules.length || value.probe.modules.some(v => !token.test(v))
      || !['cpu', 'cuda', 'metal'].includes(value.accelerator)
      || ['appVersion', 'backendVersion', 'lyricsyncVersion', 'pythonVersion', 'platform', 'arch'].some(key => !token.test(value[key] || ''))
      || ['appVersion', 'backendVersion', 'lyricsyncVersion', 'platform', 'arch'].some(key => value[key] !== expected[key])
      || !value.provenance || !hashPattern.test(value.provenance.lockSha256 || '')
      || digest(value.provenance.inputLock) !== value.provenance.lockSha256
      || !/^[a-f0-9]{40}$/.test(value.provenance.sourceCommit || '')
      || !safePath(value.python) || !Array.isArray(value.files) || !value.files.length
      || !Array.isArray(value.capabilities) || value.capabilities.some(v => !['transcription', 'separation'].includes(v))
      || !Array.isArray(value.models) || new Set(value.models).size !== value.models.length || value.models.some(v => !token.test(v))) {
    throw new Error('Processing manifest is invalid or incompatible with this application')
  }
  if (!(Array.isArray(trustedLocks) || trustedLocks instanceof Set)
      || !(trustedLocks instanceof Set ? trustedLocks.has(value.provenance.lockSha256) : trustedLocks.includes(value.provenance.lockSha256))) {
    throw new Error('Processing input lock is not trusted by this application release')
  }
  const required = { transcription: ['faster_whisper', 'lyricsync.transcription.heart', 'karaoke_backend.workers.heart_transcriptor'], separation: ['demucs.separate', 'audio_separator.separator'] }
  const expectedModules = [...new Set(value.capabilities.flatMap(capability => required[capability]))].sort()
  if (JSON.stringify(value.probe.modules) !== JSON.stringify(expectedModules)
      || !value.modelCapabilities || Object.keys(value.modelCapabilities).sort().join('\0') !== [...value.models].sort().join('\0')
      || Object.values(value.modelCapabilities).some(capability => !value.capabilities.includes(capability))) throw new Error('Processing capability probe is incomplete')
  const boundKeys = ['appVersion', 'backendVersion', 'lyricsyncVersion', 'pythonVersion', 'platform', 'arch', 'accelerator', 'python', 'capabilities', 'models', 'modelCapabilities', 'files', 'packages', 'sourceCommit']
  for (const key of boundKeys) {
    const manifestValue = key === 'packages' ? value.provenance.packages : key === 'sourceCommit' ? value.provenance.sourceCommit
      : key === 'files' ? value.files.map(({ url, ...record }) => record) : value[key]
    if (JSON.stringify(manifestValue) !== JSON.stringify(inputLock[key])) throw new Error('Processing manifest differs from its input lock')
  }
  if (inputLock.schema !== 1 || inputLock.kind !== 'processing-input'
      || !Array.isArray(inputLock.packages) || !inputLock.packages.length || inputLock.packages.some(packageRecord => {
        let source
        try { source = new URL(packageRecord.sourceUrl) } catch { return true }
        return !token.test(packageRecord.name || '') || !token.test(packageRecord.version || '')
          || typeof packageRecord.license !== 'string' || !packageRecord.license.trim()
          || source.protocol !== 'https:' || source.username || source.password || source.hash
          || !hashPattern.test(packageRecord.sha256 || '') || !Array.isArray(packageRecord.notices)
          || !packageRecord.notices.length || packageRecord.notices.some(path => !safePath(path) || !value.files.some(file => file.path === path))
      })) throw new Error('Processing package provenance or notices are malformed')
  if (value.accelerator === 'metal' && value.platform !== 'darwin'
      || value.accelerator === 'cuda' && value.platform === 'darwin') throw new Error('Invalid accelerator target')
  const paths = new Set()
  for (const file of value.files) {
    if (!safePath(file.path) || file.path === 'manifest.json' || file.path.endsWith('.partial')
        || paths.has(file.path.toLowerCase()) || !hashPattern.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.executable !== 'boolean') throw new Error('Invalid processing file record')
    paths.add(file.path.toLowerCase())
    const url = new URL(file.url)
    if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Inputs require local files or HTTPS')
    if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') throw new Error('Remote file shares are not supported')
  }
  if (!value.files.some(file => file.path === value.python && file.executable)) throw new Error('Pack lacks its managed Python executable')
  const total = value.files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(total)) throw new Error('Processing pack is too large')
  return value
}

async function checkedFile(path, flags) {
  const file = await open(path, flags | (constants.O_NOFOLLOW || 0), 0o600)
  try {
    const info = await file.stat()
    const named = await lstat(path)
    if (!info.isFile() || !named.isFile() || named.isSymbolicLink()
        || info.ino !== named.ino || info.dev !== named.dev) throw new Error('Runtime file changed while opening it')
    return file
  } catch (error) { await file.close(); throw error }
}

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
  return hash.digest('hex')
}

async function checkedRead(path) {
  const file = await checkedFile(path, constants.O_RDONLY)
  try { return await file.readFile('utf8') } finally { await file.close() }
}

async function plainDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error('Runtime directory must not be a symbolic link')
}

async function matches(path, record) {
  let file
  try {
    file = await checkedFile(path, constants.O_RDONLY)
    return (await file.stat()).size === record.size && await fileHash(file) === record.sha256
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  finally { await file?.close() }
}

async function inventory(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), relative + '/'))
    else if (entry.isFile()) files.push(relative)
    else throw new Error('Runtime contains a symbolic link or unsupported file')
  }
  return files
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
    return true
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) return false
    throw error
  } finally { await handle?.close() }
}

async function syncTree(directory, directorySync) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await syncTree(path, directorySync)
    else if (entry.isFile()) {
      const file = await checkedFile(path, constants.O_RDWR)
      try { await file.sync() } finally { await file.close() }
    } else throw new Error('Cannot synchronize an unsafe runtime file')
  }
  await directorySync(directory)
}

export class RuntimeManager {
  constructor(root, identity, { fetchImpl = globalThis.fetch, diskFree, progress = () => {}, lockPython,
    durabilityHelper, directorySync = syncDirectory, activationHook = async () => {}, trustedLocks = [] } = {}) {
    if (!isAbsolute(root)) throw new Error('Runtime store must be absolute')
    this.root = resolve(root)
    this.identity = identity
    this.fetch = fetchImpl
    this.diskFree = diskFree || (async () => { const s = await statfs(this.root); return s.bavail * s.bsize })
    this.progress = progress
    this.lockPython = lockPython
    this.durabilityHelper = durabilityHelper
    this.directorySync = directorySync
    this.activationHook = activationHook
    this.trustedLocks = trustedLocks
    this.busy = false
  }

  validate(manifest) { return validateProcessingManifest(manifest, this.identity, this.trustedLocks) }

  async durableReplace(source, destination) {
    if (!this.lockPython || !this.durabilityHelper) throw new Error('The bundled native durability helper is required')
    return new Promise((resolveCommit, reject) => {
      const child = spawn(this.lockPython, ['-I', '-B', this.durabilityHelper, '--durable-replace', source, destination],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let output = '', errorOutput = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 4096) child.kill('SIGKILL') })
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString('utf8')).slice(-4096) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code !== 0) { reject(new Error(errorOutput.trim() || 'Native runtime durability could not be established')); return }
        try {
          const result = JSON.parse(output)
          if (result.schema !== 1 || result.durable !== true) throw new Error('Invalid native durability confirmation')
          resolveCommit()
        } catch (error) { reject(error) }
      })
    })
  }

  async probe(active, { timeout = 30000, signal } = {}) {
    // Verify again immediately before executing the selected interpreter.
    active = await this.verify(active.id)
    signal?.throwIfAborted()
    const manifest = active.manifest
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']
      .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]))
    Object.assign(env, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' })
    return new Promise((resolveProbe, reject) => {
      const child = spawn(join(active.directory, manifest.python), ['-I', '-B', '-c', PROBE, JSON.stringify(manifest.capabilities), manifest.accelerator, JSON.stringify(manifest.probe.modules)],
        { cwd: active.directory, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
      if (process.platform !== 'win32') watchOwnedGroup(child)
      let output = '', failure
      const stop = error => { failure = error; try { forceChild(child) } catch (cleanup) { failure = cleanup } }
      const abort = () => stop(new Error('Processing runtime self-test cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => stop(new Error('Processing runtime self-test timed out')), timeout)
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8')
        if (output.length > 4096) stop(new Error('Invalid processing self-test response'))
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      // close occurs after process reaping and pipe closure.
      child.once('close', code => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (failure || code !== 0) { reject(failure || new Error('Processing dependencies could not be loaded')); return }
        try {
          const result = JSON.parse(output)
          if (result.schema !== 1 || result.hardwareAvailable !== true
              || ['pythonVersion', 'backendVersion', 'lyricsyncVersion', 'accelerator'].some(key => result[key] !== manifest[key])
              || JSON.stringify(result.capabilities) !== JSON.stringify(manifest.capabilities)
              || !result.components || JSON.stringify(Object.keys(result.components).sort()) !== JSON.stringify([...manifest.probe.modules].sort())
              || Object.values(result.components).some(value => typeof value !== 'string' || !value)) throw new Error('Processing runtime self-test did not match its manifest or hardware')
          // Importability is dependency evidence, not proof that model inference
          // can run. Production locks may later add app-owned executable smoke
          // fixtures; until then no capability is advertised runnable.
          resolveProbe({ ...result, verifiedCapabilities: [], capabilitiesReady: false })
        } catch (error) { reject(error) }
      })
    })
  }

  async transfer(record, partial, signal) {
    // Keep one no-follow descriptor from fstat through write/hash/chmod. A
    // concurrently replaced directory entry cannot redirect these file writes.
    const target = await checkedFile(partial, constants.O_CREAT | constants.O_RDWR)
    let localSource
    try {
      let offset = (await target.stat()).size
      if (offset === record.size && await fileHash(target) === record.sha256) return
      if (offset >= record.size) { await target.truncate(0); offset = 0 }
      signal?.throwIfAborted()
      let source
      const url = new URL(record.url)
      if (url.protocol === 'file:') {
        localSource = await checkedFile(fileURLToPath(url), constants.O_RDONLY)
        source = localSource.createReadStream({ start: offset, autoClose: false, signal })
      } else {
        const response = await this.fetch(url, { redirect: 'error', signal,
          headers: offset ? { Range: `bytes=${offset}-` } : {} })
        if (response.status === 200) { offset = 0; await target.truncate(0) }
        else if (response.status !== 206 || !offset
            || response.headers.get('content-range') !== `bytes ${offset}-${record.size - 1}/${record.size}`) {
          throw new Error(`Source transfer failed (${response.status})`)
        }
        if (!response.body) throw new Error('Source transfer has no body')
        source = response.body
      }
      let size = offset
      for await (const chunk of source) {
        signal?.throwIfAborted()
        if (size + chunk.length > record.size) throw new Error('Source transfer exceeds manifest size')
        let written = 0
        while (written < chunk.length) {
          const result = await target.write(chunk, written, chunk.length - written, size + written)
          if (!result.bytesWritten) throw new Error('Runtime source transfer write made no progress')
          written += result.bytesWritten
        }
        size += chunk.length
        this.progress({ file: record.path, received: size, total: record.size })
      }
      if ((await target.stat()).size !== record.size || await fileHash(target) !== record.sha256) {
        await target.truncate(0)
        throw new Error('Source transfer checksum or size mismatch; previous runtime preserved')
      }
      await target.chmod(record.executable ? 0o700 : 0o600)
      await target.sync()
      const named = await lstat(partial), owned = await target.stat()
      if (!named.isFile() || named.isSymbolicLink() || named.ino !== owned.ino || named.dev !== owned.dev) {
        throw new Error('Runtime partial path changed during transfer')
      }
    } finally { await localSource?.close(); await target.close() }
  }

  async install(manifest, { signal, probeTimeout } = {}) {
    this.validate(manifest)
    // Copy before awaiting so caller mutation cannot alter checked inputs.
    manifest = JSON.parse(JSON.stringify(manifest))
    const id = digest(JSON.stringify(manifest))
    await plainDirectory(this.root)
    await this.directorySync(dirname(this.root))
    const lockPath = join(this.root, 'install.lock')
    const lock = await acquireInstallLock(lockPath, this.lockPython)
    signal = signal ? AbortSignal.any([signal, lock.signal]) : lock.signal
    this.busy = true
    try {
      signal.throwIfAborted()
      const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
      if (await this.diskFree() < bytes * 2 + 64 * 1024 * 1024) throw new Error('Not enough disk space for retrieval and activation; previous runtime preserved')
      const packs = join(this.root, 'packs'), staging = join(this.root, 'staging', id)
      await plainDirectory(packs)
      await plainDirectory(join(this.root, 'staging'))
      await plainDirectory(staging)
      for (const record of manifest.files) {
        signal?.throwIfAborted()
        const destination = join(staging, record.path)
        // Validate each ancestor so a pre-existing symlink cannot escape staging.
        let ancestor = staging
        for (const part of record.path.split('/').slice(0, -1)) { ancestor = join(ancestor, part); await plainDirectory(ancestor) }
        if (!await matches(destination, record)) {
          await this.transfer(record, destination + '.partial', signal)
          signal.throwIfAborted()
          await rename(destination + '.partial', destination)
        }
        await rm(destination + '.partial', { force: true })
        const file = await checkedFile(destination, constants.O_RDWR)
        try {
          if ((await file.stat()).size !== record.size || await fileHash(file) !== record.sha256) throw new Error('Runtime file changed before activation')
          await file.chmod(record.executable ? 0o700 : 0o600)
          await file.sync()
        } finally { await file.close() }
      }
      const manifestFile = await checkedFile(join(staging, 'manifest.json'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR).catch(async error => {
        if (error.code !== 'EEXIST') throw error
        if (await checkedRead(join(staging, 'manifest.json')) !== JSON.stringify(manifest)) throw new Error('Staging manifest mismatch')
        return null
      })
      if (manifestFile) { try { await manifestFile.writeFile(JSON.stringify(manifest)); await manifestFile.sync() } finally { await manifestFile.close() } }
      await syncTree(staging, this.directorySync)
      const destination = join(packs, id)
      signal.throwIfAborted()
      let existing = false
      try { await lstat(destination); existing = true }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (existing) { await this.verify(id); await this.durableReplace(destination, destination) }
      else await this.durableReplace(staging, destination)
      await this.verify(id)
      if (manifest.kind === 'processing') await this.probe({ id }, { timeout: probeTimeout, signal })
      signal?.throwIfAborted()
      await this.activationHook('pack-durable')
      // A native durable replacement commits the inactive pointer slot. Keep
      // the newest verified slot intact throughout any failure or interruption.
      const pointers = await this.readPointers()
      let latest
      for (const pointer of pointers) {
        try { await this.verify(pointer.id); latest = pointer; break }
        catch { /* Preserve the newest pointer which still names a good pack. */ }
      }
      const sequence = (pointers[0]?.sequence || 0) + 1
      if (!Number.isSafeInteger(sequence)) throw new Error('Runtime activation sequence exhausted')
      const slot = latest?.slot === 0 ? 1 : 0
      const body = { schema: 2, sequence, id }
      const value = { ...body, checksum: digest(JSON.stringify(body)) }
      const pending = join(this.root, `active.${slot}.pending`)
      const active = await checkedFile(pending, constants.O_RDWR | constants.O_CREAT)
      try {
        await active.truncate(0)
        await this.activationHook('pointer-open')
        signal.throwIfAborted()
        await active.writeFile(JSON.stringify(value))
        await active.sync()
      } finally { await active.close() }
      signal.throwIfAborted()
      await this.durableReplace(pending, join(this.root, `active.${slot}.json`))
      await this.activationHook('pointer-durable')
      return { id, directory: destination, manifest }
    } finally { this.busy = false; await lock.release() }
  }

  async verify(id) {
    if (!hashPattern.test(id || '')) throw new Error('Invalid active runtime identity')
    const directory = join(this.root, 'packs', id)
    for (const path of [this.root, join(this.root, 'packs'), directory]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid runtime directory')
    }
    const raw = await checkedRead(join(directory, 'manifest.json'))
    const manifest = this.validate(JSON.parse(raw))
    if (digest(JSON.stringify(manifest)) !== id) throw new Error('Runtime manifest was modified')
    const allowed = new Set(['manifest.json', ...manifest.files.map(file => file.path)])
    const present = await inventory(directory)
    if (present.length !== allowed.size || present.some(path => !allowed.has(path))) throw new Error('Runtime file inventory does not match its manifest')
    for (const file of manifest.files) {
      let ancestor = directory
      for (const part of file.path.split('/').slice(0, -1)) {
        ancestor = join(ancestor, part)
        if (!(await lstat(ancestor)).isDirectory() || (await lstat(ancestor)).isSymbolicLink()) throw new Error('Invalid runtime directory')
      }
      if (!await matches(join(directory, file.path), file)) throw new Error('Installed runtime verification failed')
    }
    return { id, directory, manifest }
  }

  async readPointers() {
    const values = []
    for (const slot of [0, 1]) {
      try {
        const value = JSON.parse(await checkedRead(join(this.root, `active.${slot}.json`)))
        const { schema, sequence, id, checksum } = value
        if (schema === 2 && Number.isSafeInteger(sequence) && sequence > 0 && hashPattern.test(id || '')
            && checksum === digest(JSON.stringify({ schema, sequence, id }))) values.push({ slot, sequence, id })
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }
    return values.sort((left, right) => right.sequence - left.sequence)
  }

  async active() {
    const pointers = await this.readPointers()
    let failure
    for (const pointer of pointers) {
      try { return await this.verify(pointer.id) }
      catch (error) { failure = error }
    }
    try {
      const value = JSON.parse(await checkedRead(join(this.root, 'active.json')))
      if (value.schema !== 1) throw new Error('Invalid active runtime pointer')
      return await this.verify(value.id)
    } catch (error) { if (failure) throw failure; if (error.code === 'ENOENT') return null; throw error }
  }
}

export function processingAttestation(active, probeResult) {
  const pythonRecord = active.manifest.files.find(file => file.path === active.manifest.python)
  if (!pythonRecord || probeResult?.schema !== 1 || probeResult.accelerator !== active.manifest.accelerator
      || !probeResult.components || typeof probeResult.components !== 'object' || Array.isArray(probeResult.components)
      || Object.values(probeResult.components).some(value => typeof value !== 'string' || !value)
      || probeResult.capabilitiesReady !== false || !Array.isArray(probeResult.verifiedCapabilities)
      || probeResult.verifiedCapabilities.length !== 0) {
    throw new Error('Invalid processing probe attestation')
  }
  return {
    runtimeManifestId: active.id,
    pythonPath: join(active.directory, active.manifest.python),
    pythonSha256: pythonRecord.sha256,
    probePassed: true,
    accelerator: probeResult.accelerator,
    components: Object.fromEntries(Object.entries(probeResult.components).sort(([a], [b]) => a.localeCompare(b))),
    verifiedCapabilities: probeResult.verifiedCapabilities,
    capabilitiesReady: probeResult.capabilitiesReady,
  }
}

export function validateModelManifest(value, policy) {
  if (!value || value.schema !== 1 || value.kind !== 'models'
      || !Array.isArray(value.models) || !value.models.length || new Set(value.models).size !== value.models.length || value.models.some(id => !token.test(id))
      || !Array.isArray(value.files) || !value.files.length) throw new Error('Invalid upstream model manifest')
  if (policy?.schema !== 1 || !Array.isArray(policy.models) || !Array.isArray(policy.allowedHosts)) throw new Error('Invalid application model policy')
  const expected = new Map()
  for (const id of value.models) {
    const entries = policy.models.filter(model => model.id === id)
    if (entries.length !== 1 || !Array.isArray(entries[0].files) || !entries[0].files.length) throw new Error('Model set is not defined by the application policy')
    for (const file of entries[0].files) {
      if (expected.has(file.path)) throw new Error('Model policy contains overlapping file inventories')
      expected.set(file.path, file)
    }
  }
  if (value.files.length !== expected.size) throw new Error('Model inventory does not match the application policy')
  const paths = new Set()
  for (const file of value.files) {
    if (!safePath(file.path) || !['huggingface', 'torch', 'audio-separator'].includes(file.path.split('/')[0])
        || file.path.endsWith('.partial') || paths.has(file.path.toLowerCase())
        || !hashPattern.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 0
        || file.executable !== false || !/^[a-f0-9]{40,64}$/.test(file.revision || '')) throw new Error('Invalid model file record')
    paths.add(file.path.toLowerCase())
    const locked = expected.get(file.path)
    if (!locked || ['path', 'revision', 'sha256', 'size', 'url', 'executable'].some(key => file[key] !== locked[key])) {
      throw new Error('Model file differs from the immutable application policy')
    }
    const url = new URL(file.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
        || !policy.allowedHosts.includes(url.hostname) || !url.pathname.split('/').includes(file.revision)) {
      throw new Error('Models require an immutable revision at an approved upstream URL')
    }
  }
  if (!Number.isSafeInteger(value.files.reduce((sum, file) => sum + file.size, 0))) throw new Error('Model cache is too large')
  return value
}

export class ModelCache extends RuntimeManager {
  constructor(root, policy, options) { super(root, {}, options); this.policy = policy }
  validate(manifest) { return validateModelManifest(manifest, this.policy) }
}
