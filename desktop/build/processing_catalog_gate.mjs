// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { lstat, readFile, open, readdir, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateManifest } from '../policy.mjs'
import { channelTrustedLocks, validateShippedCatalog } from '../setup_catalog.mjs'

export const PROCESSING_READY = 'processing-ready'
export const PLAYBACK_ONLY = 'playback-only'
// The path main.mjs reads inside app.asar. Source catalogs live one per target
// under CATALOG_DIRECTORY and are mapped onto this name only when packaged.
export const PACKAGED_CATALOG_NAME = 'processing-catalog.json'
export const CATALOG_DIRECTORY = 'processing-catalogs'
export const PROCESSING_ARTIFACTS_DIRECTORY = 'processing-artifacts'
const MODE_FLAGS = [`--${PROCESSING_READY}`, `--${PLAYBACK_ONLY}`]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// The exact serialization desktop/build/setup_catalog.mjs writes.
export const canonicalCatalogText = catalog => `${JSON.stringify(catalog, null, 2)}\n`
const regenerate = target => `Regenerate it with desktop/build/setup_catalog.mjs from the runtime, qualification, and terms evidence for ${target}, or package with --${PLAYBACK_ONLY}.`

// Publication URLs remain the recipe's identity. Only exact flat release
// assets from this repository are installer inputs; upstream inputs stay online.
export function processingArtifactInventory(catalog) {
  const assets = new Map()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    const match = typeof value.url === 'string' && value.url.match(/^https:\/\/github\.com\/singhouse\/processing-packs\/releases\/download\/[A-Za-z0-9._-]+\/([a-f0-9]{64})-([A-Za-z0-9._+-]+)$/)
    if (match) {
      if (value.sha256 !== match[1] || (value.filename !== undefined && value.filename !== match[2])
          || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('Processing release asset identity is invalid')
      const name = `${match[1]}-${match[2]}`
      const asset = { name, sha256: value.sha256, size: value.size }
      if (assets.has(name) && assets.get(name).size !== asset.size) throw new Error(`Conflicting processing release asset: ${name}`)
      assets.set(name, asset)
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(catalog)
  return [...assets.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function assertArtifactDirectory(directory) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Processing artifacts directory must be a real directory')
}

// Open without following links, compare the opened inode, and check it again
// after streaming. Staging copies from the verified descriptor, never a glob.
export async function verifyProcessingArtifact(directory, asset, destination) {
  if (!/^[a-f0-9]{64}-[A-Za-z0-9._+-]+$/.test(asset?.name ?? '')
      || !asset.name.startsWith(`${asset.sha256}-`) || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error('Invalid processing artifact inventory')
  await assertArtifactDirectory(directory)
  const path = join(directory, asset.name)
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new Error(`Processing artifact must be a regular unlinked file: ${asset.name}`)
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  let target
  try {
    const opened = await source.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== initial.ino || opened.dev !== initial.dev
        || opened.size !== asset.size) throw new Error(`Processing artifact size or file identity differs: ${asset.name}`)
    if (destination) target = await open(destination, 'wx', 0o600)
    const digest = createHash('sha256')
    let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      digest.update(chunk); size += chunk.length
      if (target) await target.writeFile(chunk)
    }
    const final = await source.stat()
    const entry = await lstat(path)
    if (size !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error(`Processing artifact hash or size differs: ${asset.name}`)
    if (final.nlink !== 1 || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs
        || entry.isSymbolicLink() || entry.ino !== opened.ino || entry.dev !== opened.dev) throw new Error(`Processing artifact changed during verification: ${asset.name}`)
  } finally { await target?.close(); await source.close() }
}

export async function stageProcessingArtifacts({ mode, directory, inventory = [] }) {
  if (mode === PLAYBACK_ONLY && inventory.length) throw new Error('Playback-only packaging cannot stage processing artifacts')
  if (![PLAYBACK_ONLY, PROCESSING_READY].includes(mode)) throw new Error('Invalid processing artifact packaging mode')
  if (!inventory.length) return { extraResources: [], cleanup: async () => {}, label: null }
  const staged = await mkdtemp(join(tmpdir(), 'singhouse-processing-artifacts-'))
  const cleanup = () => rm(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  try {
    for (const asset of inventory) await verifyProcessingArtifact(directory, asset, join(staged, asset.name))
  } catch (error) { await cleanup(); throw error }
  return { extraResources: [{ from: staged, to: PROCESSING_ARTIFACTS_DIRECTORY, filter: inventory.map(asset => asset.name) }], cleanup, label: staged }
}

export async function verifyPackagedProcessingArtifacts({ mode, processingArtifacts = [] }, directory) {
  if (![PLAYBACK_ONLY, PROCESSING_READY].includes(mode)) throw new Error('Packaged processing artifacts check requires a gate result')
  let entries
  try { await assertArtifactDirectory(directory); entries = await readdir(directory) }
  catch (error) { if (error.code === 'ENOENT' && !processingArtifacts.length) return; throw error }
  if (mode === PLAYBACK_ONLY) throw new Error('Playback-only packaging produced processing artifacts')
  if (JSON.stringify(entries.sort()) !== JSON.stringify(processingArtifacts.map(asset => asset.name).sort())) throw new Error('Packaged processing artifact inventory differs from the validated catalog')
  for (const asset of processingArtifacts) await verifyProcessingArtifact(directory, asset)
}

// Every packaging run states what it ships: exactly one of the two exact flags.
// npm consumes `npm run package --playback-only` (without `--`) as its own
// configuration and exposes it only as npm_config_*; that is refused rather
// than guessed at, so the operator's intent is never silently dropped.
export function processingModeFromArgs(argv, env = {}) {
  for (const arg of argv) {
    if (typeof arg !== 'string' || MODE_FLAGS.includes(arg)) continue
    for (const flag of MODE_FLAGS) {
      if (arg.startsWith(flag)) throw new Error(`Unrecognized packaging option ${JSON.stringify(arg.slice(0, 64))}; use exactly ${flag}`)
    }
  }
  for (const name of ['npm_config_processing_ready', 'npm_config_playback_only']) {
    if (env?.[name] !== undefined) {
      throw new Error(`npm consumed a processing mode flag as its own configuration (${name} is set). Pass packaging flags after \`--\`, for example: npm --prefix desktop run package -- --${PLAYBACK_ONLY}`)
    }
  }
  const named = argv.filter(arg => MODE_FLAGS.includes(arg))
  if (new Set(named).size > 1) throw new Error(`--${PROCESSING_READY} and --${PLAYBACK_ONLY} are mutually exclusive`)
  if (named.length !== 1) {
    throw new Error(`Packaging requires exactly one of --${PROCESSING_READY} or --${PLAYBACK_ONLY}, for example: npm --prefix desktop run package -- --${PLAYBACK_ONLY}`)
  }
  return named[0].slice(2)
}

export function processingAcceleratorFromArgs(argv, env = {}, mode) {
  if (env?.npm_config_processing_accelerator !== undefined) throw new Error('npm consumed --processing-accelerator; pass packaging flags after `--`')
  const flag = '--processing-accelerator'
  const selectors = argv.filter(arg => typeof arg === 'string' && arg.startsWith(flag))
  if (!selectors.length) return undefined
  if (selectors.length !== 1 || selectors[0] !== flag) throw new Error('Use exactly one --processing-accelerator cpu|cuda|metal')
  const accelerator = argv[argv.indexOf(flag) + 1]
  if (!['cpu', 'cuda', 'metal'].includes(accelerator)) throw new Error('--processing-accelerator requires cpu, cuda, or metal')
  if ((mode ?? processingModeFromArgs(argv, env)) !== PROCESSING_READY) throw new Error('--processing-accelerator requires --processing-ready')
  return accelerator
}

export function processingArtifactSuffix(accelerator) {
  if (accelerator === undefined) return ''
  if (!['cpu', 'cuda', 'metal'].includes(accelerator)) throw new Error('Invalid processing accelerator')
  return `-${accelerator}`
}

// Source catalog for one target, using the native manifest's platform/arch
// tokens exactly (linux-x64, linux-arm64, darwin-arm64, win32-x64).
export function catalogSourceName({ platform, arch } = {}, accelerator) {
  if (!/^[a-z0-9]+$/.test(platform ?? '') || !/^[a-z0-9]+$/.test(arch ?? '')) throw new Error('Processing catalog target is invalid')
  if (accelerator !== undefined && !({ 'win32-x64': ['cpu', 'cuda'], 'linux-x64': ['cpu', 'cuda'],
    'linux-arm64': ['cpu'], 'darwin-arm64': ['cpu', 'metal'] }[`${platform}-${arch}`] || []).includes(accelerator)) {
    throw new Error('Processing accelerator is unsupported for this target')
  }
  return `${CATALOG_DIRECTORY}/${platform}-${arch}${processingArtifactSuffix(accelerator)}.json`
}

// The packaged application validates its catalog against the native manifest
// as accepted at launch (policy.validateManifest with app.getVersion() and the
// running platform/arch). The target is the platform/arch being packaged.
export function packagedCatalogIdentity(nativeManifest, appVersion) {
  return validateManifest(nativeManifest, appVersion, nativeManifest?.platform, nativeManifest?.arch)
}

// catalogBytes is null when the target's source catalog is absent. Locks and
// model policy are the application's own desktop/processing-locks.json and
// desktop/models.json. releaseChannel is the channel of the release policy
// being packaged: the installed application validates the catalog against that
// channel, so a private-smoke or hardware-test catalog cannot be packaged under
// any other.
export function assertProcessingCatalog({ mode, catalogBytes, identity, locks, modelPolicy, releaseChannel, nativeLockSha256, accelerator }) {
  if (![PROCESSING_READY, PLAYBACK_ONLY].includes(mode)) throw new Error('Invalid processing packaging mode')
  const target = `${identity?.platform}-${identity?.arch}`
  const source = `desktop/${catalogSourceName(identity, accelerator)}`
  if (accelerator !== undefined && mode !== PROCESSING_READY) throw new Error('--processing-accelerator requires --processing-ready')
  const present = catalogBytes !== null && catalogBytes !== undefined
  if (mode === PLAYBACK_ONLY) {
    // A committed catalog for this target is deliberately left out; it is
    // neither validated nor packaged.
    return { mode, catalogSha256: null, runtimeLockSha256: null, qualificationScope: null,
      notice: present ? `Processing catalog ${source} exists but is deliberately excluded: --${PLAYBACK_ONLY} packages no catalog.` : undefined }
  }
  if (!present) throw new Error(`--${PROCESSING_READY} requires ${source}. ${regenerate(target)}`)
  let catalog
  try {
    // The same channel-scoped lock trust the installed application applies.
    const trustedLocks = channelTrustedLocks(locks, releaseChannel)
    const text = Buffer.from(catalogBytes).toString('utf8')
    let parsed
    try { parsed = JSON.parse(text) } catch (error) { throw new Error(`not JSON: ${error.message}`) }
    if (parsed?.runtime && (parsed.runtime.platform !== identity?.platform || parsed.runtime.arch !== identity?.arch)) {
      throw new Error(`catalog runtime targets ${parsed.runtime.platform}-${parsed.runtime.arch}, not the packaged ${target}`)
    }
    if (accelerator !== undefined && parsed?.runtime?.accelerator !== accelerator) throw new Error(`Catalog runtime accelerator does not match requested ${accelerator}`)
    // The exact validation the installed application applies at start.
    catalog = validateShippedCatalog(text, { identity, trustedLocks, modelPolicy, releaseChannel })
    if (catalog.runtime.schema === 2 && (!/^[a-f0-9]{64}$/.test(nativeLockSha256 || '')
        || catalog.runtime.recipe.nativeTools.nativeLockSha256 !== nativeLockSha256)) {
      throw new Error('Processing recipe native tools differ from the assembled application')
    }
    // The shipped bytes must be exactly what desktop/build/setup_catalog.mjs
    // writes for the validated result, so duplicate keys (JSON.parse keeps the
    // last), unknown fields, or reordered keys cannot ride along unreviewed.
    if (text !== canonicalCatalogText(catalog)) throw new Error('catalog is not the generator\'s canonical output; regenerate it')
  } catch (error) {
    throw new Error(`${source} would be rejected by the packaged ${target} application: ${error.message}. ${regenerate(target)}`)
  }
  return { mode, catalogSha256: sha256(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256,
    qualificationScope: catalog.qualification.scope, ...(accelerator === undefined ? {} : { accelerator }) }
}

export async function readProcessingCatalogInputs(desktopDirectory, target, accelerator) {
  const desktop = resolve(desktopDirectory)
  const name = catalogSourceName(target, accelerator)
  let catalogBytes = null
  try { catalogBytes = await readFile(resolve(desktop, name)) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read desktop/${name}: ${error.code || error.message}`) }
  const json = async file => JSON.parse(await readFile(resolve(desktop, file), 'utf8'))
  return { catalogBytes, locks: await json('processing-locks.json'), modelPolicy: await json('models.json') }
}

// Decides what this packaging run ships, before electron-builder runs. Returns
// the record facts, the exact validated bytes to package (processing-ready
// only), and operator notices.
export async function prepareProcessingGate({ desktopDir, nativeManifest, appVersion, releaseChannel, argv, env, nativeLockSha256 }) {
  const mode = processingModeFromArgs(argv, env)
  const accelerator = processingAcceleratorFromArgs(argv, env, mode)
  const identity = packagedCatalogIdentity(nativeManifest, appVersion)
  const inputs = await readProcessingCatalogInputs(desktopDir, identity, accelerator)
  const { notice, ...facts } = assertProcessingCatalog({ mode, identity, releaseChannel, nativeLockSha256, accelerator, ...inputs })
  const processingArtifacts = mode === PROCESSING_READY ? processingArtifactInventory(JSON.parse(inputs.catalogBytes)) : []
  const artifactsDirectory = processingArtifacts.length ? env?.KARAOKE_PROCESSING_ARTIFACTS : undefined
  if (processingArtifacts.length && (typeof artifactsDirectory !== 'string' || !artifactsDirectory.trim())) throw new Error('Processing-ready packaging requires KARAOKE_PROCESSING_ARTIFACTS for the catalog release assets')
  for (const asset of processingArtifacts) await verifyProcessingArtifact(resolve(artifactsDirectory), asset)
  const notices = notice ? [notice] : []
  try {
    await lstat(resolve(desktopDir, PACKAGED_CATALOG_NAME))
    notices.push(`desktop/${PACKAGED_CATALOG_NAME} is not a catalog source and is never packaged; catalogs are read only from desktop/${CATALOG_DIRECTORY}/<platform>-<arch>.json.`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { result: { ...facts, target: { platform: identity.platform, arch: identity.arch }, ...(processingArtifacts.length ? { processingArtifacts } : {}) },
    ...(artifactsDirectory ? { artifactsDirectory } : {}), catalogBytes: mode === PROCESSING_READY ? inputs.catalogBytes : null, notices }
}

// The digest of processing-catalog.json at the root of a packaged app.asar, or
// null when the archive contains no such entry. Anything other than a regular
// file at that name fails closed. @electron/asar is a locked build dependency,
// loaded only here so dependency-free test runs can import this module.
export async function packagedCatalogSha256(archivePath) {
  const { extractFile, statFile, uncache } = await import('@electron/asar')
  uncache(archivePath)
  try {
    let entry
    try { entry = statFile(archivePath, PACKAGED_CATALOG_NAME, false) }
    catch (error) { if (/was not found in this archive/.test(error.message)) return null; throw error }
    if ('files' in entry || 'link' in entry) throw new Error(`Packaged ${PACKAGED_CATALOG_NAME} is not a regular file`)
    return sha256(extractFile(archivePath, PACKAGED_CATALOG_NAME, false))
  } finally { uncache(archivePath) }
}

// packagedSha256 is the observed digest of the catalog inside the produced
// application, or null when the application contains none.
export function assertPackagedProcessingCatalog(gate, packagedSha256) {
  if (gate?.mode === PROCESSING_READY) {
    if (!/^[0-9a-f]{64}$/.test(gate.catalogSha256 ?? '')) throw new Error('Processing-ready gate result has no validated catalog digest')
    if (!packagedSha256) throw new Error(`Processing-ready packaging produced an application without ${PACKAGED_CATALOG_NAME}`)
    if (packagedSha256 !== gate.catalogSha256) throw new Error(`Packaged ${PACKAGED_CATALOG_NAME} differs from the validated source catalog`)
  } else if (gate?.mode === PLAYBACK_ONLY) {
    if (packagedSha256 !== null) throw new Error(`Playback-only packaging produced an application containing ${PACKAGED_CATALOG_NAME}`)
  } else throw new Error('Packaged processing catalog check requires a gate result')
  return gate
}

// The durable per-build record written next to the release receipt. It is not
// part of the receipt schema; releaseId and electronAppDigest bind it to the
// derived identity of the application it describes (the digest is that of the
// app.asar carrying the catalog), and releaseChannel is the packaged policy's.
export function processingModeRecord({ mode, releaseId, releaseChannel, electronAppDigest, catalogSha256, runtimeLockSha256, qualificationScope, target, accelerator, processingArtifacts }) {
  if (accelerator !== undefined) {
    if (mode !== PROCESSING_READY) throw new Error('Processing accelerator record requires processing-ready mode')
    catalogSourceName(target, accelerator)
  }
  if (!/^[0-9a-f]{64}$/.test(releaseId ?? '') || !/^[0-9a-f]{64}$/.test(electronAppDigest ?? '')
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(releaseChannel ?? '')) throw new Error('Processing mode record requires the derived release identity and packaged release channel')
  return { schema: 1, mode, releaseId, releaseChannel, electronAppDigest, catalogSha256, runtimeLockSha256, qualificationScope,
    target: { platform: target.platform, arch: target.arch }, ...(accelerator === undefined ? {} : { accelerator }),
    ...(processingArtifacts?.length ? { processingArtifacts } : {}) }
}
