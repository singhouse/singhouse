// SPDX-License-Identifier: AGPL-3.0-only
import { execFile as callback } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJson, safePortablePath, validatePortableSymlinkTargets } from '../release.mjs'
import { inspectApplicationInventory } from './release_receipt.mjs'

const execFile = promisify(callback)
const order = (a, b) => Buffer.from(a.path).compare(Buffer.from(b.path))
const runOptions = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000,
  env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }

function canonicalLinkTarget(path, raw) {
  if (!raw || posix.isAbsolute(raw) || raw.includes('\\')) throw new Error(`Unsafe AppImage symlink: ${path}`)
  const target = posix.normalize(posix.join(posix.dirname(path), raw))
  if (!safePortablePath(target)) throw new Error(`Escaping AppImage symlink: ${path}`)
  // Only leading parent components are allowed, with no cancellable prefixes.
  // Collapsing alias/../ lexically can disagree with filesystem resolution when
  // alias is itself a symlink. Canonical relative links cannot hide that escape.
  if (raw !== posix.relative(posix.dirname(path), target)) throw new Error(`Noncanonical AppImage symlink: ${path}`)
  return target
}

// Read-only listing is checked before extraction: no special files, escaping
// paths, ambiguous names, linked parents, dangling links, or link cycles.
export function parseAppImageListing(text) {
  const records = [], names = new Map()
  let root = false
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([dl-][rwx-]{9})\s+\d+\/\d+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+squashfs-root(?:\/(.*))?$/.exec(line)
    if (!match) throw new Error('Unsupported or unsafe unsquashfs listing')
    const [, permissions, entry] = match
    if (entry === undefined) {
      if (root || permissions[0] !== 'd') throw new Error('Invalid AppImage root')
      root = true; continue
    }
    const parts = entry.split(' -> ')
    const type = { d: 'directory', l: 'symlink', '-': 'file' }[permissions[0]]
    if (parts.length !== (type === 'symlink' ? 2 : 1)) throw new Error('Ambiguous AppImage path or symlink')
    const path = parts[0]
    if (!safePortablePath(path) || names.has(path)) throw new Error(`Unsafe or repeated AppImage path: ${path}`)
    const record = { path, type }
    if (type === 'symlink') {
      record.target = canonicalLinkTarget(path, parts[1])
    } else record.executableMode = [3, 6, 9].reduce((mode, index, i) => mode | (permissions[index] === 'x' ? [0o100, 0o010, 0o001][i] : 0), 0)
    names.set(path, record); records.push(record)
  }
  if (!root || !records.length) throw new Error('Empty AppImage listing')
  for (const { path } of records) {
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
      if (names.get(parent)?.type !== 'directory') throw new Error(`AppImage path has a missing or linked parent: ${path}`)
    }
  }
  validatePortableSymlinkTargets(records)
  return records.sort(order)
}

export async function appImageSnapshot(directory) {
  const inventory = await inspectApplicationInventory(directory)
  validatePortableSymlinkTargets(inventory.files)
  const modes = {}
  for (const file of inventory.files) {
    if (file.type === 'symlink') {
      canonicalLinkTarget(file.path, await readlink(join(directory, file.path)))
    } else {
      const mode = (await lstat(join(directory, file.path))).mode
      if (mode & 0o7000) throw new Error(`AppImage application has special permission bits: ${file.path}`)
      modes[file.path] = mode & 0o111
    }
  }
  return { files: inventory.files, modes }
}

