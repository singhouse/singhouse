// SPDX-License-Identifier: AGPL-3.0-only
// Manifests are administrator-selected inputs, not a remotely trusted catalog.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rename, rm, lstat, statfs, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { watchOwnedGroup, forceChild } from './lifecycle.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const token = /^[A-Za-z0-9._+-]{1,128}$/
const offlineSources = Symbol('verified offline model sources')
// Processing archive delivery. The archive carries no paths or headers of its
// own: its uncompressed stream is the concatenation of every manifest file's
// bytes in manifest order, so layout always comes from the validated manifest.
const ARCHIVE_FORMAT = 'concat-gzip-v1'
const MAX_ARCHIVE_PARTS = 64
const MAX_ARCHIVE_PART_SIZE = 2 ** 31 - 1
// The fixed gzip header the format permits: deflate, no optional fields.
const GZIP_HEADER_SIZE = 10, GZIP_TRAILER_SIZE = 8
// Bounded inflater input per step (deflate expands at most ~1032x).
const INFLATE_SLICE = 16 * 1024
// Content errors that the same hash-pinned parts would reproduce on any retry.
const archiveInvalid = Symbol('runtime archive content is invalid')
const invalidArchive = message => Object.assign(new Error(message), { [archiveInvalid]: true })
// Runtime archive redirects may land only on these explicit release-asset
// endpoints (HTTPS port 443); the first request goes to the manifest's URL.
const runtimeTransferHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const redirectStatuses = [301, 302, 303, 307, 308]
// Explicit upstream endpoints; do not permit arbitrary subdomains or ports.
// Hugging Face Hub's documented proxy/firewall endpoints (HTTPS port 443).
const modelTransferHosts = new Set(['huggingface.co', 'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co',
  'cas-bridge.xethub.hf.co', 'cas-server.xethub.hf.co', 'cas-server.xethub-eu.hf.co',
  'transfer.xethub.hf.co', 'transfer.xethub-eu.hf.co', 'us.aws.cdn.hf.co', 'us.gcp.cdn.hf.co',
  'github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com',
  'dl.fbaipublicfiles.com', 'download.pytorch.org'])
const safePath = value => typeof value === 'string' && value.length < 512
  && value.split('/').every(part => /^[A-Za-z0-9._+() -]+$/.test(part) && part.trim() === part
    && !['.', '..'].includes(part) && !part.endsWith('.')
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

function sourceUrl(value) {
  let url
  try { url = new URL(typeof value === 'string' ? value : '') } catch { throw new Error('Inputs require local files or HTTPS') }
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Inputs require local files or HTTPS')
  if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') throw new Error('Remote file shares are not supported')
  return url
}

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)

// The archive description is deliberately NOT bound to the input lock: the
// lock fixes the file inventory, while where those bytes are hosted is covered
// by the manifest identity, the application-packaged catalog, and the per-file
// size and hash checks applied to every extracted file before activation.
function validateArchive(archive) {
  if (!exactKeys(archive, ['format', 'parts']) || archive.format !== ARCHIVE_FORMAT
      || !Array.isArray(archive.parts) || !archive.parts.length || archive.parts.length > MAX_ARCHIVE_PARTS) {
    throw new Error('Processing archive description is invalid')
  }
  const urls = new Set()
  for (const part of archive.parts) {
    if (!exactKeys(part, ['sha256', 'size', 'url']) || !hashPattern.test(part.sha256)
        || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > MAX_ARCHIVE_PART_SIZE) {
      throw new Error('Processing archive part is invalid')
    }
    const url = sourceUrl(part.url)
    if (urls.has(url.href)) throw new Error('Processing archive parts must be distinct')
    urls.add(url.href)
  }
  if (!Number.isSafeInteger(archive.parts.reduce((sum, part) => sum + part.size, 0))) throw new Error('Processing archive is too large')
}

