// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateManifest } from '../policy.mjs'
import { channelTrustedLocks, validateShippedCatalog } from '../setup_catalog.mjs'

export const PROCESSING_READY = 'processing-ready'
export const PLAYBACK_ONLY = 'playback-only'
// The path main.mjs reads inside app.asar. Source catalogs live one per target
// under CATALOG_DIRECTORY and are mapped onto this name only when packaged.
export const PACKAGED_CATALOG_NAME = 'processing-catalog.json'
export const CATALOG_DIRECTORY = 'processing-catalogs'
const MODE_FLAGS = [`--${PROCESSING_READY}`, `--${PLAYBACK_ONLY}`]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// The exact serialization desktop/build/setup_catalog.mjs writes.
export const canonicalCatalogText = catalog => `${JSON.stringify(catalog, null, 2)}\n`
const regenerate = target => `Regenerate it with desktop/build/setup_catalog.mjs from the runtime, qualification, and terms evidence for ${target}, or package with --${PLAYBACK_ONLY}.`

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

// Source catalog for one target, using the native manifest's platform/arch
// tokens exactly (linux-x64, linux-arm64, darwin-arm64, win32-x64).
export function catalogSourceName({ platform, arch } = {}) {
  if (!/^[a-z0-9]+$/.test(platform ?? '') || !/^[a-z0-9]+$/.test(arch ?? '')) throw new Error('Processing catalog target is invalid')
  return `${CATALOG_DIRECTORY}/${platform}-${arch}.json`
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
export function assertProcessingCatalog({ mode, catalogBytes, identity, locks, modelPolicy, releaseChannel }) {
  if (![PROCESSING_READY, PLAYBACK_ONLY].includes(mode)) throw new Error('Invalid processing packaging mode')
  const target = `${identity?.platform}-${identity?.arch}`
  const source = `desktop/${catalogSourceName(identity)}`
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
    // The exact validation the installed application applies at start.
    catalog = validateShippedCatalog(text, { identity, trustedLocks, modelPolicy, releaseChannel })
    // The shipped bytes must be exactly what desktop/build/setup_catalog.mjs
    // writes for the validated result, so duplicate keys (JSON.parse keeps the
    // last), unknown fields, or reordered keys cannot ride along unreviewed.
    if (text !== canonicalCatalogText(catalog)) throw new Error('catalog is not the generator\'s canonical output; regenerate it')
  } catch (error) {
    throw new Error(`${source} would be rejected by the packaged ${target} application: ${error.message}. ${regenerate(target)}`)
  }
  return { mode, catalogSha256: sha256(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256,
    qualificationScope: catalog.qualification.scope }
}

export async function readProcessingCatalogInputs(desktopDirectory, target) {
  const desktop = resolve(desktopDirectory)
  const name = catalogSourceName(target)
  let catalogBytes = null
  try { catalogBytes = await readFile(resolve(desktop, name)) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read desktop/${name}: ${error.code || error.message}`) }
  const json = async file => JSON.parse(await readFile(resolve(desktop, file), 'utf8'))
  return { catalogBytes, locks: await json('processing-locks.json'), modelPolicy: await json('models.json') }
}

// Decides what this packaging run ships, before electron-builder runs. Returns
// the record facts, the exact validated bytes to package (processing-ready
// only), and operator notices.
export async function prepareProcessingGate({ desktopDir, nativeManifest, appVersion, releaseChannel, argv, env }) {
  const mode = processingModeFromArgs(argv, env)
  const identity = packagedCatalogIdentity(nativeManifest, appVersion)
  const inputs = await readProcessingCatalogInputs(desktopDir, identity)
  const { notice, ...facts } = assertProcessingCatalog({ mode, identity, releaseChannel, ...inputs })
  const notices = notice ? [notice] : []
  try {
    await lstat(resolve(desktopDir, PACKAGED_CATALOG_NAME))
    notices.push(`desktop/${PACKAGED_CATALOG_NAME} is not a catalog source and is never packaged; catalogs are read only from desktop/${CATALOG_DIRECTORY}/<platform>-<arch>.json.`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { result: { ...facts, target: { platform: identity.platform, arch: identity.arch } },
    catalogBytes: mode === PROCESSING_READY ? inputs.catalogBytes : null, notices }
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
export function processingModeRecord({ mode, releaseId, releaseChannel, electronAppDigest, catalogSha256, runtimeLockSha256, qualificationScope, target }) {
  if (!/^[0-9a-f]{64}$/.test(releaseId ?? '') || !/^[0-9a-f]{64}$/.test(electronAppDigest ?? '')
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(releaseChannel ?? '')) throw new Error('Processing mode record requires the derived release identity and packaged release channel')
  return { schema: 1, mode, releaseId, releaseChannel, electronAppDigest, catalogSha256, runtimeLockSha256, qualificationScope,
    target: { platform: target.platform, arch: target.arch } }
}
