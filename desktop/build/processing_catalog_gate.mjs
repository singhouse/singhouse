// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateManifest } from '../policy.mjs'
import { validateSetupCatalog } from '../setup_catalog.mjs'

export const PROCESSING_READY = 'processing-ready'
export const PLAYBACK_ONLY = 'playback-only'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const regenerate = 'Regenerate it with desktop/build/setup_catalog.mjs from the runtime, qualification, and terms evidence for this exact target, or package with --playback-only.'

// Signed candidates must state what they ship; unsigned development builds may
// omit the mode, in which case the catalog file on disk decides (and is still
// validated when present).
export function processingModeFromArgs(argv, { signed = false } = {}) {
  const ready = argv.includes(`--${PROCESSING_READY}`), playback = argv.includes(`--${PLAYBACK_ONLY}`)
  if (ready && playback) throw new Error(`--${PROCESSING_READY} and --${PLAYBACK_ONLY} are mutually exclusive`)
  if (signed && !ready && !playback) throw new Error(`Signed releases must name --${PROCESSING_READY} or --${PLAYBACK_ONLY}`)
  return ready ? PROCESSING_READY : playback ? PLAYBACK_ONLY : null
}

// The packaged application validates its catalog against the native manifest
// as accepted at launch (policy.validateManifest with app.getVersion() and the
// running platform/arch). The target is the platform/arch being packaged.
export function packagedCatalogIdentity(nativeManifest, appVersion) {
  return validateManifest(nativeManifest, appVersion, nativeManifest?.platform, nativeManifest?.arch)
}

// catalogBytes is null when desktop/processing-catalog.json is absent. Locks and
// model policy are the application's own desktop/processing-locks.json and
// desktop/models.json, read and checked exactly as main.mjs does at launch.
// releaseChannel is the channel of the release policy being packaged: the
// installed application validates the catalog against that channel, so a
// private-smoke catalog cannot be packaged under any other channel.
export function assertProcessingCatalog({ mode = null, catalogBytes, identity, locks, modelPolicy, releaseChannel }) {
  if (![null, PROCESSING_READY, PLAYBACK_ONLY].includes(mode)) throw new Error('Invalid processing packaging mode')
  if (catalogBytes === null || catalogBytes === undefined) {
    if (mode === PROCESSING_READY) throw new Error(`--${PROCESSING_READY} requires desktop/processing-catalog.json. ${regenerate}`)
    return { mode: PLAYBACK_ONLY, explicit: mode !== null, catalogSha256: null, runtimeLockSha256: null, qualificationScope: null,
      notice: mode === null ? 'No processing mode named and desktop/processing-catalog.json is absent: this build is playback-only and its first-launch setup will report local song processing unavailable.' : undefined }
  }
  if (mode === PLAYBACK_ONLY) throw new Error(`--${PLAYBACK_ONLY} requires desktop/processing-catalog.json to be absent; remove it or package with --${PROCESSING_READY}`)
  const target = `${identity?.platform}-${identity?.arch}`
  let catalog
  try {
    if (locks?.schema !== 1 || !Array.isArray(locks.lockSha256)) throw new Error('Invalid application processing lock policy')
    try { catalog = JSON.parse(Buffer.from(catalogBytes).toString('utf8')) } catch (error) { throw new Error(`not JSON: ${error.message}`) }
    if (catalog?.runtime && (catalog.runtime.platform !== identity?.platform || catalog.runtime.arch !== identity?.arch)) {
      throw new Error(`catalog runtime targets ${catalog.runtime.platform}-${catalog.runtime.arch}, not the packaged ${target}`)
    }
    // Production rules: HTTPS-only runtime sources, never private-test local files.
    catalog = validateSetupCatalog(catalog, { identity, trustedLocks: locks.lockSha256, modelPolicy, privateTestLocalSources: false, releaseChannel })
  } catch (error) {
    throw new Error(`desktop/processing-catalog.json would be rejected by the packaged ${target} application: ${error.message}. ${regenerate}`)
  }
  return { mode: PROCESSING_READY, explicit: mode !== null, catalogSha256: sha256(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256,
    qualificationScope: catalog.qualification.scope }
}

export async function readProcessingCatalogInputs(desktopDirectory) {
  const desktop = resolve(desktopDirectory)
  let catalogBytes = null
  try { catalogBytes = await readFile(resolve(desktop, 'processing-catalog.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read desktop/processing-catalog.json: ${error.message}`) }
  const json = async name => JSON.parse(await readFile(resolve(desktop, name), 'utf8'))
  return { catalogBytes, locks: await json('processing-locks.json'), modelPolicy: await json('models.json') }
}

// packagedCatalogSha256 is the observed digest of the catalog inside the
// produced application, or null when the application contains none.
export function assertPackagedProcessingCatalog(gate, packagedCatalogSha256) {
  if (gate?.mode === PROCESSING_READY) {
    if (!packagedCatalogSha256) throw new Error('Processing-ready packaging produced an application without processing-catalog.json')
    if (packagedCatalogSha256 !== gate.catalogSha256) throw new Error('Packaged processing-catalog.json differs from the validated source catalog')
  } else if (gate?.mode === PLAYBACK_ONLY) {
    if (packagedCatalogSha256) throw new Error('Playback-only packaging produced an application containing processing-catalog.json')
  } else throw new Error('Packaged processing catalog check requires a gate result')
  return gate
}