export function validateProcessingManifest(value, expected, trustedLocks = []) {
  let inputLock
  try { inputLock = JSON.parse(value?.provenance?.inputLock) } catch { throw new Error('Processing manifest provenance is missing or malformed') }
  if (!value || value.schema !== 1 || value.kind !== 'processing'
      || !((value.probe?.schema === 1 && value.probe?.type === 'python-imports-v1')
        || (value.probe?.schema === 2 && value.probe?.type === 'python-functional-v1'))
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
  if (value.probe.schema === 2 && (JSON.stringify(inputLock.probe) !== JSON.stringify(value.probe)
      || !value.capabilities.length || new Set(value.capabilities).size !== value.capabilities.length
      || (value.accelerator === 'metal' && value.models.some(model => value.modelCapabilities[model] === 'transcription' && model !== 'heart-transcriptor')))) {
    throw new Error('Functional processing probe is not bound to a supported input lock')
  }
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
  // Exactly one delivery form: every file has its own URL (and there is no
  // archive), or an archive is present and no file names a URL.
  const archived = value.archive !== undefined
  if (archived) validateArchive(value.archive)
  const paths = new Set()
  for (const file of value.files) {
    if (!safePath(file.path) || file.path === 'manifest.json' || file.path.endsWith('.partial')
        || paths.has(value.platform === 'linux' ? file.path : file.path.toLowerCase()) || !hashPattern.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.executable !== 'boolean') throw new Error('Invalid processing file record')
    paths.add(value.platform === 'linux' ? file.path : file.path.toLowerCase())
    if (!archived) sourceUrl(file.url)
    else if (Object.hasOwn(file, 'url')) throw new Error('Processing manifest mixes per-file and archive delivery')
  }
  if (!value.files.some(file => file.path === value.python && file.executable)) throw new Error('Pack lacks its managed Python executable')
  const total = value.files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(total)) throw new Error('Processing pack is too large')
  return value
}

export async function checkedFile(path, flags) {
  const file = await open(path, flags | (constants.O_NOFOLLOW || 0), 0o600)
  try {
    const info = await file.stat()
    const named = await lstat(path)
    if (!info.isFile() || !named.isFile() || named.isSymbolicLink()
        || info.ino !== named.ino || info.dev !== named.dev) throw new Error('Runtime file changed while opening it')
    return file
  } catch (error) { await file.close(); throw error }
}

async function fileHash(file, signal) {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false, signal })) hash.update(chunk)
  return hash.digest('hex')
}

export async function checkedRead(path) {
  const file = await checkedFile(path, constants.O_RDONLY)
  try { return await file.readFile('utf8') } finally { await file.close() }
}

