// SPDX-License-Identifier: AGPL-3.0-only
// This is the recovery kit's minimal verifier. It imports no mutable recovery
// implementation until every externally manifested kit byte has been checked.
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function same(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function inside(path, root) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function privateInfo(info, label) {
  if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || info.mode & 0o077)) throw new Error(`${label} is not private to the current user`)
}
function regularBytes(path, label) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0), descriptor = openSync(path, flags)
  try {
    const info = fstatSync(descriptor); if (!info.isFile()) throw new Error(`${label} is not a regular file`)
    privateInfo(info, label); return readFileSync(descriptor)
  } finally { closeSync(descriptor) }
}
function inventory(root, current = root) {
  const records = []
  for (const name of readdirSync(current).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    const path = resolve(current, name), info = lstatSync(path)
    const item = relative(root, path).split(sep).join('/')
    if (item === 'manifest.json') continue
    if (info.isSymbolicLink()) {
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`Recovery kit entry ${item} has the wrong owner`)
      records.push({ path: item, type: 'symlink', target: readlinkSync(path) })
    } else if (info.isDirectory()) { privateInfo(info, `Recovery kit entry ${item}`); records.push({ path: item, type: 'directory', mode: 0o700 }); records.push(...inventory(root, path)) }
    else if (info.isFile()) { const bytes = regularBytes(path, `Recovery kit entry ${item}`); records.push({ path: item, type: 'file', size: bytes.length,
      sha256: sha256(bytes), mode: info.mode & 0o111 ? 0o700 : 0o600 }) }
    else throw new Error('Recovery kit contains an unsupported filesystem entry')
  }
  return records
}

export function verifyRecoveryKit(moduleUrl = import.meta.url) {
  const cli = fileURLToPath(moduleUrl)
  if (cli !== resolve(cli) || realpathSync(cli) !== cli) throw new Error('Recovery kit entrypoint is not canonical')
  const root = resolve(dirname(cli), '..'), manifestPath = resolve(root, 'manifest.json')
  const rootInfo = lstatSync(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || realpathSync(root) !== root) throw new Error('Recovery kit root is not canonical')
  const manifestInfo = lstatSync(manifestPath); privateInfo(manifestInfo, 'Recovery kit manifest')
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('Recovery kit manifest must be a regular file')
  const manifestBytes = regularBytes(manifestPath, 'Recovery kit manifest'), manifest = JSON.parse(manifestBytes)
  if (manifest.schema !== 2 || manifest.kind !== 'recovery-kit' || !Array.isArray(manifest.files) ||
      !['linux', 'win32', 'darwin'].includes(manifest.target?.platform) || !['x64', 'arm64'].includes(manifest.target?.arch) ||
      (manifest.target.platform === 'win32' && manifest.target.arch !== 'x64') ||
      (manifest.target.platform === 'darwin' && manifest.target.arch !== 'arm64') ||
      manifest.binding?.schema !== 1 ||
      typeof manifest.runtimeEntrypoint !== 'string' || !manifest.files.some(record => record.path === manifest.runtimeEntrypoint && record.type === 'file')) throw new Error('Invalid recovery kit manifest')
  if (!same(manifestBytes, `${JSON.stringify(manifest)}\n`)) throw new Error('Recovery kit manifest is not exact JSON')
  if (!same(canonical(inventory(root)), canonical(manifest.files))) throw new Error('Recovery kit verification failed')
  const runtime = resolve(root, ...manifest.runtimeEntrypoint.split('/'))
  if (!inside(runtime, root) || process.execPath !== resolve(process.execPath) || realpathSync(process.execPath) !== process.execPath || process.execPath !== runtime) {
    throw new Error('Recovery kit did not start with its retained runtime')
  }
  return { root, manifest }
}

export function recoveryDataDirectory(stateRootValue, suppliedValue) {
  const expected = join(stateRootValue, 'backend')
  let canonicalState, canonicalData
  try { canonicalState = realpathSync(stateRootValue); canonicalData = realpathSync(suppliedValue) } catch {
    throw new Error('Recovery database path must exactly match the selected state root')
  }
  if (stateRootValue !== resolve(stateRootValue) || canonicalState !== stateRootValue || suppliedValue !== expected || canonicalData !== suppliedValue ||
      !lstatSync(suppliedValue).isDirectory()) throw new Error('Recovery database path must exactly match the selected state root')
  return expected
}

export function recoveryStateRoot(kitRootValue, suppliedValue) {
  if (kitRootValue !== resolve(kitRootValue)) throw new Error('Recovery kit does not match the selected state root')
  const selectedKitRoot = kitRootValue, kitRoot = realpathSync(selectedKitRoot)
  const stateRoot = dirname(dirname(dirname(kitRoot)))
  const kitInfo = lstatSync(kitRoot)
  if (kitInfo.isSymbolicLink() || !kitInfo.isDirectory() || selectedKitRoot !== kitRoot || kitRoot !== join(stateRoot, 'recovery-tool', 'kits', basename(kitRoot)) ||
      suppliedValue !== stateRoot || realpathSync(stateRoot) !== stateRoot) {
    throw new Error('Recovery kit does not match the selected state root')
  }
  return stateRoot
}

