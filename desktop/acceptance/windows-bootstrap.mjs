// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UvRuntimeManager } from '../uv_runtime_manager.mjs'
import { ModelCache, checkedFile, managedStoreDirectories, processingAttestation, validateModelManifest } from '../runtime_manager.mjs'
import { recipeTransfers } from '../processing_recipe.mjs'
import { channelTrustedLocks } from '../setup_catalog.mjs'
import { assertPrivateMeasurementRelease, assertPrivateMeasurementRuntime } from '../private_measurement.mjs'

const json = async path => JSON.parse(await readFile(path, 'utf8'))
const requiredModels = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']
export function modelManifest(policy) {
  const value = { schema: 1, kind: 'models', models: requiredModels,
    files: requiredModels.flatMap(id => policy.models.find(model => model.id === id)?.files || []) }
  return validateModelManifest(value, policy)
}

// URLs and hashes remain the reviewed recipe's identities. Only the transport
// changes for artifacts accompanying this private test bundle. RuntimeManager
// still checks the complete transferred size and digest before using any bytes.
export function bundledFetch(recipe, artifacts, network = globalThis.fetch) {
  const records = new Map(recipeTransfers(recipe).map(record => [record.url, record]))
  return async (url, options = {}) => {
    const record = records.get(String(url))
    if (!record) return network(url, options)
    const directory = join(artifacts, record.sha256)
    let names
    try { names = await readdir(directory) } catch (error) {
      if (error.code === 'ENOENT') return network(url, options)
      throw error
    }
    if ((await lstat(directory)).isSymbolicLink() || !(await realpath(directory)).startsWith((await realpath(artifacts)) + sep)) throw new Error('Bundled artifact directory escapes bundle')
    const name = record.filename || (names.length === 1 ? names[0] : null)
    if (!name || !names.includes(name) || name.includes('/') || name.includes('\\')) throw new Error('Bundled artifact is ambiguous')
    const file = await checkedFile(join(directory, name), constants.O_RDONLY)
    try {
      if ((await file.stat()).size !== record.size) throw new Error('Bundled artifact size mismatch')
      options.signal?.throwIfAborted()
      // A full response intentionally resets an interrupted partial download.
      return { status: 200, headers: new Headers(), body: file.createReadStream({ autoClose: true, signal: options.signal }) }
    } catch (error) { await file.close(); throw error }
  }
}

export async function prepare({ bundle, profile, accelerator, consent = false, checkOnly = false, dependenciesOnly = false, repair = false }) {
  if (!['cpu', 'cuda'].includes(accelerator) || !isAbsolute(profile)) throw new Error('An absolute test profile and cpu/cuda selection are required')
  const native = join(bundle, 'app', 'resources', 'native')
  const policy = await json(join(bundle, 'app', 'resources', 'release.json'))
  assertPrivateMeasurementRelease(true, true, policy)
  const identity = await json(join(native, 'manifest.json'))
  if (identity.platform !== 'win32' || identity.arch !== 'x64') throw new Error('This bundle requires Windows x64')
  const recipe = await json(join(bundle, 'recipe', 'manifest.json'))
  if (recipe.accelerator !== accelerator) throw new Error('Selected accelerator does not match this bundle')
  const provenance = await json(join(native, 'provenance.json'))
  const trust = await json(join(native, 'processing-locks.json'))
  // Private-test bundles trust every committed lock: candidates and accepted recipes alike.
  if (!channelTrustedLocks(trust, 'private-test').includes(recipe.provenance.lockSha256)) throw new Error('Recipe lacks an independently pinned processing trust entry')
  const modelPolicy = await json(join(native, 'models.json')), models = modelManifest(modelPolicy)
  const paths = managedStoreDirectories(profile)
  let last = 0
  const progress = event => { if (Date.now() - last > 2000) { console.log(`${event.file || 'Preparing'}: ${Math.round((event.received || 0) / 1048576)} MiB`); last = Date.now() } }
  const options = { progress, lockPython: join(native, 'python', 'python.exe'), durabilityHelper: join(native, 'backend.py') }
  const manager = new UvRuntimeManager(paths.processing, identity, { ...options,
    uvPath: join(native, 'uv', 'uv.exe'), nativeRuntimeId: identity.runtimeId,
    nativeBin: join(native, 'ffmpeg', 'bin'), nativeLockSha256: provenance.locks?.['native.json'],
    trustedLocks: channelTrustedLocks(trust, policy.channel),
    fetchImpl: bundledFetch(recipe, join(bundle, 'recipe', 'artifacts')) })
  manager.validate(recipe)
  if (checkOnly) return { accelerator, modelBytes: models.files.reduce((total, file) => total + file.size, 0) }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run this setup on Windows x64')
  if (!consent && !dependenciesOnly) throw new Error('Explicit consent to download the pinned upstream models is required')
  await mkdir(profile, { recursive: true })
  const started = Date.now()
  console.log('Installing and verifying processing tools. Keep this window open.')
  let active = repair ? null : await manager.active({ launch: true })
  if (!active || active.manifest.provenance.lockSha256 !== recipe.provenance.lockSha256) active = await manager.install(recipe)
  console.log('Checking processing on this computer…')
  const probe = processingAttestation(active, await manager.launchProbe(active))
  console.log(`Processing verified in ${Math.round((Date.now() - started) / 1000)} seconds.`)
  if (dependenciesOnly) return { accelerator, dependenciesVerified: true, ready: false, probe }
  console.log(`Downloading and verifying ${(models.files.reduce((total, file) => total + file.size, 0) / 1073741824).toFixed(1)} GiB of upstream models. The first setup can take a while.`)
  const cache = new ModelCache(paths.models, modelPolicy, options)
  let selectedModels = repair ? null : await cache.active({ launch: true })
  if (!selectedModels || !requiredModels.every(id => selectedModels.manifest.models.includes(id))) selectedModels = await cache.install(models)
  assertPrivateMeasurementRuntime(true, active, selectedModels, probe)
  await writeFile(join(profile, 'windows-acceptance.json'), JSON.stringify({ schema: 1, accelerator, runtimeId: active.id, nativeRuntimeId: identity.runtimeId, probe, preparedAt: new Date().toISOString() }, null, 2))
  console.log('Setup verified. Opening singhouse.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const started = Date.now()
  const heartbeat = process.argv.includes('--check-only') ? null : setInterval(() => console.log(`Setup still running (${Math.round((Date.now() - started) / 1000)} seconds). Verifying or preparing files; keep this window open.`), 30000)
  try {
    const args = process.argv.slice(2)
    const value = name => args[args.indexOf(name) + 1]
    const result = await prepare({ bundle: resolve(value('--bundle')), profile: value('--profile'), accelerator: value('--accelerator'), consent: args.includes('--accept-model-downloads'), checkOnly: args.includes('--check-only'), dependenciesOnly: args.includes('--dependencies-only'), repair: args.includes('--repair') })
    if (result) console.log(JSON.stringify(result))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally { clearInterval(heartbeat) }
}
