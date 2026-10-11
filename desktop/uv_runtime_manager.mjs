// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { mkdir, lstat, readdir, readlink, realpath, symlink, rm, writeFile, copyFile, rename } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { RuntimeManager, acquireInstallLock, checkedRead, checkedFile } from './runtime_manager.mjs'
import { validateProcessingRecipe, recipeDigest, recipeTransferBytes } from './processing_recipe.mjs'
import { watchOwnedGroup, forceChild } from './lifecycle.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => path !== root && path.startsWith(root + sep)
const marker = '@SINGHOUSE_RUNTIME_ROOT@'
async function fileDigest(file, signal) {
  const hash = createHash('sha256')
  for await (const bytes of file.createReadStream({ autoClose:false, signal })) hash.update(bytes)
  return hash.digest('hex')
}
async function directory(path) {
  const parent = dirname(path)
  if (parent !== path) {
    try { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe processing directory') }
    catch (error) { if (error.code !== 'ENOENT') throw error; await directory(parent) }
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe processing directory')
}
async function ancestors(root, name) {
  let at = root
  for (const part of name.split('/').slice(0,-1)) {
    at = join(at,part)
    const info = await lstat(at)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe processing file ancestor')
  }
}
async function entries(root, at = root) {
  const result = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isDirectory()) result.push(...await entries(root, path))
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(relative(root, path).split(sep).join('/'))
    else throw new Error('Unsafe processing environment entry')
  }
  return result.sort()
}
export function normalizedPythonConfig(bytes, root) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes(marker) || text.includes('\0')) throw new Error('Invalid managed environment configuration')
  // Only uv's small line-oriented venv configuration may contain installation paths.
  if (text.length > 16384 || text.split(/\r?\n/).filter(Boolean).some(line => !/^[a-z][a-z0-9_-]* = [^\r\n]*$/.test(line))) throw new Error('Invalid managed environment configuration')
  return Buffer.from(text.split(root).join(marker))
}
export async function finalizeEnvironment(root, platform = process.platform) {
  const env = join(root, 'env'), scripts = join(env, platform === 'win32' ? 'Scripts' : 'bin')
  for (const name of await readdir(scripts)) if (!/^python(?:\d+(?:\.\d+)?)?(?:w)?(?:\.exe)?$/.test(name)) await rm(join(scripts, name), { recursive: true, force: true })
  async function clean(at) {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || (at.endsWith('.dist-info') && ['RECORD','direct_url.json','uv_cache.json'].includes(entry.name))) await rm(path, { recursive: true, force: true })
      else if (entry.isDirectory()) await clean(path)
    }
  }
  await clean(env)
  for (const name of await entries(root)) {
    const path = join(root, name), info = await lstat(path)
    if (info.isFile() && info.nlink > 1) {
      // uv may fall back from cloning to hardlinks. A mutable shared cache
      // must never share an inode with an activated processing generation.
      const detached = path + `.detach-${randomBytes(8).toString('hex')}`
      await copyFile(path,detached,constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      await rename(detached,path)
    } else if (info.isSymbolicLink()) {
      const target = await realpath(path)
      if (!inside(root, target)) throw new Error('Processing environment link escapes its installation')
      const targetName = relative(dirname(path), target).split(sep).join('/')
      await rm(path); await symlink(targetName, path)
    }
  }
}
const EXTRACT = `import pathlib, sys, tarfile, zipfile, shutil, os
source, destination, kind = sys.argv[1:]
root = pathlib.Path(destination).resolve()
root.mkdir(parents=True, exist_ok=True)
def target(name):
    if '\\\\' in name or ':' in name: raise ValueError('unsafe archive name')
    p = pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts: raise ValueError('unsafe archive path')
    out = root.joinpath(*p.parts)
    if not out.resolve().is_relative_to(root): raise ValueError('unsafe archive path')
    return out
links = []
seen = set()
if kind == 'tar.gz':
    with tarfile.open(source, 'r:gz') as archive:
        for item in archive:
            out = target(item.name)
            if item.isdir(): out.mkdir(parents=True, exist_ok=True); continue
            key = str(out).casefold() if os.name == 'nt' else str(out)
            if key in seen: raise ValueError('duplicate archive file')
            seen.add(key)
            out.parent.mkdir(parents=True, exist_ok=True)
            if item.issym(): links.append((out, item.linkname, False)); continue
            if item.islnk(): links.append((out, item.linkname, True)); continue
            if not item.isfile(): raise ValueError('unsafe archive type')
            with archive.extractfile(item) as src, out.open('xb') as dst: shutil.copyfileobj(src, dst)
            out.chmod(0o700 if item.mode & 0o111 else 0o600)
else:
    with zipfile.ZipFile(source) as archive:
        for item in archive.infolist():
            out = target(item.filename)
            if item.is_dir(): out.mkdir(parents=True, exist_ok=True); continue
            if item.external_attr >> 16 & 0o170000 == 0o120000: raise ValueError('zip links unsupported')
            out.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as src, out.open('xb') as dst: shutil.copyfileobj(src, dst)
            out.chmod(0o700 if item.external_attr >> 16 & 0o111 else 0o600)
for out, name, hard in links:
    link = target(name) if hard else (out.parent / name).resolve()
    if not link.resolve().is_relative_to(root): raise ValueError('archive link escapes')
    if hard: shutil.copyfile(link, out)
    else: out.symlink_to(os.path.relpath(link, out.parent))
`
export class UvRuntimeManager extends RuntimeManager {
  constructor(root, identity, options = {}) {
    super(root, identity, options)
    this.uvPath = options.uvPath
    this.nativeLockSha256 = options.nativeLockSha256
    this.allowLocalRecipeSources = options.allowLocalRecipeSources === true
  }
  validate(manifest) {
    if (manifest?.schema !== 2) return super.validate(manifest)
    if (!/^[a-f0-9]{64}$/.test(this.nativeLockSha256 || '')) throw new Error('Bundled native tool provenance is unavailable')
    return validateProcessingRecipe(manifest, this.identity, this.trustedLocks, { local:this.allowLocalRecipeSources,nativeLockSha256:this.nativeLockSha256 })
  }
  async command(executable, args, { cwd, signal, cache, timeout = 600000 } = {}) {
    signal?.throwIfAborted()
    const env = Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]))
    Object.assign(env, { PATH: dirname(executable), UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_CACHE_DIR: cache || join(this.root,'uv-cache'), PYTHONDONTWRITEBYTECODE: '1', UV_NO_PROGRESS: '1' })
    return new Promise((resolveRun, reject) => {
      const child = spawn(executable, args, { cwd, env, stdio: ['ignore','pipe','pipe'], windowsHide: true, detached: process.platform !== 'win32' })
      if (process.platform !== 'win32') watchOwnedGroup(child)
      let failure, output = '', diagnostic = ''
      const stop = error => { failure = error; try { forceChild(child) } catch (err) { failure = err } }
      const abort = () => stop(new Error('Processing installation cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => stop(new Error('Processing installation timed out')), timeout)
      child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-4096) })
      child.stderr.on('data', bytes => { diagnostic = (diagnostic+bytes.toString()).slice(-4096) })
      child.once('error', error => { failure = new Error(`Bundled processing command could not start (${error.code || 'unknown error'})`) })
      child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort',abort); if (failure || code !== 0) { this.lastCommandFailure = { stage:args[0],code,diagnostic }; reject(failure || new Error(`Processing ${args[0] === 'venv' ? 'environment creation' : args[0] === 'pip' ? 'package installation' : 'installer command'} failed (exit ${code}). Retry setup to repair the verified inputs.`)) } else resolveRun(output.trim()) })
    })
  }
  async verifiedUv(manifest, options) {
    if (!isAbsolute(this.uvPath || '')) throw new Error('The bundled processing installer is unavailable')
    const file = await checkedFile(this.uvPath, constants.O_RDONLY)
    try { if (await fileDigest(file) !== manifest.recipe.uv.sha256) throw new Error('Bundled processing installer integrity check failed') } finally { await file.close() }
    if (!(await this.command(this.uvPath, ['--version'], options)).match(new RegExp(`^uv ${manifest.recipe.uv.version.replaceAll('.', '\\.')}($| )`))) throw new Error('Bundled processing installer version does not match recipe')
  }
  async verifyFiles(root,files,{ quick = false, observed = null, signal } = {}) {
    for (const record of files) {
      signal?.throwIfAborted()
      if (!quick || !observed) await ancestors(root,record.path)
      const path = join(root,record.path), info = observed?.get(record.path) || await lstat(path)
      if (record.target !== undefined) {
        if (!info.isSymbolicLink() || readlinkSync(path).split(sep).join('/') !== record.target || !inside(root,realpathSync(path))) throw new Error('Processing installation link changed')
      } else {
        if (!info.isFile() || (process.platform !== 'win32' && Boolean(info.mode & 0o111) !== record.executable)) throw new Error('Processing installation file changed')
        if (quick && record.kind !== 'uv-path-text') {
          if (info.size !== record.size) throw new Error('Processing installation file changed')
          continue
        }
        const file = await checkedFile(path, constants.O_RDONLY)
        try {
          let size = info.size, checksum
          if (record.kind === 'uv-path-text') { const bytes = normalizedPythonConfig(await file.readFile(), root); size = bytes.length; checksum = sha(bytes) }
          else checksum = await fileDigest(file, signal)
          if (size !== record.size || checksum !== record.sha256 || (process.platform !== 'win32' && Boolean(info.mode & 0o111) !== record.executable)) throw new Error('Processing installation file changed')
        } finally { await file.close() }
      }
    }
  }
  async verifyTree(id, quick = false, { signal } = {}) {
    signal?.throwIfAborted()
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid processing installation identity')
    const root = join(this.root,'envs',this.directoryName(id))
    try { await lstat(root) } catch (error) { if (error.code === 'ENOENT') return super.verifyTree(id, quick, { signal }); throw error }
    for (const at of [this.root,join(this.root,'envs'),root]) { const info = await lstat(at); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid processing installation directory') }
    const manifest = this.validate(JSON.parse(await checkedRead(join(root,'manifest.json'))))
    if (manifest.schema !== 2) throw new Error('Invalid processing recipe installation')
    const receipt = JSON.parse(await checkedRead(join(root,'receipt.json')))
    const recipeId = recipeDigest(manifest)
    if (receipt.schema !== 1 || receipt.kind !== 'processing-installation' || receipt.recipeId !== recipeId || receipt.id !== id
        || !/^[a-f0-9]{32}$/.test(receipt.nonce || '') || recipeDigest({ recipeId, nonce: receipt.nonce }) !== id || receipt.directory !== root || await realpath(root) !== root) throw new Error('Processing installation receipt changed')
    const files = manifest.recipe.files
    const expected = ['manifest.json','receipt.json',...files.map(file => file.path)].sort()
    // One non-following walk supplies structural facts for the launch check.
    const observed = new Map()
    let since = performance.now()
    const walk = async at => {
      for (const name of readdirSync(at)) {
        signal?.throwIfAborted()
        const path = join(at,name), info = lstatSync(path)
        if (info.isDirectory()) await walk(path)
        else if (info.isFile() || info.isSymbolicLink()) observed.set(relative(root,path).split(sep).join('/'),info)
        else throw new Error('Unsafe processing environment entry')
        if (performance.now() - since > 8) {
          await new Promise(resolveTurn => setImmediate(resolveTurn))
          since = performance.now()
        }
      }
    }
    await walk(root)
    if (JSON.stringify([...observed.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Processing installation inventory changed')
    await this.verifyFiles(root,files,{ quick, observed, signal })
    const python = await realpath(join(root,manifest.python))
    if (!inside(root, python)) throw new Error('Processing interpreter escapes installation')
    const pythonRecord = files.find(record => record.path === relative(root,python).split(sep).join('/'))
    if (!pythonRecord?.sha256 || pythonRecord.target !== undefined || pythonRecord.kind) throw new Error('Processing interpreter has no trusted file record')
    const pythonSha256 = pythonRecord.sha256
    return { id, recipeId, directory: root, manifest, installedFiles: [{ path:manifest.python, sha256:pythonSha256 }] }
  }
  async install(manifest, options = {}) {
    try { return await this.installAttempt(manifest,options) }
    catch (error) {
      if (!error.processingCacheMismatch || options.refreshCache || options.signal?.aborted) throw error
      // One deterministic repair from retained hash-verified inputs. Neither
      // an inventory failure nor a repair attempt can switch the active slot.
      return this.installAttempt(manifest,{...options,refreshCache:true,offline:true})
    }
  }
  async installAttempt(manifest, { signal, probeTimeout, refreshCache = false, offline = false } = {}) {
    if (manifest?.schema !== 2) return super.install(manifest, { signal, probeTimeout })
    manifest = structuredClone(this.validate(manifest))
    await directory(this.root)
    const lock = await acquireInstallLock(join(this.root,'install.lock'),this.lockPython)
    signal = signal ? AbortSignal.any([signal,lock.signal]) : lock.signal
    this.busy = true
    try {
      signal.throwIfAborted()
      const recipeId = recipeDigest(manifest)
      // Reuse only a fully verified installation; repair creates a fresh stable
      // generation and never alters a directory an existing worker might use.
      const active = await this.active().catch(() => null)
      if (active?.recipeId === recipeId) { await this.probe(active,{ signal,timeout:probeTimeout }); return active }
      if (await this.diskFree() < recipeTransferBytes(manifest) + manifest.recipe.installedSize * 2 + 64 * 1024 * 1024) throw new Error('Not enough disk space for processing installation; previous runtime preserved')
      await this.verifiedUv(manifest,{ signal })
      const nonce = randomBytes(16).toString('hex'), id = recipeDigest({ recipeId,nonce })
      const root = join(this.root,'envs',this.directoryName(id))
      await directory(join(this.root,'envs'))
      await mkdir(root,{ mode:0o700 })
      // The bounded pending attempt owns its verified artifact references from
      // the first transfer, so cancellation preserves reusable partial bytes.
      // No receipt or pointer exists yet; verify() cannot admit this tree.
      const pendingManifest = await checkedFile(join(root,'manifest.json'),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR)
      try { await pendingManifest.writeFile(JSON.stringify(manifest)); await pendingManifest.sync() } finally { await pendingManifest.close() }
      await this.directorySync(root)
      await this.directorySync(join(this.root,'envs'))
      const work = join(this.root,'recipe-cache',recipeId)
      await directory(work)
      const cache = join(this.root,'uv-cache'); await directory(cache)
      const options = { cwd:work,signal,cache }
      const retrieve = async (record,path) => {
        await directory(dirname(path))
        if (offline) {
          let valid = false, file
          try { file = await checkedFile(path,constants.O_RDONLY); valid = (await file.stat()).size === record.size && await fileDigest(file) === record.sha256 } catch {} finally { await file?.close() }
          if (!valid) throw new Error('Offline processing repair needs a missing or damaged installer file. Reconnect and retry setup to retrieve the verified inputs.')
          return
        }
        await this.transfer(record,path,signal)
      }
      const artifactPath = (record,filename) => join(this.root,'artifacts',record.sha256,filename)
      const pythonArchive = artifactPath(manifest.recipe.python,'python.archive')
      await retrieve(manifest.recipe.python,pythonArchive)
      for (const wheel of manifest.recipe.wheels) {
        await retrieve(wheel,artifactPath(wheel,wheel.filename))
        for (const notice of wheel.notices) {
          const cached = artifactPath(notice,notice.filename), destination = join(root,'notices',wheel.name,notice.filename)
          await retrieve(notice,cached)
          await directory(dirname(destination))
          await copyFile(cached,destination,constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        }
      }
      signal.throwIfAborted()
      await this.command(this.lockPython,['-I','-B','-c',EXTRACT,pythonArchive,root,manifest.recipe.python.archive],options)
      const baseFiles = manifest.recipe.files.filter(file => file.path.startsWith('python/'))
      if (!baseFiles.length || JSON.stringify((await entries(join(root,'python'))).map(name => 'python/'+name)) !== JSON.stringify(baseFiles.map(file => file.path).sort())) throw new Error('Managed Python artifact inventory changed')
      await this.verifyFiles(root,baseFiles)
      const basePython = join(root,manifest.recipe.python.member)
      if (!inside(root,await realpath(basePython))) throw new Error('Managed Python artifact escapes installation')
      await this.command(this.uvPath,['venv','--no-project','--no-config','--offline','--no-python-downloads','--python',basePython,'--prompt','singhouse',join(root,'env')],options)
      const requirements = join(work,'requirements.txt')
      await writeFile(requirements,manifest.recipe.wheels.map(wheel => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join('\n')+'\n',{ mode:0o600 })
      let verified
      const verificationGeneration = this.recordGeneration(id)
      try {
      if (refreshCache) await this.command(this.uvPath,['cache','clean','--no-config','--offline','--cache-dir',cache,...manifest.recipe.wheels.map(wheel => wheel.name)],options)
      await this.command(this.uvPath,['pip','install','--no-config','--offline','--no-python-downloads','--python',join(root,manifest.python),'--no-index',...manifest.recipe.wheels.flatMap(wheel => ['--find-links',dirname(artifactPath(wheel,wheel.filename))]),'--no-deps','--no-build','--require-hashes','--link-mode','clone','--requirements',requirements],options)
      await finalizeEnvironment(root,manifest.platform)
      // Restore the release inventory's permissions without changing bytes.
      for (const record of manifest.recipe.files) if (record.target === undefined) {
        await ancestors(root,record.path)
        const file = await checkedFile(join(root,record.path),constants.O_RDONLY)
        try { await file.chmod(record.executable ? 0o700 : 0o600) } finally { await file.close() }
      }
      await writeFile(join(root,'receipt.json'),JSON.stringify({ schema:1,kind:'processing-installation',id,recipeId,nonce,directory:root }),{ flag:'wx',mode:0o600 })
      verified = await this.verify(id, { signal })
      } catch (error) {
        // Every source artifact and the base interpreter has already passed its
        // pinned checks. Missing/corrupt extracted wheel cache members can fail
        // installation, finalization or verification; rebuild that derived
        // cache once in all three cases, while preserving both pointer slots.
        if (signal.aborted || ['ENOSPC','EACCES','EPERM'].includes(error.code)) throw error
        throw Object.assign(error,{processingCacheMismatch:true})
      }
      await this.probe(verified,{ timeout:probeTimeout,signal })
      await this.markVerifiedAt(id,verificationGeneration)
      for (const path of await entries(root)) {
        if ((await lstat(join(root,path))).isSymbolicLink()) continue
        const file = await checkedFile(join(root,path),constants.O_RDWR)
        try { await file.sync() } finally { await file.close() }
      }
      async function syncDirs(at, sync) { for (const entry of await readdir(at,{ withFileTypes:true })) if (entry.isDirectory()) await syncDirs(join(at,entry.name),sync); await sync(at) }
      await syncDirs(root,this.directorySync)
      await this.directorySync(join(this.root,'envs'))
      signal.throwIfAborted()
      await this.activationHook('pack-durable')
      const pointers = await this.readPointers()
      let latest
      for (const pointer of pointers) { try { await this.verify(pointer.id); latest = pointer; break } catch {} }
      const sequence = (pointers[0]?.sequence || 0)+1
      if (!Number.isSafeInteger(sequence)) throw new Error('Processing activation sequence exhausted')
      const slot = latest?.slot === 0 ? 1 : 0
      const body = { schema:2,sequence,id }, pending = join(this.root,`active.${slot}.pending`)
      const file = await checkedFile(pending,constants.O_RDWR|constants.O_CREAT)
      try { await file.truncate(0); await this.activationHook('pointer-open'); signal.throwIfAborted(); await file.writeFile(JSON.stringify({ ...body,checksum:sha(JSON.stringify(body)) })); await file.sync() } finally { await file.close() }
      signal.throwIfAborted()
      await this.durableReplace(pending,join(this.root,`active.${slot}.json`))
      await this.activationHook('pointer-durable')
      this.selectedId = id
      return this.verify(id)
    } finally {
      this.busy = false
      await lock.release()
      try { await this.prune() } catch (error) { this.retentionError = error.message }
    }
  }
  async acquireUsage(id, { launch = false } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid processing installation identity')
    await directory(join(this.root,'leases'))
    const lease = await acquireInstallLock(join(this.root,'leases',`${id}.lock`),this.lockPython)
    try { await (launch ? this.launchVerify(id) : this.verify(id)); return lease } catch (error) { await lease.release(); throw error }
  }
  // Explicit maintenance, never part of a running install. Retain both rollback
  // slots, caller-declared workers and every installation with a live lease.
  // Interrupted or unsafe trees are retained as evidence, not recursively erased.
  async prune({ inUseIds = [], maxCacheBytes = 10 * 1024 ** 3, incompleteLimit = 2 } = {}) {
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || !Number.isSafeInteger(incompleteLimit) || incompleteLimit < 0) throw new Error('Invalid processing retention policy')
    await directory(this.root)
    const lock = await acquireInstallLock(join(this.root,'install.lock'),this.lockPython)
    const removed = [], retained = [], incomplete = []
    try {
      const keep = new Set([...inUseIds,...(await this.readPointers()).map(pointer => pointer.id)])
      await directory(join(this.root,'leases'))
      let candidates
      try { candidates = await readdir(join(this.root,'envs'),{withFileTypes:true}) } catch (error) { if (error.code === 'ENOENT') return {removed,retained}; throw error }
      for (const candidate of candidates) {
        const path = join(this.root,'envs',candidate.name)
        if (!candidate.isDirectory() || candidate.isSymbolicLink() || !/^[a-f0-9]{16}$/.test(candidate.name)) { retained.push(candidate.name); continue }
        let receipt, lease
        try {
          receipt = JSON.parse(await checkedRead(join(path,'receipt.json')))
          if (keep.has(receipt.id)) { retained.push(receipt.id); continue }
          const active = await this.verify(receipt.id)
          if (active.directory !== path) throw new Error('Installation directory mismatch')
          lease = await acquireInstallLock(join(this.root,'leases',`${receipt.id}.lock`),this.lockPython)
          await rm(path,{recursive:true})
          removed.push(receipt.id)
        } catch { incomplete.push({path,name:candidate.name,id:receipt?.id,mtime:(await lstat(path)).mtimeMs}) }
        finally { await lease?.release() }
      }
      // Keep a bounded amount of failed-attempt evidence. A valid live lease
      // always overrides this cap, including when its local receipt is damaged.
      incomplete.sort((a,b) => b.mtime-a.mtime)
      const leaseNames = await readdir(join(this.root,'leases'))
      for (const [index,item] of incomplete.entries()) {
        if (index < incompleteLimit) { retained.push(item.id || item.name); continue }
        const held = []
        try {
          for (const name of leaseNames.filter(name => name.startsWith(item.name) && /^[a-f0-9]{64}\.lock$/.test(name))) held.push(await acquireInstallLock(join(this.root,'leases',name),this.lockPython))
          await rm(item.path,{recursive:true})
          removed.push(item.id || item.name)
        } catch { retained.push(item.id || item.name) }
        finally { for (const lease of held) await lease.release() }
      }
      const artifactIds = new Set(), recipeIds = new Set()
      let trustedRecipe
      for (const candidate of await readdir(join(this.root,'envs'),{withFileTypes:true})) {
        if (!candidate.isDirectory() || candidate.isSymbolicLink()) continue
        try {
          const manifest = JSON.parse(await checkedRead(join(this.root,'envs',candidate.name,'manifest.json')))
          if (manifest.schema !== 2 || manifest.kind !== 'processing' || !Array.isArray(manifest.recipe?.wheels) || manifest.recipe.wheels.length > 4096) continue
          // Retention is not execution admission. A protected previous-release
          // environment may be incompatible with this application; retain its
          // bounded hash-only artifact references for offline rollback repair.
          try { this.validate(manifest); trustedRecipe = manifest } catch {}
          recipeIds.add(recipeDigest(manifest))
          const keepArtifact = hash => { if (/^[a-f0-9]{64}$/.test(hash || '')) artifactIds.add(hash) }
          keepArtifact(manifest.recipe.python?.sha256)
          for (const wheel of manifest.recipe.wheels) {
            keepArtifact(wheel?.sha256)
            if (Array.isArray(wheel?.notices) && wheel.notices.length <= 256) for (const notice of wheel.notices) keepArtifact(notice?.sha256)
          }
        } catch {}
      }
      for (const [folder, ids] of [['artifacts',artifactIds],['recipe-cache',recipeIds]]) {
        let records
        try { records = await readdir(join(this.root,folder),{withFileTypes:true}) } catch (error) { if(error.code === 'ENOENT') continue; throw error }
        for (const entry of records) if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{64}$/.test(entry.name) && !ids.has(entry.name)) await rm(join(this.root,folder,entry.name),{recursive:true})
      }
      const cache = join(this.root,'uv-cache')
      let cacheBytes = 0
      try { for (const name of await entries(cache)) cacheBytes += (await lstat(join(cache,name))).size } catch (error) { if(error.code !== 'ENOENT') throw error }
      let cacheCleaned = false
      if (cacheBytes > maxCacheBytes && trustedRecipe) {
        await this.verifiedUv(trustedRecipe,{cache})
        await this.command(this.uvPath,['cache','clean','--no-config','--offline','--cache-dir',cache],{cache})
        cacheCleaned = true
      }
      return {removed,retained,cacheCleaned}
    } finally { await lock.release() }
  }

}