export function recoveryHandoff(stateRoot) {
  if (stateRoot !== resolve(stateRoot) || realpathSync(stateRoot) !== stateRoot) {
    throw new Error('Recovery handoff state root is not canonical')
  }
  const updatesRoot = join(stateRoot, 'updates'), handoffPath = join(updatesRoot, 'handoff.json')
  const updatesInfo = lstatSync(updatesRoot), handoffInfo = lstatSync(handoffPath)
  if (updatesInfo.isSymbolicLink() || !updatesInfo.isDirectory() || realpathSync(updatesRoot) !== updatesRoot ||
      handoffInfo.isSymbolicLink() || !handoffInfo.isFile() || realpathSync(handoffPath) !== handoffPath) {
    throw new Error('Recovery handoff is not an exact regular file')
  }
  return JSON.parse(regularBytes(handoffPath, 'Recovery handoff'))
}

export async function main(args) {
  if (args.length !== 3) throw new Error('Usage: recovery_cli.mjs <state-root> <point-id> <library-directory>')
  const kit = verifyRecoveryKit()
  const [stateRootValue, pointId, dataDirectoryValue] = args
  if (!/^point-[A-Za-z0-9]+$/.test(pointId)) throw new Error('Invalid recovery point identity')
  const stateRoot = recoveryStateRoot(kit.root, stateRootValue), dataDirectory = recoveryDataDirectory(stateRoot, dataDirectoryValue)
  const handoffPath = join(stateRoot, 'updates', 'handoff.json')
  const handoff = recoveryHandoff(stateRoot)
  if (handoff.recoveryKit?.id !== `kit-${pointId}` || kit.root !== join(stateRoot, 'recovery-tool', 'kits', handoff.recoveryKit.id) ||
      handoff.recoveryKit.manifestSha256 !== sha256(Buffer.from(canonical(kit.manifest)))) {
    throw new Error('Recovery kit selection does not match the authenticated handoff')
  }
  const previousRoot = join(stateRoot, 'updates', 'installed', 'releases', handoff.previousIdentity.releaseId)
  const platform = handoff.previousApplication.platform
  if (platform !== kit.manifest.target.platform || handoff.previousApplication.arch !== kit.manifest.target.arch) throw new Error('Recovery kit target does not match the handoff')
  const runtimeRoot = resolve(kit.root, 'runtime')
  const applicationInventory = kit.manifest.files.filter(record => record.path.startsWith('runtime/'))
    .map(record => ({ ...record, path: record.path.slice('runtime/'.length) }))
  const python = platform === 'win32'
    ? join(runtimeRoot, 'resources', 'native', 'python', 'python.exe')
    : platform === 'darwin'
      ? join(runtimeRoot, 'Singhouse.app', 'Contents', 'Resources', 'native', 'python', 'bin', 'python3')
      : join(runtimeRoot, 'resources', 'native', 'python', 'bin', 'python3')
  const helper = platform === 'darwin'
    ? join(runtimeRoot, 'Singhouse.app', 'Contents', 'Resources', 'native', 'backend.py')
    : join(runtimeRoot, 'resources', 'native', 'backend.py')
  const contract = JSON.parse(readFileSync(resolve(kit.root, 'tools', 'release.json'), 'utf8'))
  const [{ recover }, { validateUpdateMetadata }] = await Promise.all([
    import(pathToFileURL(resolve(kit.root, 'tools', 'recovery_launcher.mjs')).href),
    import(pathToFileURL(resolve(kit.root, 'tools', 'release.mjs')).href),
  ])
  return recover({ pointPath: join(stateRoot, 'recovery', pointId, 'recovery.json'), handoffPath,
    metadataPath: join(stateRoot, 'updates', 'staged', handoff.stagedRelease, 'update.json'),
    applicationSourcePath: runtimeRoot, applicationDestinationPath: previousRoot, applicationInventory,
    activeApplicationPath: join(stateRoot, 'updates', 'installed', 'active.json'), dataDirectory,
    pythonPath: python, backendHelperPath: helper, recoveryKitManifest: kit.manifest,
    verifyMetadata: envelope => validateUpdateMetadata(envelope, contract, {
      currentIdentity: handoff.previousIdentity, pairedCoreReleaseId: handoff.targetIdentity.pairedCoreReleaseId,
      platform: handoff.previousApplication.platform, arch: handoff.previousApplication.arch, lastSequence: -1,
    }) })
}

if (process.env.SINGHOUSE_RECOVERY_KIT === '1' ||
    (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(`Recovery failed: ${error.message}`); process.exitCode = 1 })
}
