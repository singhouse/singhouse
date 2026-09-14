// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated, operator-controlled portable application updates.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readlink, readdir, rename, rm, statfs, symlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertReleaseIdentity, assertReleasePolicy, canonicalJson, validateUpdateMetadata } from './release.mjs'
import { checkedFile, runNativeHelper } from './runtime_manager.mjs'

const MAGIC = Buffer.from('SINGHOUSEAPP\0\r\n\x1a', 'binary')
const HASH = /^[a-f0-9]{64}$/
const POINT = /^point-[A-Za-z0-9]+$/
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const portablePath = value => typeof value === 'string' && value.length > 0 && value.length < 1024
  && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part =>
    /^[A-Za-z0-9._+() -]+$/.test(part) && part.trim() === part && !['', '.', '..'].includes(part)
    && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))

function assertPrivate(info, kind) {
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`Private ${kind} has the wrong type`)
  if (info.isSymbolicLink()) throw new Error(`Private ${kind} must not be a symbolic link`)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`Private ${kind} has a different owner`)
  if (typeof process.getuid === 'function' && info.mode & 0o077) throw new Error(`Private ${kind} grants group or world access`)
}

export async function privateDirectory(boundary, target, { create = true } = {}) {
  boundary = resolve(boundary); target = resolve(target)
  const suffix = relative(boundary, target)
  if (suffix === '..' || suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Private path escapes application data')
  let current = boundary
  const check = async (path, make) => {
    try { assertPrivate(await lstat(path), 'directory') }
    catch (error) {
      if (error.code !== 'ENOENT' || !make) throw error
      await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700)
      assertPrivate(await lstat(path), 'directory')
    }
  }
  await check(current, false)
  for (const part of suffix ? suffix.split(/[\\/]/) : []) { current = join(current, part); await check(current, create) }
  return target
}

async function privateRead(path) {
  const file = await checkedFile(path, constants.O_RDONLY)
  try { assertPrivate(await file.stat(), 'file'); return await file.readFile() } finally { await file.close() }
}