export function assertAppImageSnapshot(actual, expected, { allowAdded = false } = {}) {
  const observed = new Map(actual.files.map(file => [file.path, file]))
  for (const file of expected.files) {
    if (canonicalJson(observed.get(file.path) ?? null) !== canonicalJson(file) ||
        actual.modes[file.path] !== expected.modes[file.path]) throw new Error(`AppImage changed modeled application entry: ${file.path}`)
  }
  if (!allowAdded && (actual.files.length !== expected.files.length || canonicalJson(actual.modes) !== canonicalJson(expected.modes))) {
    throw new Error('AppImage contains added or missing application entries or modes')
  }
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function extractAppImage({ image, runtime, destination, run = execFile }) {
  let version
  try { version = (await run('unsquashfs', ['-version'], runOptions)).stdout.split('\n')[0] }
  catch (error) {
    // squashfs-tools 4.x reports its version with exit status 1 on some hosts.
    if (error.code === 1 && /^unsquashfs version /.test(error.stdout ?? '')) version = error.stdout.split('\n')[0]
    else throw new Error(`AppImage packaging requires build-host unsquashfs 4.6 or newer (4.x): ${error.message}`)
  }
  const match = /^unsquashfs version 4\.(\d+)(?:\.\d+)?(?:\s|$)/.exec(version)
  if (!match || Number(match[1]) < 6) throw new Error(`Unsupported unsquashfs version: ${version}`)
  if (!(await lstat(image)).isFile() || !(await lstat(runtime)).isFile()) throw new Error('AppImage and pinned runtime must be regular files')
  const runtimeBytes = await readFile(runtime)
  if (!runtimeBytes.length) throw new Error('AppImage runtime is empty')
  const prefix = Buffer.alloc(runtimeBytes.length + 4)
  const handle = await open(image, 'r')
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    if (bytesRead !== prefix.length || !prefix.subarray(0, runtimeBytes.length).equals(runtimeBytes) ||
        prefix.subarray(runtimeBytes.length).toString('ascii') !== 'hsqs') throw new Error('AppImage runtime prefix or SquashFS offset does not match the selected builder toolset')
  } finally { await handle.close() }
  const offset = String(runtimeBytes.length), before = await digest(image)
  const { stdout } = await run('unsquashfs', ['-lln', '-UTC', '-offset', offset, image], runOptions)
  const listing = parseAppImageListing(stdout)
  // The caller owns the enclosing mkdtemp directory. Refuse an existing target;
  // never extract over another tree, and never run the AppImage executable.
  await mkdir(destination, { mode: 0o700 })
  await run('unsquashfs', ['-strict-errors', '-no-xattrs', '-no-progress', '-processors', '2', '-offset', offset, '-d', destination, image], runOptions)
  if (await digest(image) !== before) throw new Error('AppImage changed during extraction')
  const snapshot = await appImageSnapshot(destination)
  const shape = snapshot.files.map(({ sha256: _hash, ...file }) => ({ ...file,
    ...(file.type !== 'symlink' ? { executableMode: snapshot.modes[file.path] } : {}) }))
  if (canonicalJson(shape) !== canonicalJson(listing)) throw new Error('Extracted AppImage does not match its validated listing')
  return { snapshot, unsquashfsVersion: version }
}

function ownedArtifact(path, directory) {
  const child = relative(directory, resolve(path))
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('AppImage builder returned an artifact outside its owned output directory')
  return path
}

export async function prepareAppImageApplication({ applicationDirectory, runtime, buildImage, run = execFile }) {
  const work = await mkdtemp(join(tmpdir(), 'singhouse-appimage-'))
  try {
    const original = await appImageSnapshot(applicationDirectory)
    const lean = join(work, 'lean')
    await cp(applicationDirectory, lean, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true })
    assertAppImageSnapshot(await appImageSnapshot(lean), original)
    const output = join(work, 'preparatory')
    await mkdir(output)
    const image = ownedArtifact(await buildImage(lean, output), output)
    const complete = join(work, 'complete')
    const { snapshot, unsquashfsVersion } = await extractAppImage({ image, runtime, destination: complete, run })
    assertAppImageSnapshot(snapshot, original, { allowAdded: true })
    const originalNames = new Set(original.files.map(file => file.path))
    // Complete the canonical unpacked application before deriving any release
    // identity. The separate lean input avoids builder-generated link collisions.
    for (const file of snapshot.files) {
      if (originalNames.has(file.path)) continue
      const destination = join(applicationDirectory, file.path)
      if (file.type === 'directory') await mkdir(destination)
      else if (file.type === 'file') await copyFile(join(complete, file.path), destination, constants.COPYFILE_EXCL)
      else await symlink(relative(dirname(destination), join(applicationDirectory, file.target)), destination)
      if (file.type !== 'symlink') await chmod(destination, (await lstat(join(complete, file.path))).mode & 0o777)
    }
    assertAppImageSnapshot(await appImageSnapshot(applicationDirectory), snapshot)
    return { work, lean, runtime, unsquashfsVersion, cleanup: () => rm(work, { recursive: true, force: true }) }
  } catch (error) {
    await rm(work, { recursive: true, force: true })
    throw error
  }
}

export async function verifyAppImageApplication({ image, runtime, expected, run = execFile }) {
  const work = await mkdtemp(join(tmpdir(), 'singhouse-appimage-verify-'))
  try {
    const result = await extractAppImage({ image, runtime, destination: join(work, 'application'), run })
    assertAppImageSnapshot(result.snapshot, expected)
    return result.unsquashfsVersion
  } finally { await rm(work, { recursive: true, force: true }) }
}

export async function publishAppImageArtifact(source, outputDirectory) {
  const destination = join(outputDirectory, basename(source))
  // Stage on the destination filesystem, sync completed bytes and exact mode,
  // then publish with an exclusive hardlink. An interrupted copy never exposes
  // an incomplete final artifact name; another build's final name is preserved.
  const mode = await statMode(source)
  const work = await mkdtemp(join(outputDirectory, '.appimage-publish-'))
  const temporary = join(work, 'artifact')
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(createReadStream(source))
      await handle.chmod(mode) // Explicitly restore mode even under umask 077.
      await handle.sync()
    } finally { await handle.close() }
    await link(temporary, destination)
    try {
      const directory = await open(outputDirectory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) { if (!['EISDIR', 'EPERM', 'EINVAL'].includes(error.code)) throw error }
  } finally { await rm(work, { recursive: true, force: true }) }
  return destination
}
async function statMode(path) {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('Only regular verified artifacts may be published')
  return info.mode & 0o777
}