export async function runNativeHelper(python, helper, args, { failure = 'Native helper failed', timeout = 60000 } = {}) {
  if (![python, helper].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('The bundled native helper requires absolute application-owned paths')
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ['-I', '-B', helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = '', settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${failure}: timed out`)) }, timeout)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error); else resolveResult(value)
    }
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8')
      if (output.length > 65536) { child.kill('SIGKILL'); finish(new Error(`${failure}: invalid output`)) }
    })
    child.stderr.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-4096) })
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (code !== 0) return finish(new Error(errors.trim() || failure))
      try { finish(null, JSON.parse(output)) } catch { finish(new Error(`${failure}: invalid confirmation`)) }
    })
  })
}

async function plainDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error('Runtime directory must not be a symbolic link')
}

async function stagingAncestors(staging, path) {
  let ancestor = staging
  for (const part of path.split('/').slice(0, -1)) { ancestor = join(ancestor, part); await plainDirectory(ancestor) }
}

const archivePartName = index => `part-${String(index + 1).padStart(3, '0')}.partial`
// A short neutral identifier for progress events: the part's published name.
const archivePartLabel = (url, index) => {
  let name = ''
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()) } catch { /* fall back below */ }
  return /^[A-Za-z0-9._+-]{1,200}$/.test(name) ? name : `archive part ${index + 1}`
}

// The marker that a staging tree was produced by a stream that passed every
// format check. It sits beside the tree, never inside the pack inventory.
async function streamValidated(marker) {
  try {
    const value = JSON.parse(await checkedRead(marker))
    return exactKeys(value, ['format', 'schema']) && value.schema === 1 && value.format === ARCHIVE_FORMAT
  } catch (error) {
    if (error.code && !['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error
    return false
  }
}

// A disk-space estimate only; integrity never depends on what is found here.
async function archiveRemaining(directory, parts) {
  let remaining = 0
  for (const [index, part] of parts.entries()) {
    let present = 0
    try {
      const info = await lstat(join(directory, archivePartName(index)))
      if (info.isFile() && info.size <= part.size) present = info.size
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    remaining += part.size - present
  }
  return remaining
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
    durabilityHelper, nativeBin, directorySync = syncDirectory, activationHook = async () => {}, trustedLocks = [] } = {}) {
    if (!isAbsolute(root)) throw new Error('Runtime store must be absolute')
    this.root = resolve(root)
    this.identity = identity
    this.fetch = fetchImpl
    this.diskFree = diskFree || (async () => { const s = await statfs(this.root); return s.bavail * s.bsize })
    this.progress = progress
    this.lockPython = lockPython
    this.durabilityHelper = durabilityHelper
    this.nativeBin = nativeBin
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

  async probe(active, { timeout, signal } = {}) {
    // Verify again immediately before executing the selected interpreter.
    active = await this.verify(active.id)
    signal?.throwIfAborted()
    const manifest = active.manifest
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']
      .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]))
    const cache = join(this.root, 'probe-cache')
    await plainDirectory(cache)
    Object.assign(env, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1',
      PYTORCH_ENABLE_MPS_FALLBACK: '0', NUMBA_CACHE_DIR: join(cache, 'numba'), HF_HOME: join(cache, 'huggingface'),
      TORCH_HOME: join(cache, 'torch'), TORCHINDUCTOR_CACHE_DIR: join(cache, 'torchinductor'), XDG_CACHE_HOME: cache })
    const functional = manifest.probe.schema === 2
    timeout ??= functional ? 120000 : 30000
    if (functional) {
      if (!this.nativeBin || !isAbsolute(this.nativeBin) || !(await lstat(this.nativeBin)).isDirectory()) {
        throw new Error('The bundled native audio tools are required for functional processing checks')
      }
      for (const name of ['ffmpeg', 'ffprobe']) {
        if (!(await lstat(join(this.nativeBin, name + (process.platform === 'win32' ? '.exe' : '')))).isFile()) {
          throw new Error('The bundled native audio tool is invalid')
        }
      }
      env.PATH = this.nativeBin
    }
    // This fixed source belongs to the integrity-checked application package.
    // Electron's ASAR entries have virtual identities that differ from the
    // extracted descriptors used by open(); read through its archive-aware API.
    const source = functional ? await readFile(new URL('./processing_probe.py', import.meta.url), 'utf8') : PROBE
    signal?.throwIfAborted()
    return new Promise((resolveProbe, reject) => {
      const child = spawn(toNamespacedPath(join(active.directory, manifest.python)), ['-I', '-B', '-c', source, JSON.stringify(manifest.capabilities), manifest.accelerator, JSON.stringify(manifest.probe.modules)],
        { cwd: toNamespacedPath(active.directory), env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
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
          if (result.schema !== manifest.probe.schema || result.hardwareAvailable !== true
              || ['pythonVersion', 'backendVersion', 'lyricsyncVersion', 'accelerator'].some(key => result[key] !== manifest[key])
              || JSON.stringify(result.capabilities) !== JSON.stringify(manifest.capabilities)
              || !result.components || JSON.stringify(Object.keys(result.components).sort()) !== JSON.stringify([...manifest.probe.modules].sort())
              || Object.values(result.components).some(value => typeof value !== 'string' || !value)) throw new Error('Processing runtime self-test did not match its manifest or hardware')
          if (functional && !validFunctionalChecks(result.checks, manifest.capabilities)) {
            throw new Error('Processing functional checks were incomplete')
          }
          resolveProbe({ ...result, verifiedCapabilities: functional ? [...manifest.capabilities] : [], capabilitiesReady: functional })
        } catch (error) { reject(error) }
      })
    })
  }

  async fetchSource(url, options) {
    // The first request goes to the validated manifest URL. Release-asset hosts
    // answer with a redirect to a signed, expiring URL; follow only those to the
    // explicit runtime delivery endpoints. Every call (including a resumed
    // Range request) starts again from the manifest URL, never a cached target.
    if (url.protocol !== 'https:') throw new Error('Runtime sources require HTTPS')
    for (let hops = 0; ; hops++) {
      if (hops && (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
          || !runtimeTransferHosts.has(url.hostname))) throw new Error('Runtime source redirect is not approved')
      options.signal?.throwIfAborted()
      const response = await this.fetch(url, { ...options, redirect: 'manual', credentials: 'omit' })
      if (!redirectStatuses.includes(response.status)) return response
      await response.body?.cancel()
      const location = response.headers?.get('location')
      if (!location || hops >= 5) throw new Error('Runtime source redirect is missing or exceeds the limit')
      url = new URL(location, url)
    }
  }

  async transfer(record, partial, signal, offlineSource, details = {}) {
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
      if (offlineSource) {
        source = offlineSource.createReadStream({ start: offset, autoClose: false, signal })
      } else if (url.protocol === 'file:') {
        localSource = await checkedFile(fileURLToPath(url), constants.O_RDONLY)
        source = localSource.createReadStream({ start: offset, autoClose: false, signal })
      } else {
        const response = await this.fetchSource(url, { signal,
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
        this.progress({ file: record.path, received: size, total: record.size, ...details })
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

  async extractArchive(manifest, staging, archiveDirectory, marker, signal) {
    const { files } = manifest, parts = manifest.archive.parts
    // Resume after a validated extraction: a staged tree is reused only when
    // this exact archive's stream passed every format check (the marker) and
    // every file still verifies. Files never reach staging otherwise.
    const present = []
    for (const record of files) {
      signal.throwIfAborted()
      await stagingAncestors(staging, record.path)
      present.push(await matches(join(staging, record.path), record))
    }
    if (present.every(Boolean) && await streamValidated(marker)) return
    await rm(marker, { force: true })
    await plainDirectory(archiveDirectory)
    for (const [index, part] of parts.entries()) {
      signal.throwIfAborted()
      const record = { path: archivePartLabel(part.url, index), url: part.url, sha256: part.sha256, size: part.size, executable: false }
      await this.transfer(record, join(archiveDirectory, archivePartName(index)), signal, undefined,
        { phase: 'retrieve', part: index + 1, parts: parts.length })
    }
    signal.throwIfAborted()
    try {
      await this.decodeArchive(manifest, staging, archiveDirectory, present, signal)
    } catch (error) {
      if (error?.[archiveInvalid] && !signal.aborted) {
        // These hash-pinned parts can never yield a valid pack. Discard them
        // and everything extracted from them, so no later attempt reuses either.
        await rm(archiveDirectory, { recursive: true, force: true })
        await rm(staging, { recursive: true, force: true })
      }
      throw error
    }
    // Durably record that this staging tree came from a fully validated stream.
    const handle = await checkedFile(marker, constants.O_CREAT | constants.O_RDWR)
    try {
      await handle.truncate(0)
      await handle.writeFile(JSON.stringify({ schema: 1, format: ARCHIVE_FORMAT }))
      await handle.sync()
    } finally { await handle.close() }
    await this.directorySync(dirname(marker))
  }

  async decodeArchive(manifest, staging, archiveDirectory, present, signal) {
    const { files } = manifest, parts = manifest.archive.parts
    // The part sizes fix the stream length, so every byte's role is known by
    // its offset alone: fixed header, raw deflate body, eight-byte trailer.
    const compressedTotal = parts.reduce((sum, part) => sum + part.size, 0)
    if (compressedTotal < GZIP_HEADER_SIZE + GZIP_TRAILER_SIZE) throw invalidArchive('Runtime archive is truncated or corrupt')
    const bodyEnd = compressedTotal - GZIP_TRAILER_SIZE
    const header = Buffer.alloc(GZIP_HEADER_SIZE), trailer = Buffer.alloc(GZIP_TRAILER_SIZE)

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    let index = 0, current = null, produced = 0, checksum = 0, reported = 0
    const report = () => {
      reported = produced
      this.progress({ file: current?.record.path ?? files.at(-1).path, received: produced, total: totalBytes, phase: 'extract' })
    }
    const begin = async () => {
      const record = files[index]
      if (present[index]) return { record, written: 0 }
      // Re-check ancestors immediately before opening, as per-file retrieval does.
      await stagingAncestors(staging, record.path)
      const partial = join(staging, record.path) + '.partial'
      const handle = await checkedFile(partial, constants.O_CREAT | constants.O_RDWR)
      try { await handle.truncate(0) } catch (error) { await handle.close(); throw error }
      return { record, written: 0, partial, handle, hash: createHash('sha256') }
    }
    const finish = async entry => {
      current = null
      index++
      if (!entry.handle) return
      const { record, partial, handle } = entry
      try {
        if (entry.written !== record.size || entry.hash.digest('hex') !== record.sha256) {
          await handle.truncate(0)
          throw invalidArchive('Runtime archive checksum or size mismatch; previous runtime preserved')
        }
        await handle.chmod(record.executable ? 0o700 : 0o600)
        await handle.sync()
        const named = await lstat(partial), owned = await handle.stat()
        if (!named.isFile() || named.isSymbolicLink() || named.ino !== owned.ino || named.dev !== owned.dev) {
          throw new Error('Runtime partial path changed during extraction')
        }
      } finally { await handle.close() }
      signal.throwIfAborted()
      await rename(partial, join(staging, record.path))
    }
    // Opens the next file needing bytes; zero-length files complete at once.
    const advance = async () => {
      while (index < files.length) {
        current = await begin()
        if (current.record.size) return
        await finish(current)
      }
    }
    const consume = async chunk => {
      checksum = zlib.crc32(chunk, checksum)
      produced += chunk.length
      while (chunk.length) {
        if (!current) throw invalidArchive('Runtime archive has unexpected trailing data')
        const take = Math.min(chunk.length, current.record.size - current.written)
        const slice = chunk.subarray(0, take)
        if (current.handle) {
          current.hash.update(slice)
          let written = 0
          while (written < slice.length) {
            const result = await current.handle.write(slice, written, slice.length - written, current.written + written)
            if (!result.bytesWritten) throw new Error('Runtime archive extraction write made no progress')
            written += result.bytesWritten
          }
        }
        current.written += take
        chunk = chunk.subarray(take)
        if (current.written === current.record.size) { await finish(current); await advance() }
      }
      if (produced - reported >= 8 * 1024 * 1024) report()
    }

    // The inflater is driven one bounded slice at a time and never sees a byte
    // outside the deflate body. After each slice it must have consumed all of
    // it; a deflate stream that ends early leaves input unconsumed, which is
    // data between the deflate end and the trailer (e.g. a second member).
    const inflater = zlib.createInflateRaw()
    const output = []
    let inflateError, fed = 0
    inflater.on('data', chunk => output.push(chunk))
    inflater.on('error', error => { inflateError ??= error })
    const ended = new Promise(resolveEnd => { inflater.once('end', resolveEnd); inflater.once('error', resolveEnd) })
    const drain = async () => {
      while (output.length) { signal.throwIfAborted(); await consume(output.shift()) }
    }
    const inflate = async slice => {
      const error = await new Promise(resolveWrite => inflater.write(slice, resolveWrite))
      fed += slice.length
      if (error || inflateError) throw invalidArchive('Runtime archive is truncated or corrupt')
      if (inflater.bytesWritten !== fed) throw invalidArchive('Runtime archive has unexpected trailing data')
      await drain()
    }
    try {
      await advance()
      let offset = 0
      // Parts are read from fresh no-follow descriptors in manifest order and
      // hashed again here, so the validated stream is exactly the pinned parts.
      for (const [partIndex, part] of parts.entries()) {
        const file = await checkedFile(join(archiveDirectory, archivePartName(partIndex)), constants.O_RDONLY)
        try {
          if ((await file.stat()).size !== part.size) throw invalidArchive('Runtime archive part changed before extraction')
          const hash = createHash('sha256')
          let read = 0
          for await (const chunk of file.createReadStream({ start: 0, autoClose: false, signal })) {
            signal.throwIfAborted()
            read += chunk.length
            if (read > part.size) throw invalidArchive('Runtime archive part changed before extraction')
            hash.update(chunk)
            for (let position = 0; position < chunk.length;) {
              const at = offset + position
              if (at < GZIP_HEADER_SIZE) {
                const take = Math.min(chunk.length - position, GZIP_HEADER_SIZE - at)
                chunk.copy(header, at, position, position + take)
                position += take
                // The fixed header the format permits: deflate, no optional fields.
                if (at + take === GZIP_HEADER_SIZE && (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || header[3] !== 0)) {
                  throw invalidArchive('Runtime archive format is invalid')
                }
              } else if (at < bodyEnd) {
                const take = Math.min(chunk.length - position, bodyEnd - at, INFLATE_SLICE)
                await inflate(chunk.subarray(position, position + take))
                position += take
              } else {
                position += chunk.copy(trailer, at - bodyEnd, position)
              }
            }
            offset += chunk.length
          }
          if (read !== part.size || hash.digest('hex') !== part.sha256) throw invalidArchive('Runtime archive part changed before extraction')
        } finally { await file.close() }
      }
      // The body is exhausted: the deflate stream must be complete right here.
      inflater.end()
      await ended
      if (inflateError || inflater.bytesWritten !== fed) throw invalidArchive('Runtime archive is truncated or corrupt')
      await drain()
    } finally {
      inflater.destroy()
      await current?.handle?.close().catch(() => {})
    }
    if (current || index < files.length) throw invalidArchive('Runtime archive ended before every file was extracted')
    if (trailer.readUInt32LE(0) !== checksum >>> 0 || trailer.readUInt32LE(4) !== produced % 2 ** 32) {
      throw invalidArchive('Runtime archive is truncated or corrupt')
    }
    report()
  }

  async install(manifest, { signal, probeTimeout, [offlineSources]: sources } = {}) {
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
      const archive = manifest.kind === 'processing' ? manifest.archive : undefined
      const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
      const packs = join(this.root, 'packs'), staging = join(this.root, 'staging', id)
      // Archive parts live beside, never inside, the pack tree: `<id>.archive`
      // cannot equal any hex `<id>`, and the staging inventory stays exact.
      const archiveDirectory = join(this.root, 'staging', `${id}.archive`)
      const streamMarker = join(this.root, 'staging', `${id}.stream`)
      // Archive form: the remaining compressed parts and the full extracted tree
      // coexist until every file verifies (parts are removed only afterwards);
      // activation renames staging, so no third copy is made. Already retrieved
      // part bytes are discounted; extracted bytes are not, which errs high.
      const required = archive ? await archiveRemaining(archiveDirectory, archive.parts) + bytes : bytes * 2
      if (await this.diskFree() < required + 64 * 1024 * 1024) throw new Error('Not enough disk space for retrieval and activation; previous runtime preserved')
      await plainDirectory(packs)
      await plainDirectory(join(this.root, 'staging'))
      await plainDirectory(staging)
      if (archive) await this.extractArchive(manifest, staging, archiveDirectory, streamMarker, signal)
      for (const record of manifest.files) {
        signal?.throwIfAborted()
        const destination = join(staging, record.path)
        // Validate each ancestor so a pre-existing symlink cannot escape staging.
        await stagingAncestors(staging, record.path)
        if (!archive && !await matches(destination, record)) {
          await this.transfer(record, destination + '.partial', signal, sources?.get(record.path))
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
      // Every file is verified in staging; the compressed parts are no longer
      // needed. A crash before this point retries from the retained parts.
      if (archive) await rm(archiveDirectory, { recursive: true, force: true })
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
      if (existing) {
        let damaged = false
        try { await this.verify(id) }
        catch (error) {
          if (manifest.kind !== 'models' || (error.code && error.code !== 'ENOENT')) throw error
          // Repair only ordinary model trees. Unsafe links or special files
          // still require operator attention; never move or overwrite them.
          const info = await lstat(destination)
          if (!info.isDirectory() || info.isSymbolicLink()) throw error
          await inventory(destination)
          damaged = true
        }
        if (damaged) {
          const allowed = new Set(['manifest.json', ...manifest.files.map(file => file.path)])
          const present = await inventory(staging)
          if (present.length !== allowed.size || present.some(path => !allowed.has(path))) throw new Error('Repair inventory does not match its manifest')
          const quarantine = join(this.root, 'quarantine')
          await plainDirectory(quarantine)
          const retained = await mkdtemp(join(quarantine, `${id}-`))
          signal.throwIfAborted()
          // Keep damaged evidence and the previous pointer slots intact. If
          // interrupted here, a retry can finish from the verified staging tree.
          await this.durableReplace(destination, join(retained, 'pack'))
          await this.activationHook('model-quarantined')
          signal.throwIfAborted()
          await this.durableReplace(staging, destination)
        } else await this.durableReplace(destination, destination)
      } else await this.durableReplace(staging, destination)
      if (archive) await rm(streamMarker, { force: true })
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
    // Bound both open descriptors and streaming hash buffers. Every file still
    // checks its ancestors independently; nothing is cached across verifications.
    let next = 0, failure
    const worker = async () => {
      while (!failure && next < manifest.files.length) {
        const file = manifest.files[next++]
        try {
          let ancestor = directory
          for (const part of file.path.split('/').slice(0, -1)) {
            ancestor = join(ancestor, part)
            const info = await lstat(ancestor)
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid runtime directory')
          }
          if (!await matches(join(directory, file.path), file)) throw new Error('Installed runtime verification failed')
        } catch (error) { failure ??= error }
      }
    }
    // Workers catch failures so all in-flight checks close their handles before
    // rejection (and before active() can try a different runtime).
    await Promise.all(Array.from({ length: Math.min(4, manifest.files.length) }, worker))
    if (failure) throw failure
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

function validFunctionalChecks(checks, capabilities) {
  const names = ['deviceTensor', 'nativeAudio', ...capabilities].sort()
  return checks && typeof checks === 'object' && !Array.isArray(checks)
    && JSON.stringify(Object.keys(checks).sort()) === JSON.stringify(names)
    && Object.values(checks).every(value => value === true)
}

export function processingAttestation(active, probeResult) {
  const manifest = active.manifest
  const functional = manifest.probe.schema === 2
  const pythonRecord = manifest.files.find(file => file.path === manifest.python)
  if (!pythonRecord || probeResult?.schema !== manifest.probe.schema || probeResult.accelerator !== manifest.accelerator
      || !probeResult.components || typeof probeResult.components !== 'object' || Array.isArray(probeResult.components)
      || JSON.stringify(Object.keys(probeResult.components).sort()) !== JSON.stringify([...manifest.probe.modules].sort())
      || Object.values(probeResult.components).some(value => typeof value !== 'string' || !value)
      || probeResult.capabilitiesReady !== functional || !Array.isArray(probeResult.verifiedCapabilities)
      || JSON.stringify(probeResult.verifiedCapabilities) !== JSON.stringify(functional ? manifest.capabilities : [])
      || (functional && (probeResult.hardwareAvailable !== true
          || ['pythonVersion', 'backendVersion', 'lyricsyncVersion'].some(key => probeResult[key] !== manifest[key])
          || JSON.stringify(probeResult.capabilities) !== JSON.stringify(manifest.capabilities)
          || !validFunctionalChecks(probeResult.checks, manifest.capabilities)))) {
    throw new Error('Invalid processing probe attestation')
  }
  return {
    runtimeManifestId: active.id,
    pythonPath: toNamespacedPath(join(active.directory, manifest.python)),
    pythonSha256: pythonRecord.sha256,
    probePassed: true,
    accelerator: probeResult.accelerator,
    components: Object.fromEntries(Object.entries(probeResult.components).sort(([a], [b]) => a.localeCompare(b))),
    verifiedCapabilities: probeResult.verifiedCapabilities,
    capabilitiesReady: probeResult.capabilitiesReady,
    ...(functional ? { probeSchema: 2, checks: probeResult.checks } : {}),
  }
}

export function validateModelManifest(value, policy) {
  if (!value || value.schema !== 1 || value.kind !== 'models' || value.archive !== undefined
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
        || file.executable !== false || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.revision || '')) throw new Error('Invalid model file record')
    paths.add(file.path.toLowerCase())
    const locked = expected.get(file.path)
    if (!locked || ['path', 'revision', 'sha256', 'size', 'url', 'executable'].some(key => file[key] !== locked[key])) {
      throw new Error('Model file differs from the immutable application policy')
    }
    const url = new URL(file.url)
    const pinnedDigest = file.revision === file.sha256 && hashPattern.test(file.revision)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
        || !policy.allowedHosts.includes(url.hostname)
        || !(pinnedDigest || url.pathname.split('/').includes(file.revision))) {
      throw new Error('Models require an immutable revision at an approved upstream URL')
    }
  }
  if (!Number.isSafeInteger(value.files.reduce((sum, file) => sum + file.size, 0))) throw new Error('Model cache is too large')
  return value
}

export class ModelCache extends RuntimeManager {
  constructor(root, policy, options) { super(root, {}, options); this.policy = policy }
  validate(manifest) { return validateModelManifest(manifest, this.policy) }

  async install(manifest, options = {}) {
    this.validate(manifest)
    manifest = structuredClone(manifest)
    // Growing a verified cache must not retrieve the already installed models
    // again. Copy from held, hash-checked descriptors; never hard-link writable
    // staging to the previous known-good pack.
    const active = await this.active().catch(() => null)
    const sourceDirectory = active ? await realpath(active.directory) : null
    const sources = new Map()
    try {
      for (const record of manifest.files) {
        if (!active?.manifest.files.some(file => file.path === record.path && file.sha256 === record.sha256 && file.size === record.size)) continue
        options.signal?.throwIfAborted()
        const ancestors = []
        let path = dirname(join(sourceDirectory, record.path))
        for (;;) {
          const info = await lstat(path)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed model source has an unsafe directory')
          ancestors.push({ path, info })
          if (dirname(path) === path) break
          path = dirname(path)
        }
        const source = await checkedFile(join(sourceDirectory, record.path), constants.O_RDONLY)
        sources.set(record.path, source)
        for (const ancestor of ancestors) {
          const info = await lstat(ancestor.path)
          if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== ancestor.info.ino || info.dev !== ancestor.info.dev) {
            throw new Error('Installed model source changed while opening it')
          }
        }
        if ((await source.stat()).size !== record.size || await fileHash(source, options.signal) !== record.sha256) {
          throw new Error('Installed model source changed before reuse')
        }
      }
      return await super.install(manifest, { ...options, [offlineSources]: sources })
    } finally { await Promise.all([...sources.values()].map(source => source.close())) }
  }

  async selectionForRepair() {
    // This is inventory evidence for repair, never readiness or runnable bytes.
    const pointers = await this.readPointers()
    for (const { id } of pointers) {
      // A repair interrupted after quarantine retains the trusted manifest in
      // staging, even though the pointer's original pack path is now absent.
      for (const area of ['packs', 'staging']) {
        try {
          const directory = join(this.root, area, id)
          for (const path of [this.root, join(this.root, area), directory]) {
            const info = await lstat(path)
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid model repair directory')
          }
          const raw = await checkedRead(join(directory, 'manifest.json'))
          if (digest(raw) !== id) throw new Error('Model repair manifest was modified')
          const manifest = this.validate(JSON.parse(raw))
          return { id, directory, manifest }
        } catch { /* Only an intact policy-bound manifest can preserve a selection. */ }
      }
    }
    return null
  }

  async fetchSource(url, options) {
    // Policy validation binds the original URL and bytes; redirects may use
    // only these explicit upstream delivery endpoints, never arbitrary hosts.
    for (let hops = 0; ; hops++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
          || !modelTransferHosts.has(url.hostname)) throw new Error('Model source redirect is not approved')
      options.signal?.throwIfAborted()
      const response = await this.fetch(url, { ...options, redirect: 'manual', credentials: 'omit' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || hops >= 5) throw new Error('Model source redirect is missing or exceeds the limit')
      url = new URL(location, url)
    }
  }

  async installFromDirectory(manifest, directory, { prefix, ...options } = {}) {
    this.validate(manifest)
    manifest = structuredClone(manifest)
    if (typeof directory !== 'string' || !isAbsolute(directory) || (prefix !== '' && !safePath(prefix))
        || (prefix !== '' && manifest.files.some(file => !file.path.startsWith(prefix + '/')))) {
      throw new Error('Offline model directory requires an absolute path and matching model prefix')
    }
    directory = resolve(directory)
    const selected = await lstat(directory)
    if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('Offline model directory must not contain symbolic links')
    // Canonicalize OS-owned aliases above the selected directory (e.g. macOS
    // /var), while rejecting links at or inside the selected model directory.
    directory = await realpath(directory)
    const canonical = await lstat(directory)
    if (!canonical.isDirectory() || canonical.isSymbolicLink() || selected.ino !== canonical.ino || selected.dev !== canonical.dev) {
      throw new Error('Offline model directory changed while opening it')
    }
    const sources = new Map()
    try {
      for (const record of manifest.files) {
        options.signal?.throwIfAborted()
        const relative = prefix === '' ? record.path : record.path.slice(prefix.length + 1)
        // Snapshot every ancestor, including the chosen directory's ancestors.
        // Hold checked file descriptors through activation so path replacement
        // cannot switch the source after validation.
        const ancestors = []
        let path = dirname(join(directory, relative))
        for (;;) {
          const info = await lstat(path)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Offline model directory must not contain symbolic links')
          ancestors.push({ path, info })
          if (dirname(path) === path) break
          path = dirname(path)
        }
        const source = await checkedFile(join(directory, relative), constants.O_RDONLY)
        sources.set(record.path, source)
        for (const ancestor of ancestors) {
          const info = await lstat(ancestor.path)
          if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== ancestor.info.ino || info.dev !== ancestor.info.dev) {
            throw new Error('Offline model directory changed while opening it')
          }
        }
        if ((await source.stat()).size !== record.size || await fileHash(source, options.signal) !== record.sha256) {
          throw new Error('Offline model source checksum or size mismatch')
        }
      }
      return await super.install(manifest, { ...options, [offlineSources]: sources })
    } finally { await Promise.all([...sources.values()].map(source => source.close())) }
  }
}