async function writeNew(path, bytes, mode = 0o600) {
  const file = await checkedFile(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
  try { await file.chmod(mode); await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}

function replacer(python, helper, injected, nativeHelper = runNativeHelper) {
  if (injected) return injected
  return async (source, destination) => {
    const result = await nativeHelper(python, helper, ['--durable-application-replace', source, destination],
      { failure: 'Application state could not be committed durably' })
    if (result?.schema !== 1 || result.durable !== true) throw new Error('Invalid native durability confirmation')
  }
}

async function durableJson(root, name, value, replace) {
  const pending = join(root, `.${name}.${randomUUID()}.pending`)
  try { await writeNew(pending, canonicalJson(value)); await replace(pending, join(root, name)) }
  catch (error) { await rm(pending, { force: true }); throw error }
}

async function durablePointer(root, name, value, replace) {
  try { await durableJson(root, `${name}.last-good`, JSON.parse(await privateRead(join(root, name))), replace) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await durableJson(root, name, value, replace)
}

async function readPointers(root, name) {
  const errors = [], values = []
  for (const candidate of [name, `${name}.last-good`]) {
    try { values.push(JSON.parse(await privateRead(join(root, candidate)))) }
    catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  }
  if (!values.length && errors.length) throw errors[0]
  return values
}

async function fileHash(path) {
  const file = await checkedFile(path, constants.O_RDONLY)
  try { return sha(await file.readFile()) } finally { await file.close() }
}

async function exactFiles(root, prefix = '') {
  const found = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Managed application contains a symbolic link')
    if (entry.isDirectory()) found.push(...await exactFiles(root, rel))
    else if (entry.isFile()) found.push(rel)
    else throw new Error('Managed application contains a non-regular entry')
  }
  return found.sort()
}

async function exactTree(root, prefix = '') {
  const found = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(root, rel)
    if (entry.isSymbolicLink()) {
      const raw = await readlink(path), target = relative(root, resolve(dirname(path), raw)).split('\\').join('/')
      if (target === '..' || target.startsWith('../')) throw new Error('Managed application symlink escapes its release')
      found.push({ type: 'symlink', path: rel, target })
    } else if (entry.isDirectory()) { found.push({ type: 'directory', path: rel }); found.push(...await exactTree(root, rel)) }
    else if (entry.isFile()) found.push({ type: 'file', path: rel })
    else throw new Error('Managed application contains a non-regular entry')
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

function validatePortableHeader(value, expected) {
  if (!value || value.schema !== 1 || value.kind !== 'singhouse-portable-application'
      || value.target?.platform !== expected.platform || value.target?.arch !== expected.arch
      || !portablePath(value.entrypoint) || !Array.isArray(value.files) || !value.files.length) {
    throw new Error('Portable application manifest is malformed or targets another platform')
  }
  if (!((expected.platform === 'linux' && ['x64', 'arm64'].includes(expected.arch))
      || (expected.platform === 'win32' && expected.arch === 'x64')
      || (expected.platform === 'darwin' && expected.arch === 'arm64'))) throw new Error('Portable target is outside the launch matrix')
  assertReleaseIdentity(value.identity, { published: true })
  const names = new Set(), folded = new Set()
  let offset = 0
  for (const record of value.files) {
    const lower = String(record.path).toLowerCase()
    if (!portablePath(record.path) || names.has(record.path) || folded.has(lower)
        || !['file', 'directory', 'symlink'].includes(record.type)) {
      throw new Error('Portable application inventory is unsafe or non-deterministic')
    }
    if (record.type === 'file' && (record.offset !== offset || !Number.isSafeInteger(record.size) || record.size < 0
        || !HASH.test(record.sha256 || '') || ![0o644, 0o755].includes(record.mode))) throw new Error('Portable file record is invalid')
    if (record.type === 'file') offset += record.size
    if (record.type === 'directory' && record.mode !== 0o755) throw new Error('Portable directory record is invalid')
    if (record.type === 'symlink' && !portablePath(record.target)) throw new Error('Portable symlink target is invalid')
    names.add(record.path); folded.add(lower)
  }
  const byName = new Map(value.files.map(record => [record.path, record]))
  for (const record of value.files) {
    const parts = record.path.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (byName.get(parts.slice(0, index).join('/'))?.type !== 'directory') throw new Error('Portable path has an undeclared parent directory')
    }
    if (record.type === 'symlink') {
      let target = byName.get(record.target), hops = 0
      if (!target) throw new Error('Portable symlink target is absent')
      while (target.type === 'symlink') {
        if (++hops > value.files.length) throw new Error('Portable symlink cycle')
        target = byName.get(target.target)
        if (!target) throw new Error('Portable symlink target is absent')
      }
    }
  }
  if (!names.has(value.entrypoint) || value.files.find(file => file.path === value.entrypoint).type !== 'file'
      || value.files.find(file => file.path === value.entrypoint).mode !== 0o755) {
    throw new Error('Portable application entrypoint is absent or non-executable')
  }
  const evidence = [...names].map(name => name.toLowerCase())
  const ends = (path, suffix) => path === suffix || path.endsWith(`/${suffix}`)
  if (!evidence.some(name => ends(name, 'resources/app.asar'))
      || !['manifest.json', 'files.json', 'assembly.json'].every(name => evidence.some(path => ends(path, `resources/native/${name}`)))) {
    throw new Error('Portable application does not contain the bound Electron and native evidence')
  }
  return value
}

export async function inspectPortable(path, expected) {
  const file = await checkedFile(path, constants.O_RDONLY)
  try {
    const info = await file.stat()
    if (info.size < MAGIC.length + 4) throw new Error('Portable application is truncated')
    const prefix = Buffer.alloc(MAGIC.length + 4)
    if ((await file.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Portable application magic is invalid')
    }
    const length = prefix.readUInt32BE(MAGIC.length)
    if (!length || length > 16 * 1024 * 1024 || MAGIC.length + 4 + length > info.size) throw new Error('Portable application header is invalid')
    const bytes = Buffer.alloc(length)
    if ((await file.read(bytes, 0, length, prefix.length)).bytesRead !== length) throw new Error('Portable application header is truncated')
    let header
    try { header = validatePortableHeader(JSON.parse(bytes), expected) } catch (error) { throw new Error(`Portable application header is invalid: ${error.message}`) }
    if (!Buffer.from(canonicalJson(header)).equals(bytes)) throw new Error('Portable application header is not canonical')
    const dataOffset = prefix.length + length
    const total = header.files.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0)
    if (dataOffset + total !== info.size) throw new Error('Portable application has trailing or missing bytes')
    return { file, info, header, dataOffset, sha256: sha(await file.readFile()) }
  } catch (error) { await file.close(); throw error }
}

async function extractPortable(source, destination, expected) {
  const inspected = await inspectPortable(source, expected)
  const staging = await mkdtemp(`${destination}.staging-`)
  try {
    await chmod(staging, 0o700)
    for (const record of inspected.header.files.filter(record => record.type === 'directory')) {
      const directory = join(staging, ...record.path.split('/')); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
    }
    for (const record of inspected.header.files.filter(record => record.type === 'file')) {
      const output = join(staging, ...record.path.split('/'))
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      const target = await checkedFile(output, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
      const hash = createHash('sha256')
      try {
        let copied = 0
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, record.size)))
        while (copied < record.size) {
          const count = Math.min(buffer.length, record.size - copied)
          const result = await inspected.file.read(buffer, 0, count, inspected.dataOffset + record.offset + copied)
          if (!result.bytesRead) throw new Error('Portable application ended during extraction')
          await target.write(buffer, 0, result.bytesRead, copied); hash.update(buffer.subarray(0, result.bytesRead)); copied += result.bytesRead
        }
        if (hash.digest('hex') !== record.sha256) throw new Error(`Portable entry checksum mismatch: ${record.path}`)
        await target.chmod(record.mode === 0o755 ? 0o500 : 0o400); await target.sync()
      } finally { await target.close() }
    }
    for (const record of inspected.header.files.filter(record => record.type === 'symlink')) {
      const output = join(staging, ...record.path.split('/')), target = join(staging, ...record.target.split('/'))
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      const relativeTarget = relative(dirname(output), target)
      if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Portable symlink escapes extraction root')
      await symlink(relativeTarget, output)
    }
    await writeNew(join(staging, 'portable.json'), canonicalJson(inspected.header), 0o400)
    return { staging, manifest: inspected.header, payloadSha256: inspected.sha256 }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  finally { await inspected.file.close() }
}

export class DatabaseGuard {
  constructor({ python, helper, dataDirectory }) { Object.assign(this, { python, helper, dataDirectory }) }
  async command(args, failure) { return runNativeHelper(this.python, this.helper, args, { failure }) }
  async plan() {
    const value = await this.command(['--db-plan', this.dataDirectory], 'Library database inspection failed')
    if (value?.schema !== 1 || typeof value.exists !== 'boolean' || !Number.isSafeInteger(value.size) || value.size < 0
        || !(value.revision === null || typeof value.revision === 'string') || !Array.isArray(value.sidecars)) throw new Error('Invalid database plan')
    return value
  }
  async backup(destination) {
    const value = await this.command(['--db-backup', this.dataDirectory, destination], 'Library database backup failed')
    if (value?.schema !== 1 || value.backed_up !== true || value.path !== destination || value.quickCheck !== 'ok'
        || !HASH.test(value.sha256 || '') || !Number.isSafeInteger(value.size) || value.size <= 0) throw new Error('Invalid database backup')
    return value
  }
  async restore(source) { return this.command(['--db-restore', source, this.dataDirectory], 'Library database restore failed') }
}

// Once activation returns, the old backend has stopped and the durable
// handoff owns startup. Later failures must stay on the shutdown/retry path.
export async function completeActivationHandoff({ activate, startBootstrap, present }) {
  let backendStopped = false
  try {
    const handoff = await activate()
    backendStopped = true
    await startBootstrap(handoff)
    await present(handoff)
    return handoff
  } catch (error) {
    if (backendStopped) error.backendStopped = true
    throw error
  }
}

// Manual restore stops the backend before replacing its database. A failure
// before that boundary may return to the live UI; at or after it the launcher
// must remain in handoff mode and finish quitting.
export async function completeManualRestoreHandoff({ restore, reset, quit }) {
  let result
  try {
    result = await restore()
  } catch (error) {
    if (!error.backendStopped) await reset()
    else { try { await quit() } catch { /* preserve the restore failure */ } }
    throw error
  }
  try { await quit() } catch (error) { error.backendStopped = true; throw error }
  return result
}

export class UpdateStore {
  constructor(root, contract, expected, { fetch = globalThis.fetch, progress = () => {}, lockPython, durabilityHelper,
    durableReplace, stateRoot, platformTrust } = {}) {
    Object.assign(this, { root: resolve(root), contract: assertReleasePolicy(contract), expected, fetch, progress, platformTrust })
    this.stateRoot = resolve(stateRoot || dirname(root)); this.replace = replacer(lockPython, durabilityHelper, durableReplace)
  }
  async secure() { return privateDirectory(this.stateRoot, this.root) }
  async validate(metadata) { return validateUpdateMetadata(metadata, this.contract, await this.sequenceExpected(metadata)) }
  async sequenceState() {
    try {
      const value = JSON.parse(await privateRead(join(this.root, 'sequence.json')))
      if (value?.schema !== 1 || value.edition !== this.contract.edition || value.channel !== this.contract.channel
          || value.policyId !== this.contract.policyId
          || !Number.isSafeInteger(value.highestAccepted) || value.highestAccepted < 0
          || !Number.isSafeInteger(value.highestActivated) || value.highestActivated < 0
          || value.highestActivated > value.highestAccepted
          || (value.acceptedReleaseId !== null && !HASH.test(value.acceptedReleaseId || ''))) throw new Error('Invalid update sequence state')
      return value
    } catch (error) {
      if (error.code === 'ENOENT') {
        const initial = Math.max(0, this.expected.lastSequence ?? 0)
        return { schema: 1, edition: this.contract.edition, channel: this.contract.channel,
          policyId: this.contract.policyId, highestAccepted: initial, highestActivated: initial, acceptedReleaseId: null }
      }
      throw error
    }
  }
  async sequenceExpected(metadata, override) {
    if (override) return override
    const state = await this.sequenceState(), sequence = metadata?.signed?.sequence
    const retained = sequence === state.highestAccepted && metadata?.signed?.identity?.releaseId === state.acceptedReleaseId
    return { ...this.expected, lastSequence: retained ? sequence - 1 : Math.max(this.expected.lastSequence ?? -1, state.highestAccepted) }
  }
  async acceptSequence(metadata) {
    const state = await this.sequenceState()
    if (metadata.sequence < state.highestAccepted
        || (metadata.sequence === state.highestAccepted && metadata.identity.releaseId !== state.acceptedReleaseId)) throw new Error('Update sequence would move backwards')
    if (metadata.sequence === state.highestAccepted) return state
    const next = { ...state, highestAccepted: metadata.sequence, acceptedReleaseId: metadata.identity.releaseId }
    await durableJson(this.root, 'sequence.json', next, this.replace); return next
  }
  async activateSequence(journal) {
    const state = await this.sequenceState()
    if (journal.sequence !== state.highestAccepted || journal.targetIdentity.releaseId !== state.acceptedReleaseId
        || journal.sequence < state.highestActivated) throw new Error('Completed handoff does not match accepted update sequence')
    if (journal.sequence === state.highestActivated) return state
    const next = { ...state, highestActivated: journal.sequence }
    await durableJson(this.root, 'sequence.json', next, this.replace); return next
  }
  async download(record, destination, signal, artifactDirectory) {
    const output = await checkedFile(destination, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
    let source
    try {
      signal?.throwIfAborted()
      if (artifactDirectory) {
        try {
          source = (await checkedFile(join(resolve(artifactDirectory), record.name), constants.O_RDONLY))
            .createReadStream({ autoClose: true, signal })
        } catch (error) {
          // Only absence selects the signed network fallback. An unsafe local
          // name, symlink, permission failure, or non-file remains a hard
          // failure rather than being hidden by a download.
          if (error.code !== 'ENOENT') throw error
        }
      }
      if (!source) {
        if (!record.url) throw new Error(`Update artifact ${record.name} is not adjacent to its metadata and has no signed HTTPS URL`)
        const response = await this.fetch(record.url, { signal, redirect: 'error' })
        if (!response.ok || !response.body) throw new Error(`Update retrieval failed (${response.status})`)
        source = response.body
      }
      let size = 0; const hash = createHash('sha256')
      for await (const chunk of source) {
        if (size + chunk.length > record.size) throw new Error('Update artifact exceeds declared size')
        await output.write(chunk, 0, chunk.length, size); hash.update(chunk); size += chunk.length
        this.progress({ file: record.name, received: size, total: record.size })
      }
      if (size !== record.size || hash.digest('hex') !== record.sha256) throw new Error('Update artifact size or checksum mismatch')
      await output.sync(); await output.chmod(0o400)
    } finally { await output.close() }
  }
  async stage(metadata, { signal, artifactDirectory } = {}) {
    const envelope = structuredClone(metadata); await this.secure()
    const signed = structuredClone(validateUpdateMetadata(envelope, this.contract, await this.sequenceExpected(envelope)))
    const sequence = await this.sequenceState()
    const acceptedRetry = signed.sequence === sequence.highestAccepted
      && signed.identity.releaseId === sequence.acceptedReleaseId
    await privateDirectory(this.root, join(this.root, 'staged'))
    const final = join(this.root, 'staged', signed.identity.releaseId)
    let found
    try {
      found = await this.verifyStage(signed.identity.releaseId)
    } catch (error) {
      let finalExists = true
      try { await lstat(final) } catch (missing) { if (missing.code === 'ENOENT') finalExists = false; else throw missing }
      if (finalExists) {
        if (!acceptedRetry) throw error
        const quarantine = join(this.root, 'staged', 'quarantine')
        await privateDirectory(this.root, quarantine)
        await this.replace(final, join(quarantine, `${signed.identity.releaseId}-${randomUUID()}`))
      } else if (error.code !== 'ENOENT') throw error
    }
    if (found) {
      await durablePointer(this.root, 'staged.json', { schema: 1, releaseId: signed.identity.releaseId }, this.replace)
      await this.acceptSequence(signed)
      return found
    }
    const temp = await mkdtemp(join(this.root, 'staged', `.${signed.identity.releaseId}-`))
    try {
      const names = new Set()
      for (const record of signed.files) {
        if (record.name !== basename(record.name) || !portablePath(record.name) || names.has(record.name.toLowerCase())) throw new Error('Update artifact name is unsafe or ambiguous')
        names.add(record.name.toLowerCase())
        await this.download(record, join(temp, record.name), signal, artifactDirectory)
      }
      await writeNew(join(temp, 'update.json'), canonicalJson(envelope), 0o400)
      signal?.throwIfAborted(); await this.replace(temp, final)
      const verified = await this.verifyStage(signed.identity.releaseId)
      await durablePointer(this.root, 'staged.json', { schema: 1, releaseId: signed.identity.releaseId }, this.replace)
      await this.acceptSequence(signed)
      return verified
    } catch (error) { await rm(temp, { recursive: true, force: true }); throw error }
  }
  async verifyStage(releaseId, expected) {
    if (!HASH.test(releaseId || '')) throw new Error('Invalid staged release')
    await privateDirectory(this.root, join(this.root, 'staged', releaseId), { create: false })
    const root = join(this.root, 'staged', releaseId)
    const envelope = JSON.parse(await privateRead(join(root, 'update.json')))
    const metadata = validateUpdateMetadata(envelope, this.contract, await this.sequenceExpected(envelope, expected))
    if (metadata.identity.releaseId !== releaseId || JSON.stringify(await exactFiles(root)) !== JSON.stringify(['update.json', ...metadata.files.map(file => file.name)].sort())) throw new Error('Staged inventory mismatch')
    for (const record of metadata.files) {
      const info = await lstat(join(root, record.name))
      if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size || await fileHash(join(root, record.name)) !== record.sha256) throw new Error('Staged artifact changed')
    }
    return { directory: root, manifest: metadata }
  }
  async staged() {
    for (const pointer of await readPointers(this.root, 'staged.json')) {
      try {
        if (pointer.schema === 1) {
          const stage = await this.verifyStage(pointer.releaseId)
          // A crash after publishing the authenticated stage pointer but before
          // advancing anti-replay state is repaired from that exact signed stage.
          await this.acceptSequence(stage.manifest)
          return stage
        }
      } catch { /* try last good */ }
    }
    return null
  }
  async installPortable(stage, record, identity) {
    const expected = { platform: record.platform, arch: record.arch }
    const portable = join(stage.directory, record.name)
    const inspected = await inspectPortable(portable, expected)
    try { if (canonicalJson(inspected.header.identity) !== canonicalJson(identity)) throw new Error('Portable payload identity mismatch') }
    finally { await inspected.file.close() }
    const releases = join(this.root, 'installed', 'releases'); await privateDirectory(this.root, join(this.root, 'installed')); await privateDirectory(this.root, releases)
    const final = join(releases, identity.releaseId)
    try { return await this.verifyInstalled({ schema: 1, releaseId: identity.releaseId }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const unpacked = await extractPortable(portable, final, expected)
    const recordValue = { schema: 1, releaseId: identity.releaseId, platform: expected.platform, arch: expected.arch,
      payloadSha256: unpacked.payloadSha256, manifestSha256: sha(canonicalJson(unpacked.manifest)), entrypoint: unpacked.manifest.entrypoint }
    try {
      await writeNew(join(unpacked.staging, 'installed.json'), canonicalJson(recordValue), 0o400)
      if (['win32', 'darwin'].includes(expected.platform)) {
        if (!this.platformTrust || await this.platformTrust({ root: unpacked.staging, manifest: unpacked.manifest }) !== true) {
          throw new Error(`${expected.platform} platform trust is not configured; code signing verification is required`)
        }
      }
      await this.replace(unpacked.staging, final)
      return this.verifyInstalled(recordValue)
    } catch (error) { await rm(unpacked.staging, { recursive: true, force: true }); throw error }
  }
  async verifyInstalled(expected) {
    if (expected?.schema !== 1 || !HASH.test(expected.releaseId || '')) throw new Error('Invalid installed release record')
    const root = join(this.root, 'installed', 'releases', expected.releaseId)
    await privateDirectory(this.root, root, { create: false })
    const record = JSON.parse(await privateRead(join(root, 'installed.json')))
    const manifest = JSON.parse(await privateRead(join(root, 'portable.json')))
    validatePortableHeader(manifest, { platform: record.platform, arch: record.arch })
    const comparableExpected = expected && Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'sequence'))
    if (record.releaseId !== manifest.identity.releaseId || record.manifestSha256 !== sha(canonicalJson(manifest))
        || record.entrypoint !== manifest.entrypoint || (expected.manifestSha256 && canonicalJson(record) !== canonicalJson(comparableExpected))) throw new Error('Managed release record mismatch')
    const expectedTree = [{ type: 'file', path: 'installed.json' }, { type: 'file', path: 'portable.json' },
      ...manifest.files.map(file => file.type === 'symlink' ? { type: 'symlink', path: file.path, target: file.target }
        : { type: file.type, path: file.path })].sort((a, b) => a.path.localeCompare(b.path))
    if (canonicalJson(await exactTree(root)) !== canonicalJson(expectedTree)) throw new Error('Managed release inventory changed')
    for (const file of manifest.files.filter(file => file.type === 'file')) {
      const info = await lstat(join(root, file.path))
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || await fileHash(join(root, file.path)) !== file.sha256) throw new Error('Managed release file changed')
    }
    if (['win32', 'darwin'].includes(record.platform)
        && (!this.platformTrust || await this.platformTrust({ root, manifest }) !== true)) throw new Error('Managed application platform trust failed')
    return { ...record, root, path: join(root, record.entrypoint), manifest }
  }
  async active({ handoff } = {}) {
    const installed = join(this.root, 'installed')
    try { await privateDirectory(this.root, installed, { create: false }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const transaction = await this.recoveryTransaction()
    let pointer
    try { pointer = JSON.parse(await privateRead(join(installed, 'active.json'))) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { pointer = JSON.parse(await privateRead(join(installed, 'active.json.last-good'))) }
      catch (fallback) { if (fallback.code === 'ENOENT') return null; throw fallback }
    }
    const selected = await this.verifyInstalled(pointer)
    if (transaction?.state === 'completed' && (selected.releaseId !== transaction.releaseId
        || transaction.installationSha256 !== sha(canonicalJson(Object.fromEntries(Object.entries(pointer).filter(([key]) => key !== 'sequence')))))) {
      if (!handoff || handoff.previousIdentity.releaseId !== transaction.releaseId
          || transaction.installationSha256 !== sha(canonicalJson(handoff.previousApplication))
          || selected.releaseId !== handoff.targetIdentity.releaseId
          || canonicalJson(Object.fromEntries(Object.entries(pointer).filter(([key]) => key !== 'sequence')))
            !== canonicalJson(handoff.targetApplication)) throw new Error('Completed recovery selection mismatch')
    }
    return { ...selected, ...(Number.isSafeInteger(pointer.sequence) ? { selectionSequence: pointer.sequence } : {}) }
  }
  async authenticatedActive({ allowAbsentState = false } = {}) {
    if (allowAbsentState) {
      try { await privateDirectory(this.stateRoot, this.root, { create: false }) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }
    const handoff = await this.journal()
    if (!handoff) {
      // A first managed activation installs and selects the signed rollback
      // application before it can durably create the handoff.  Authenticate
      // that narrow pre-handoff state from the accepted retained stage so a
      // crash there remains launchable without trusting mutable pointers.
      const selected = await this.active()
      const retained = await this.staged()
      const retainedRollback = retained?.manifest?.files?.find(file => file.role === 'rollback')
      const stage = retainedRollback && await this.verifyStage(retained.manifest.identity.releaseId,
        { ...this.expected, currentIdentity: retainedRollback.identity,
          pairedCoreReleaseId: retained.manifest.identity.pairedCoreReleaseId, lastSequence: -1 })
      const sequence = await this.sequenceState()
      const rollback = stage?.manifest?.files?.find(file => file.role === 'rollback')
      if (selected && stage
          && stage.manifest.sequence === sequence.highestAccepted
          && stage.manifest.identity.releaseId === sequence.acceptedReleaseId
          && sequence.highestActivated < sequence.highestAccepted
          && rollback?.identity?.releaseId === selected.releaseId
          && stage.manifest.supersedes.length === 1
          && stage.manifest.supersedes[0] === selected.releaseId
          && canonicalJson(selected.manifest.identity) === canonicalJson(rollback.identity)
          && selected.payloadSha256 === rollback.sha256
          && selected.platform === rollback.platform && selected.arch === rollback.arch) {
        return selected
      }
      if (allowAbsentState && !selected) {
        const entries = await readdir(this.root, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('First-installer update state has an unsafe entry')
        }
        const names = entries.map(entry => entry.name).sort()
        if (names.length === 0) return null
        if (canonicalJson(names) === canonicalJson(['staged'])) {
          await privateDirectory(this.root, join(this.root, 'staged'), { create: false })
          if ((await readdir(join(this.root, 'staged'))).length === 0) return null
        }
        if (canonicalJson(names) === canonicalJson(['sequence.json', 'staged', 'staged.json'])) {
          const pointer = JSON.parse(await privateRead(join(this.root, 'staged.json')))
          const sequence = await this.sequenceState()
          const current = assertReleaseIdentity(this.expected.currentIdentity, { published: true })
          const accepted = pointer?.schema === 1 && HASH.test(pointer.releaseId || '')
            ? await this.verifyStage(pointer.releaseId) : null
          const rollback = accepted?.manifest?.files?.find(file => file.role === 'rollback')
          if (accepted
              && accepted.manifest.identity.releaseId === pointer.releaseId
              && sequence.acceptedReleaseId === pointer.releaseId
              && sequence.highestAccepted === accepted.manifest.sequence
              && sequence.highestActivated < sequence.highestAccepted
              && accepted.manifest.supersedes.length === 1
              && accepted.manifest.supersedes[0] === current.releaseId
              && canonicalJson(rollback?.identity) === canonicalJson(current)) return null
        }
      }
      throw new Error('No authenticated update handoff or pre-handoff rollback is available for the active managed release')
    }
    const selected = await this.active({ handoff })
    if (!selected) return null
    const identity = assertReleaseIdentity(selected.manifest.identity, { published: true })
    if (identity.edition !== this.contract.edition || identity.policyId !== this.contract.policyId) {
      throw new Error('Active managed release belongs to a different edition policy')
    }

    // The stable wrapper is intentionally independent of the version that
    // initiated an update, but it must not turn mutable pointer/sequence state
    // into an authentication oracle. Re-open the retained envelope under the
    // trust roots shipped with this wrapper and bind it to the latest handoff.
    const historicalExpected = { ...this.expected, currentIdentity: handoff.previousIdentity,
      pairedCoreReleaseId: handoff.targetIdentity.pairedCoreReleaseId, lastSequence: -1 }
    const stage = await this.verifyStage(handoff.stagedRelease, historicalExpected)
    const application = stage.manifest.files.find(file => file.role === 'application')
    const rollback = stage.manifest.files.find(file => file.role === 'rollback')
    if (sha(canonicalJson(stage.manifest)) !== handoff.updateMetadataSha256
        || canonicalJson(stage.manifest.identity) !== canonicalJson(handoff.targetIdentity)
        || stage.manifest.sequence !== handoff.sequence
        || stage.manifest.supersedes.length !== 1
        || stage.manifest.supersedes[0] !== handoff.previousIdentity.releaseId
        || application?.identity?.releaseId !== handoff.targetIdentity.releaseId
        || rollback?.identity?.releaseId !== handoff.previousIdentity.releaseId) {
      throw new Error('Retained signed update does not authorize the latest handoff')
    }
    const installed = Object.fromEntries(Object.entries(selected)
      .filter(([key]) => !['root', 'path', 'manifest', 'selectionSequence'].includes(key)))
    if (selected.releaseId === handoff.targetIdentity.releaseId
        && selected.selectionSequence === handoff.sequence
        && canonicalJson(installed) === canonicalJson(handoff.targetApplication)) return selected

    const transaction = await this.recoveryTransaction()
    if (transaction?.state === 'completed'
        && selected.releaseId === handoff.previousIdentity.releaseId
        && selected.releaseId === transaction.releaseId
        && canonicalJson(installed) === canonicalJson(handoff.previousApplication)
        && transaction.installationSha256 === sha(canonicalJson(installed))
        && transaction.recoveryPoint === handoff.recoveryPoint
        && transaction.recoveryManifestSha256 === handoff.recoveryManifestSha256
        && transaction.updateMetadataSha256 === handoff.updateMetadataSha256) return selected
    throw new Error('Active managed release is not authorized by the retained signed update or completed recovery')
  }
  async select(record, { sequence } = {}) { await durablePointer(join(this.root, 'installed'), 'active.json', { schema: 1, releaseId: record.releaseId,
    platform: record.platform, arch: record.arch, payloadSha256: record.payloadSha256, manifestSha256: record.manifestSha256,
    entrypoint: record.entrypoint, ...(Number.isSafeInteger(sequence) ? { sequence } : {}) }, this.replace) }
  async journal() {
    const sequence = await this.sequenceState()
    for (const value of await readPointers(this.root, 'handoff.json')) {
      try {
        if (value?.schema !== 1 || value.kind !== 'update-handoff'
            || !['preparing', 'retryable', 'aborted', 'awaiting-target', 'completed'].includes(value.state)
            || !Number.isFinite(Date.parse(value.createdAt)) || !POINT.test(value.recoveryPoint || '')
            || !HASH.test(value.recoveryManifestSha256 || '') || !HASH.test(value.updateMetadataSha256 || '')
            || !Number.isSafeInteger(value.sequence) || value.sequence < 1
            || value.recoveryKit?.id !== `kit-${value.recoveryPoint}` || !HASH.test(value.recoveryKit?.manifestSha256 || '')) throw new Error('Invalid update handoff')
        assertReleaseIdentity(value.previousIdentity); assertReleaseIdentity(value.targetIdentity)
        for (const record of [value.previousApplication, value.targetApplication]) {
          if (record?.schema !== 1 || !HASH.test(record.releaseId || '') || !HASH.test(record.payloadSha256 || '')
              || !HASH.test(record.manifestSha256 || '') || !portablePath(record.entrypoint)) throw new Error('Invalid handoff application record')
        }
        if (value.previousApplication.releaseId !== value.previousIdentity.releaseId
            || value.targetApplication.releaseId !== value.targetIdentity.releaseId
            || value.stagedRelease !== value.targetIdentity.releaseId
            || value.sequence !== sequence.highestAccepted
            || value.targetIdentity.releaseId !== sequence.acceptedReleaseId) throw new Error('Update handoff identities disagree')
        return value
      } catch { /* try last good */ }
    }
    return null
  }
  async writeJournal(value) { await durablePointer(this.root, 'handoff.json', value, this.replace) }
  async recoveryTransaction() {
    try {
      const value = JSON.parse(await privateRead(join(this.root, 'recovery-transaction.json')))
      if (value?.schema !== 1 || value.kind !== 'recovery-transaction' || !['in-progress', 'completed', 'superseded'].includes(value.state)
          || !HASH.test(value.releaseId || '') || !HASH.test(value.installationSha256 || '')
          || !POINT.test(value.recoveryPoint || '') || !HASH.test(value.recoveryManifestSha256 || '')
          || !Number.isFinite(Date.parse(value.startedAt))) throw new Error('Invalid recovery transaction')
      if (value.state === 'completed' && !Number.isFinite(Date.parse(value.completedAt))) throw new Error('Invalid completed recovery transaction')
      if (value.state === 'superseded' && (!HASH.test(value.supersededBy || '') || !HASH.test(value.handoffSha256 || '')
          || !Number.isFinite(Date.parse(value.supersededAt)))) throw new Error('Invalid superseded recovery transaction')
      if (value.state === 'in-progress') throw new Error('Standalone recovery was interrupted; rerun recovery before launching')
      return value
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async supersedeRecovery(journal) {
    const transaction = await this.recoveryTransaction()
    if (!transaction || transaction.state === 'superseded') return transaction
    if (transaction.releaseId !== journal.previousIdentity.releaseId || transaction.installationSha256 !== sha(canonicalJson(journal.previousApplication))) throw new Error('Recovery transaction does not match later handoff')
    const value = { ...transaction, state: 'superseded', supersededBy: journal.targetIdentity.releaseId,
      handoffSha256: sha(canonicalJson(journal)), supersededAt: new Date().toISOString() }
    await durableJson(this.root, 'recovery-transaction.json', value, this.replace); return value
  }
  async verifyCompletion(journal) {
    if (journal?.state !== 'completed') throw new Error('Update presentation is not durably completed')
    const sequence = await this.sequenceState()
    if (sequence.highestActivated !== journal.sequence || sequence.highestAccepted !== journal.sequence
        || sequence.acceptedReleaseId !== journal.targetIdentity.releaseId) {
      throw new Error('Completed handoff does not match the activated update sequence')
    }
    const transaction = await this.recoveryTransaction()
    if (transaction && (transaction.state !== 'superseded'
        || transaction.supersededBy !== journal.targetIdentity.releaseId
        || transaction.handoffSha256 !== sha(canonicalJson(journal)))) {
      throw new Error('Completed handoff does not match the superseded recovery transaction')
    }
    return { sequence, transaction }
  }
  async verifyHandoff(journal, recovery) {
    const historicalExpected = { ...this.expected, currentIdentity: journal.previousIdentity,
      pairedCoreReleaseId: journal.targetIdentity.pairedCoreReleaseId, lastSequence: -1 }
    const [stage, point, previous, target] = await Promise.all([this.verifyStage(journal.stagedRelease, historicalExpected),
      recovery.verify(journal.recoveryPoint), this.verifyInstalled(journal.previousApplication), this.verifyInstalled(journal.targetApplication)])
    if (canonicalJson(stage.manifest.identity) !== canonicalJson(journal.targetIdentity)
        || stage.manifest.sequence !== journal.sequence
        || !stage.manifest.supersedes.includes(journal.previousIdentity.releaseId)
        || canonicalJson(point.manifest.application) !== canonicalJson(journal.previousApplication)
        || point.manifest.update !== journal.targetIdentity.releaseId
        || sha(canonicalJson(point.manifest)) !== journal.recoveryManifestSha256
        || sha(canonicalJson(stage.manifest)) !== journal.updateMetadataSha256
        || previous.releaseId !== journal.previousIdentity.releaseId || target.releaseId !== journal.targetIdentity.releaseId) {
      throw new Error('Authenticated update handoff verification failed')
    }
    return { stage, point, previous, target }
  }
}

export class RecoveryStore {
  constructor(root, { lockPython, durabilityHelper, durableReplace, nativeHelper, stateRoot } = {}) {
    this.root = resolve(root); this.stateRoot = resolve(stateRoot || dirname(root)); this.replace = replacer(lockPython, durabilityHelper, durableReplace, nativeHelper)
  }
  async capture({ database, release, databaseWriter = release, application, reason, update = null }) {
    await privateDirectory(this.stateRoot, this.root)
    const temp = await mkdtemp(join(this.root, '.point-')); const id = `point-${randomUUID().replaceAll('-', '')}`, final = join(this.root, id)
    try {
      const result = await database.backup(join(temp, 'database.sqlite3'))
      const manifest = { schema: 1, kind: 'recovery-point', reason, createdAt: new Date().toISOString(),
        release: { releaseId: release.releaseId, appVersion: release.appVersion },
        databaseWriter: databaseWriter && { releaseId: databaseWriter.releaseId, appVersion: databaseWriter.appVersion },
        schemaRevision: result.revision ?? null, update, ...(application ? { application } : {}),
        files: [{ path: 'database.sqlite3', url: pathToFileURL(join(final, 'database.sqlite3')).href,
          size: result.size, sha256: result.sha256, executable: false }] }
      await writeNew(join(temp, 'recovery.json'), canonicalJson(manifest), 0o400); await this.replace(temp, final)
      const kind = update === null ? 'manual' : 'update'
      await durablePointer(this.root, `latest-${kind}.json`, { schema: 1, kind, id }, this.replace)
      return { id, directory: final, manifest }
    } catch (error) { await rm(temp, { recursive: true, force: true }); throw error }
  }
  async verify(id) {
    if (!POINT.test(id || '')) throw new Error('Invalid recovery point')
    const root = join(this.root, id); await privateDirectory(this.root, root, { create: false })
    const manifest = JSON.parse(await privateRead(join(root, 'recovery.json'))), file = manifest?.files?.[0]
    if (manifest?.schema !== 1 || manifest.kind !== 'recovery-point' || file?.path !== 'database.sqlite3'
        || !HASH.test(file.sha256 || '') || JSON.stringify(await exactFiles(root)) !== JSON.stringify(['database.sqlite3', 'recovery.json'])
        || await fileHash(join(root, file.path)) !== file.sha256) throw new Error('Recovery point changed or is malformed')
    return { id, directory: root, manifest }
  }
  async latestKind(kind) {
    if (!['manual', 'update'].includes(kind)) throw new Error('Invalid recovery pointer kind')
    for (const value of await readPointers(this.root, `latest-${kind}.json`)) {
      try {
        if (value?.schema !== 1 || value.kind !== kind) continue
        const point = await this.verify(value.id)
        if ((point.manifest.update === null) !== (kind === 'manual')) continue
        return point
      } catch { /* try last good */ }
    }
    return null
  }
  async latestManual() { return this.latestKind('manual') }
  async latestUpdate() { return this.latestKind('update') }
  async latest() { return this.latestManual() }
  async restore(point, database) { point = await this.verify(point.id); return database.restore(join(point.directory, 'database.sqlite3')) }
}

export function updateBoundary(state) {
  const reasons = []
  if (state?.projectorOpen) reasons.push('Close the projector window')
  if (state?.audible) reasons.push('Stop audible playback')
  if (state?.activeJobs !== 0) reasons.push('Wait for every job to finish')
  if (state?.installing) reasons.push('Wait for installation activity')
  if (!state?.backendReady) reasons.push('Backend is not ready')
  return { safe: reasons.length === 0, reasons }
}

export function installationBoundaryBusy({ installation, processingManager, modelCache, heartSetup, processingOperation } = {}) {
  return Boolean(installation || processingManager?.busy || modelCache?.busy || heartSetup?.operation || processingOperation)
}

export class OperationGate {
  constructor() { this.active = null }
  conflicts(kind) { return Boolean(this.active && this.active.kind !== kind) }
  run(kind, operation) {
    if (typeof kind !== 'string' || !kind || typeof operation !== 'function') throw new Error('Invalid operation gate request')
    if (this.active) return Promise.reject(new Error(`Cannot start ${kind}; ${this.active.kind} is already running`))
    const token = {}; this.active = { kind, token }
    let result
    try { result = operation() } catch (error) { this.active = null; return Promise.reject(error) }
    return Promise.resolve(result).finally(() => { if (this.active?.token === token) this.active = null })
  }
}

export class UpdateController {
  constructor({ contract, identity, database, activity, quiesce, resume, updates, recovery }) { Object.assign(this, { contract, identity, database, activity, quiesce, resume, updates, recovery }) }
  async stage(metadata, options) { return this.updates.stage(metadata, options) }
  async review() {
    const stage = await this.updates.staged(); if (!stage) return null
    const database = await this.database.plan(); const free = await statfs(this.updates.root)
    const required = stage.manifest.files.reduce((sum, file) => sum + file.size, 0) + database.size
    const blocking = []
    if (!stage.manifest.supersedes.includes(this.identity.releaseId)) blocking.push('The staged release does not supersede this exact release')
    if (stage.manifest.requires?.schemaHistory && canonicalJson(stage.manifest.requires.schemaHistory) !== canonicalJson(stage.manifest.identity.schemaHistory)) blocking.push('Schema history requirement differs from target identity')
    if (free.bavail * free.bsize < required * 2) blocking.push('Insufficient disk space for application and database recovery')
    const boundary = updateBoundary(await this.activity())
    return { ...stage, database, boundary, plan: { ok: !blocking.length, blocking, requiredBytes: required } }
  }
  async activate({ stopBackend, backendLive = () => true, prepareRecovery,
    checkpoint = async () => {} }) {
    const review = await this.review(); if (!review) throw new Error('No update is staged')
    if (!review.plan.ok || !review.boundary.safe) throw new Error([...review.plan.blocking, ...review.boundary.reasons].join('\n'))
    const targetRecord = review.manifest.files.find(file => file.role === 'application')
    const rollbackRecord = review.manifest.files.find(file => file.role === 'rollback')
    if (!targetRecord) throw new Error('Update has no portable target application')
    let previous = await this.updates.active()
    if (!previous) {
      if (!rollbackRecord) throw new Error('First managed update requires an authenticated rollback portable')
      const inspected = await inspectPortable(join(review.directory, rollbackRecord.name), this.updates.expected)
      try { if (canonicalJson(inspected.header.identity) !== canonicalJson(Object.fromEntries(Object.entries(this.identity).filter(([key]) => key !== 'selection')))) throw new Error('Rollback portable is not this exact running release') }
      finally { await inspected.file.close() }
      previous = await this.updates.installPortable(review, rollbackRecord, inspected.header.identity)
      await this.updates.select(previous)
      await checkpoint('rollback-selected')
    }
    if (previous.releaseId !== this.identity.releaseId) throw new Error('Managed current application does not match running release')
    const target = await this.updates.installPortable(review, targetRecord, review.manifest.identity)
    if (typeof prepareRecovery !== 'function') throw new Error('Update activation requires a versioned recovery kit publisher')
    let closed = false
    try {
      const quiesced = await this.quiesce()
      if (quiesced?.schema !== 1 || quiesced.quiesced !== true || quiesced.activeMutations !== 0
          || quiesced.activeClaims !== 0 || quiesced.jobs?.nonterminal !== 0
          || !updateBoundary(await this.activity()).safe) throw new Error('Safe update boundary changed during quiesce')
      const point = await this.recovery.capture({ database: this.database, release: this.identity, reason: 'pre-update',
        update: target.releaseId, application: Object.fromEntries(Object.entries(previous).filter(([key]) => !['root', 'path', 'manifest', 'selectionSequence'].includes(key))) })
      await checkpoint('recovery-captured')
      const binding = { schema: 1, recoveryPoint: point.id, recoveryManifestSha256: sha(canonicalJson(point.manifest)),
        updateMetadataSha256: sha(canonicalJson(review.manifest)), previousReleaseId: this.identity.releaseId,
        targetReleaseId: target.releaseId, sequence: review.manifest.sequence }
      const kit = await prepareRecovery(previous, binding)
      if (!kit?.manifest || kit.id !== `kit-${point.id}` || canonicalJson(kit.manifest.binding) !== canonicalJson(binding)) {
        throw new Error('Recovery kit publisher did not return the exact handoff-bound kit')
      }
      const journal = { schema: 1, kind: 'update-handoff', state: 'awaiting-target', createdAt: new Date().toISOString(),
        sequence: review.manifest.sequence,
        previousIdentity: Object.fromEntries(Object.entries(this.identity).filter(([key]) => key !== 'selection')),
        previousApplication: Object.fromEntries(Object.entries(previous).filter(([key]) => !['root', 'path', 'manifest', 'selectionSequence'].includes(key))),
        targetIdentity: review.manifest.identity, targetApplication: Object.fromEntries(Object.entries(target).filter(([key]) => !['root', 'path', 'manifest', 'selectionSequence'].includes(key))),
        stagedRelease: target.releaseId, recoveryPoint: point.id,
        recoveryManifestSha256: binding.recoveryManifestSha256, updateMetadataSha256: binding.updateMetadataSha256,
        recoveryKit: { id: kit.id, manifestSha256: sha(canonicalJson(kit.manifest)) } }
      journal.state = 'preparing'
      await this.updates.writeJournal(journal)
      await checkpoint('journal-preparing')
      await this.updates.verifyHandoff(journal, this.recovery)
      await checkpoint('handoff-verified')
      await stopBackend(); closed = true
      await checkpoint('backend-stopped')
      await this.updates.select(target, { sequence: journal.sequence })
      await checkpoint('target-selected')
      journal.state = 'awaiting-target'
      await this.updates.writeJournal(journal)
      await checkpoint('journal-awaiting-target')
      return { releaseId: target.releaseId, recoveryPoint: point.id, target }
    } catch (error) {
      if (!closed && !backendLive()) closed = true
      if (!error.simulatedCrash) {
        const journal = await this.updates.journal().catch(() => null)
        if (journal?.previousIdentity?.releaseId === this.identity.releaseId
            && journal.targetIdentity?.releaseId === review.manifest.identity.releaseId && journal.state !== 'completed') {
          const state = closed || !backendLive() ? 'retryable' : 'aborted'
          await this.updates.writeJournal({ ...journal, state }).catch(() => {})
        }
        if (!closed && backendLive()) await this.resume?.().catch(() => {})
      }
      if (closed) error.backendStopped = true
      throw error
    }
  }
  async reconcileStartup() {
    const journal = await this.updates.journal(); if (!journal) return null
    if (this.identity.releaseId === journal.previousIdentity.releaseId
        && ['preparing', 'retryable', 'aborted', 'awaiting-target'].includes(journal.state)) {
      try {
        const prior = await this.updates.active()
        if (prior?.releaseId === journal.previousIdentity.releaseId) {
          const transaction = await this.updates.recoveryTransaction()
          if (transaction?.state === 'completed' && transaction.recoveryPoint === journal.recoveryPoint) {
            return { state: 'recovered', journal, active: prior }
          }
          return { state: 'retryable-prior', journal, active: prior }
        }
      } catch { /* A selected target with a retained recovery transaction needs the authenticated path below. */ }
    }
    await this.updates.verifyHandoff(journal, this.recovery)
    const active = await this.updates.active({ handoff: journal })
    if (this.identity.releaseId === journal.targetIdentity.releaseId && active?.releaseId === journal.targetIdentity.releaseId) return { state: 'awaiting-presentation', journal, active }
    if (this.identity.releaseId === journal.previousIdentity.releaseId && active?.releaseId === journal.targetIdentity.releaseId) return { state: 'redirect-target', journal, active }
    const transaction = await this.updates.recoveryTransaction()
    if (this.identity.releaseId === journal.previousIdentity.releaseId && active?.releaseId === journal.previousIdentity.releaseId
        && transaction?.state === 'completed' && transaction.recoveryPoint === journal.recoveryPoint) return { state: 'recovered', journal, active }
    if (this.identity.releaseId === journal.previousIdentity.releaseId && !active) return { state: 'retry-or-recover', journal }
    return { state: 'release-mismatch', journal, active }
  }
  async completeStartup(value) {
    if (value?.state !== 'awaiting-presentation') return value
    const current = await this.updates.journal(), active = await this.updates.active({ handoff: value.journal })
    if (canonicalJson(current) !== canonicalJson(value.journal) || active?.releaseId !== this.identity.releaseId) throw new Error('Update handoff changed before presentation')
    const completed = current.state === 'completed' ? current : { ...current, state: 'completed', completedAt: new Date().toISOString() }
    await this.updates.activateSequence(completed)
    await this.updates.supersedeRecovery(completed)
    if (current.state !== 'completed') await this.updates.writeJournal(completed)
    await this.updates.verifyCompletion(completed)
    return { state: 'completed', journal: completed, active }
  }
  async capture({ reason, databaseWriter = this.identity }) { return this.recovery.capture({ database: this.database, release: this.identity, databaseWriter, reason }) }
  async recoveryPoint() { return this.recovery.latestManual() }
  async updateRecoveryPoint() {
    const journal = await this.updates.journal(); if (!journal) return null
    const point = await this.recovery.verify(journal.recoveryPoint)
    if (point.manifest.update !== journal.targetIdentity.releaseId) throw new Error('Journal-selected recovery point does not match its update')
    return { ...point, recoveryKit: journal.recoveryKit }
  }
  async restore({ stopBackend, backendLive = () => false }) {
    const boundary = updateBoundary(await this.activity()); if (!boundary.safe) throw new Error(boundary.reasons.join('\n'))
    const point = await this.recovery.latestManual(); if (!point) throw new Error('No manual recovery point')
    if (point.manifest.update !== null) throw new Error('Update recovery must restore its exact application and database together')
    if (point.manifest.release.releaseId !== this.identity.releaseId || point.manifest.databaseWriter?.releaseId !== this.identity.releaseId) throw new Error('Recovery point belongs to a different release writer')
    const q = await this.quiesce()
    if (q?.quiesced !== true || q.activeMutations !== 0 || q.activeClaims !== 0 || q.jobs?.nonterminal !== 0) {
      await this.resume?.().catch(() => {})
      throw new Error('Database could not quiesce')
    }
    let closed = false
    try { await stopBackend(); closed = true; return await this.recovery.restore(point, this.database) }
    catch (error) {
      if (!closed && backendLive()) await this.resume?.().catch(() => {})
      else error.backendStopped = true
      throw error
    }
  }
}

export async function confirmRenderedFrame(window) {
  if (!window || window.isDestroyed?.() === true || window.webContents?.isDestroyed?.() === true) {
    throw new Error('Application window closed before presenting a frame')
  }
  const rendererFrame = await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', true)
  if (rendererFrame !== true || window.isDestroyed?.() === true || window.webContents?.isDestroyed?.() === true) {
    throw new Error('Renderer did not confirm an application frame')
  }
  const capture = await window.capturePage()
  const size = capture?.getSize?.(), bytes = capture?.toPNG?.()
  if (capture?.isEmpty?.() !== false || !size || size.width < 1 || size.height < 1
      || !Buffer.isBuffer(bytes) || bytes.length < 1) {
    throw new Error('Compositor did not confirm a nonempty application frame')
  }
  return { rendererFrame: true, captureBytes: bytes.length, width: size.width, height: size.height }
}

export async function presentAndCompleteStartup(controller, reconciliation, { load, ready, show, confirm }) {
  if (![load, ready, show, confirm].every(value => typeof value === 'function')) {
    throw new Error('Application presentation requires load, readiness, show, and frame confirmation')
  }
  // Subscribe to ready-to-show before starting navigation so a fast first
  // compositor frame cannot race the listener installation.
  await Promise.all([ready(), load()])
  await show()
  const evidence = await confirm()
  if (evidence?.rendererFrame !== true || !Number.isSafeInteger(evidence.captureBytes) || evidence.captureBytes < 1) {
    throw new Error('Application presentation evidence is invalid')
  }
  return controller.completeStartup(reconciliation)
}

export function describeStagedUpdate(review) {
  const target = review.manifest.files.find(file => file.role === 'application')
  return [`Release identity: ${review.manifest.identity.releaseId}`, `Target: ${target.platform}-${target.arch}`,
    `Database schema history: ${review.database.revision ?? 'unrecorded'} → ${review.manifest.requires.schemaHistory}`,
    ...review.plan.blocking, ...review.boundary.reasons].join('\n')
}
