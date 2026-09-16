// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, link, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, assertReleaseIdentity, assertReleasePolicy, deriveReleaseIdentity, sha256Hex, PORTABLE_MAGIC, inspectPortablePayload, parsePortablePayload, portableFileBytes } from '../release.mjs'
export { PORTABLE_MAGIC, inspectPortablePayload } from '../release.mjs'

const execFile = promisify(execFileCallback)

export async function verifyPackagingSource({ repositoryDirectory, provenance, execFileImpl = execFile }) {
  if (!provenance || !/^[0-9a-f]{40}$/.test(provenance.sourceCommit || '')) throw new Error('Native source provenance lacks a full Git commit')
  if (provenance.sourceExport === true) throw new Error('Export packaging requires a separately authenticated source manifest; no verifier is configured')
  if (provenance.sourceExport !== false || provenance.sourceDirty !== false) throw new Error('Native source provenance is not a clean checkout')
  let head, status
  try {
    ;({ stdout: head } = await execFileImpl('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repositoryDirectory, encoding: 'utf8' }))
    ;({ stdout: status } = await execFileImpl('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryDirectory, encoding: 'utf8' }))
  } catch (error) {
    throw new Error(`Cannot inspect packaging Git checkout: ${error.message}`)
  }
  if (head.trim().toLowerCase() !== provenance.sourceCommit || status.length !== 0) {
    throw new Error('Packaging checkout must be clean, include all untracked-file checks, and exactly match native provenance')
  }
  return provenance.sourceCommit
}

async function walk(root, current = root) {
  const { readdir, readlink } = await import('node:fs/promises')
  const out = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name)
    if (entry.isSymbolicLink()) {
      const raw = await readlink(path)
      if (isAbsolute(raw) || raw.includes('\\')) throw new Error(`Portable symlink is not internal: ${relative(root, path)}`)
      const destination = resolve(dirname(path), raw); const target = relative(root, destination).split(sep).join('/')
      if (target === '..' || target.startsWith('../')) throw new Error(`Portable symlink escapes payload: ${relative(root, path)}`)
      out.push({ path, type: 'symlink', target: safePath(target) })
    } else if (entry.isDirectory()) { out.push({ path, type: 'directory' }); out.push(...await walk(root, path)) }
    else if (entry.isFile()) out.push({ path, type: 'file' })
    else throw new Error(`Unsupported portable payload entry: ${relative(root, path)}`)
  }
  return out
}
function targetEntrypoint(platform, productName = 'Singhouse') {
  if (platform === 'linux') return productName
  if (platform === 'win32') return `${productName}.exe`
  if (platform === 'darwin') return `${productName}.app/Contents/MacOS/${productName}`
  throw new Error('Unsupported portable target platform')
}
function safePath(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length >= 1024 || path.startsWith('/') || path.includes('\\') || !path.split('/').every(part => /^[A-Za-z0-9@._+() -]+$/.test(part) && part.trim() === part && !['', '.', '..'].includes(part) && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe portable path: ${path}`)
  return path
}
async function publishNew(temporary, destination) {
  try {
    await link(temporary, destination)
    try { const directory = await open(dirname(destination), 'r'); try { await directory.sync() } finally { await directory.close() } }
    catch (error) { if (!['EISDIR', 'EPERM', 'EINVAL'].includes(error.code)) throw error }
  } finally { await rm(temporary, { force: true }) }
}
export async function writeImmutableFile(output, bytes, mode = 0o644) {
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.partial-${process.pid}`; const handle = await open(temporary, 'wx', mode)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await publishNew(temporary, output)
}

function digestRecords(records) { return sha256Hex(canonicalJson(Object.fromEntries(records.map(record => [record.path, record.type === 'symlink' ? `symlink:${record.target}` : record.type === 'directory' ? 'directory' : record.sha256])))) }
function receiptInventory(records) {
  return records.map(record => record.type === 'file'
    ? { type: 'file', path: record.path, sha256: record.sha256 }
    : record.type === 'directory' ? { type: 'directory', path: record.path }
      : { type: 'symlink', path: record.path, target: record.target })
}
export async function inspectApplicationInventory(applicationDirectory) {
  const root = resolve(applicationDirectory)
  const entries = (await walk(root)).sort((a, b) => Buffer.from(relative(root, a.path)).compare(Buffer.from(relative(root, b.path))))
  const records = await Promise.all(entries.map(async entry => ({
    path: relative(root, entry.path).split(sep).join('/'), type: entry.type,
    ...(entry.type === 'file' ? { sha256: sha256Hex(await readFile(entry.path)) } : entry.type === 'symlink' ? { target: entry.target } : {}),
  })))
  const files = receiptInventory(records)
  return { records, files, inventoryDigest: sha256Hex(canonicalJson(files)) }
}
function singleFile(files, predicate, label) {
  const matches = files.filter(file => predicate(file.path))
  if (matches.length !== 1) throw new Error(`Portable application requires exactly one ${label}`)
  return matches[0]
}

export async function deriveIdentityFromApplication({ applicationDirectory, policy, packageLock }) {
  assertReleasePolicy(policy)
  const root = resolve(applicationDirectory)
  const { records, inventoryDigest } = await inspectApplicationInventory(root)
  const asar = singleFile(records, path => /(^|\/)resources\/app\.asar$/i.test(path), 'app.asar')
  const nativeManifest = singleFile(records, path => /(^|\/)resources\/native\/manifest\.json$/i.test(path), 'native manifest')
  const prefix = nativeManifest.path.slice(0, -'manifest.json'.length)
  const nativeFilesRecord = singleFile(records, path => path === `${prefix}files.json`, 'native file inventory')
  const provenanceRecord = singleFile(records, path => path === `${prefix}provenance.json`, 'native provenance')
  const assemblyRecord = singleFile(records, path => path === `${prefix}assembly.json`, 'assembly descriptor')
  const get = async record => JSON.parse(await readFile(resolve(root, record.path), 'utf8'))
  const native = await get(nativeManifest); const files = await get(nativeFilesRecord); const provenance = await get(provenanceRecord); const assembly = await get(assemblyRecord)
  if (assembly.edition !== policy.edition) throw new Error('Release policy edition does not match the packaged assembly')
  if (provenance.sourceDirty !== false || provenance.sourceExport !== false || provenance.sourceCommit !== assembly.sourceCommit && assembly.sourceCommit !== undefined) throw new Error('Release builds require a clean Git checkout')
  if (assembly.payloadDigest !== sha256Hex(canonicalJson(files)) || native.runtimeId !== nativeFilesRecord.sha256) throw new Error('Native assembly identity is inconsistent')
  const staticRecords = Object.entries(files).filter(([path]) => path.startsWith('static/')).map(([path, sha256]) => ({ path, sha256 }))
  const backendRecords = Object.entries(files).filter(([path]) => path === 'backend.py' || /site-packages\/(karaoke_backend|lyricsync)\//.test(path)).map(([path, sha256]) => ({ path, sha256 }))
  if (!staticRecords.length || !backendRecords.length || !files['models.json']) throw new Error('Native assembly lacks frontend, backend, or model policy evidence')
  const electronRecord = packageLock.packages?.['node_modules/electron']; if (!electronRecord?.version) throw new Error('Electron lock evidence is absent')
  const electronRecords = records.filter(record => record.path !== asar.path && !record.path.startsWith(prefix))
  if (!electronRecords.length) throw new Error('Packaged Electron runtime evidence is absent')
  return deriveReleaseIdentity({
    schema: 1, appVersion: native.appVersion, edition: assembly.edition, policyId: policy.policyId, sourceCommit: provenance.sourceCommit,
    electronVersion: electronRecord.version, electronRuntimeDigest: digestRecords(electronRecords), electronAppDigest: asar.sha256,
    frontendDigest: digestRecords(staticRecords), backendDigest: digestRecords(backendRecords),
    nativeRuntimeId: native.runtimeId, runtimeLocksDigest: sha256Hex(canonicalJson(provenance.locks)),
    modelPolicyDigest: files['models.json'], schemaHistory: policy.schemaHistory,
    assemblyDigest: assemblyRecord.sha256, applicationInventoryDigest: inventoryDigest,
    ...(assembly.pairedCoreReleaseId ? { pairedCoreReleaseId: assembly.pairedCoreReleaseId } : {}),
  })
}

export async function createPortablePayload({ sourceDirectory, output, identity, platform, arch, entrypoint = targetEntrypoint(platform) }) {
  assertReleaseIdentity(identity)
  if (!['linux', 'win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64') || (platform === 'darwin' && arch !== 'arm64')) throw new Error('Unsupported portable target')
  const source = resolve(sourceDirectory); const entries = (await walk(source)).sort((a, b) => Buffer.from(relative(source, a.path)).compare(Buffer.from(relative(source, b.path))))
  let offset = 0
  const inventory = []
  for (const entry of entries) {
    const name = safePath(relative(source, entry.path).split(sep).join('/'))
    if (entry.type === 'file') {
      const bytes = await readFile(entry.path); const info = await stat(entry.path)
      inventory.push({ type: 'file', path: name, offset, size: bytes.length, sha256: sha256Hex(bytes), mode: info.mode & 0o111 ? 0o755 : 0o644 }); offset += bytes.length
    } else if (entry.type === 'directory') inventory.push({ type: 'directory', path: name, mode: 0o755 })
    else inventory.push({ type: 'symlink', path: name, target: entry.target })
  }
  const foldedPaths = new Map()
  for (const file of inventory) {
    const folded = file.path.toLowerCase()
    const prior = foldedPaths.get(folded)
    if (prior && !(platform === 'linux' && prior.startsWith('resources/native/python/share/terminfo/') && file.path.startsWith('resources/native/python/share/terminfo/'))) {
      throw new Error('Portable payload contains case-colliding paths')
    }
    foldedPaths.set(folded, file.path)
  }
  const names = new Map(inventory.map(record => [record.path, record]))
  for (const record of inventory.filter(record => record.type === 'symlink')) {
    if (!names.has(record.target)) throw new Error(`Portable symlink target is absent: ${record.path}`)
    const seen = new Set([record.path]); let target = names.get(record.target)
    while (target?.type === 'symlink') { if (seen.has(target.path)) throw new Error(`Portable symlink cycle: ${record.path}`); seen.add(target.path); target = names.get(target.target) }
  }
  if (inventory.find(file => file.path === entrypoint)?.mode !== 0o755 || !inventory.some(file => file.type === 'file' && /(^|\/)app\.asar$/.test(file.path)) || !inventory.some(file => file.type === 'file' && /(^|\/)native\/manifest\.json$/.test(file.path)) || !inventory.some(file => file.type === 'file' && /(^|\/)native\/files\.json$/.test(file.path))) throw new Error('Portable payload lacks executable entrypoint, app.asar, or native identity evidence')
  const header = { schema: 1, kind: 'singhouse-portable-application', identity, target: { platform, arch }, entrypoint, files: inventory }
  const headerBytes = Buffer.from(canonicalJson(header)); const length = Buffer.alloc(4); length.writeUInt32BE(headerBytes.length)
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.partial-${process.pid}`; const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.write(PORTABLE_MAGIC); await handle.write(length); await handle.write(headerBytes)
    for (const entry of entries) if (entry.type === 'file') await handle.write(await readFile(entry.path))
    await handle.sync()
  } finally { await handle.close() }
  await publishNew(temporary, output); await chmod(output, 0o644)
  return inspectPortablePayload(output)
}

export async function createReleaseReceipt({ payload, output, sourceCommit, sourceDirty, electronVersion, nativeRuntimeId, verifySourceBeforePublish }) {
  if (typeof verifySourceBeforePublish !== 'function') throw new Error('Receipt publication requires an immediate packaging source verification')
  const inspected = await inspectPortablePayload(payload); const identity = inspected.header.identity
  const parsed = parsePortablePayload(await readFile(payload))
  const asar = singleFile(parsed.header.files, path => /(^|\/)resources\/app\.asar$/i.test(path), 'app.asar')
  const nativeManifest = singleFile(parsed.header.files, path => /(^|\/)resources\/native\/manifest\.json$/i.test(path), 'native manifest')
  const prefix = nativeManifest.path.slice(0, -'manifest.json'.length)
  const nativeFilesRecord = singleFile(parsed.header.files, path => path === `${prefix}files.json`, 'native file inventory')
  const provenanceRecord = singleFile(parsed.header.files, path => path === `${prefix}provenance.json`, 'native provenance')
  const assemblyRecord = singleFile(parsed.header.files, path => path === `${prefix}assembly.json`, 'assembly descriptor')
  const native = JSON.parse(portableFileBytes(parsed, nativeManifest.path).toString('utf8'))
  const files = JSON.parse(portableFileBytes(parsed, nativeFilesRecord.path).toString('utf8'))
  const provenance = JSON.parse(portableFileBytes(parsed, provenanceRecord.path).toString('utf8'))
  const assembly = JSON.parse(portableFileBytes(parsed, assemblyRecord.path).toString('utf8'))
  const staticRecords = Object.entries(files).filter(([path]) => path.startsWith('static/')).map(([path, sha256]) => ({ path, sha256 }))
  const backendRecords = Object.entries(files).filter(([path]) => path === 'backend.py' || /site-packages\/(karaoke_backend|lyricsync)\//.test(path)).map(([path, sha256]) => ({ path, sha256 }))
  const electronRecords = parsed.header.files.filter(record => record.path !== asar.path && !record.path.startsWith(prefix))
  if (sourceDirty !== false || provenance.sourceDirty !== false || provenance.sourceExport !== false || sourceCommit !== provenance.sourceCommit || sourceCommit !== identity.sourceCommit || electronVersion !== identity.electronVersion || nativeRuntimeId !== identity.nativeRuntimeId || asar.sha256 !== identity.electronAppDigest || native.runtimeId !== identity.nativeRuntimeId || nativeFilesRecord.sha256 !== identity.nativeRuntimeId || assemblyRecord.sha256 !== identity.assemblyDigest || assembly.payloadDigest !== sha256Hex(canonicalJson(files)) || files['models.json'] !== identity.modelPolicyDigest || sha256Hex(canonicalJson(provenance.locks)) !== identity.runtimeLocksDigest || digestRecords(staticRecords) !== identity.frontendDigest || digestRecords(backendRecords) !== identity.backendDigest || digestRecords(electronRecords) !== identity.electronRuntimeDigest || assembly.edition !== identity.edition || assembly.pairedCoreReleaseId !== identity.pairedCoreReleaseId) throw new Error('Build evidence does not match the portable application identity')
  const applicationFiles = receiptInventory(inspected.header.files)
  const applicationInventoryDigest = sha256Hex(canonicalJson(applicationFiles))
  if (identity.applicationInventoryDigest !== applicationInventoryDigest) throw new Error('Portable application inventory does not match its release identity')
  const receipt = { schema: 1, kind: 'singhouse-release-receipt', artifact: { name: basename(payload), size: inspected.size, sha256: inspected.sha256 }, identity, target: inspected.header.target,
    application: { schema: 1, entrypoint: inspected.header.entrypoint, inventoryDigest: applicationInventoryDigest, files: applicationFiles },
    evidence: { sourceCommit, sourceClean: true, electronVersion, nativeRuntimeId, payloadInventoryDigest: sha256Hex(canonicalJson(inspected.header.files)) } }
  const encoded = `${canonicalJson(receipt)}\n`
  await verifySourceBeforePublish()
  await writeImmutableFile(output, encoded)
  return receipt
}
export async function inspectReleaseReceipt(path, payloadPath) {
  const raw = await readFile(path, 'utf8'); if (`${canonicalJson(JSON.parse(raw))}\n` !== raw) throw new Error('Non-canonical release receipt')
  const receipt = JSON.parse(raw); const inspected = await inspectPortablePayload(payloadPath)
  assertReleaseIdentity(receipt.identity)
  const applicationFiles = receiptInventory(inspected.header.files)
  if (receipt.schema !== 1 || receipt.kind !== 'singhouse-release-receipt' || receipt.artifact.name !== basename(payloadPath) || receipt.artifact.size !== inspected.size || receipt.artifact.sha256 !== inspected.sha256 || canonicalJson(receipt.identity) !== canonicalJson(inspected.header.identity) || canonicalJson(receipt.target) !== canonicalJson(inspected.header.target) || receipt.application?.entrypoint !== inspected.header.entrypoint || receipt.application?.inventoryDigest !== receipt.identity.applicationInventoryDigest || receipt.application?.inventoryDigest !== sha256Hex(canonicalJson(applicationFiles)) || canonicalJson(receipt.application?.files) !== canonicalJson(applicationFiles)) throw new Error('Release receipt does not bind the portable payload')
  return receipt
}
