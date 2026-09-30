// SPDX-License-Identifier: AGPL-3.0-only
import { execFile as callback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJson, sha256Hex } from '../release.mjs'
import { deriveIdentityFromApplication, inspectApplicationInventory } from './release_receipt.mjs'
import { isMachO, signedMacMarker, verifyDeveloperId, verifySignedMacApplication, verifySigningCertificate } from '../macos_signing.mjs'

const execFile = promisify(callback)
const bundles = /\.(?:app|framework|xpc|appex|plugin|bundle)$/i
const assemblyMetadata = new Set(['manifest.json', 'files.json', 'assembly.json'])

export function nativeInventoryMemberNames(paths) {
  return paths.filter(name => !assemblyMetadata.has(name)).sort()
}

async function walk(root, current = root, out = { files: [], bundles: [] }) {
  for (const name of await readdir(current)) {
    const path = join(current, name), info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await walk(root, path, out)
      if (bundles.test(name)) out.bundles.push(path)
    } else if (info.isFile()) out.files.push(path)
    else throw new Error(`Unsupported application entry: ${path}`)
  }
  return out
}

async function sign(path, selection, run, { entitlements, deep = false } = {}) {
  const args = ['--force', '--sign', selection.fingerprint, '--options', 'runtime', '--timestamp']
  if (entitlements) args.push('--entitlements', entitlements)
  args.push(path)
  await run('/usr/bin/codesign', args)
  await verifyDeveloperId(path, selection, run, { deep })
}

export async function sealSignedMacApplication({ applicationDirectory, policy, packageLock, selection, run = execFile }) {
  if (process.platform !== 'darwin') throw new Error('Signed macOS releases require macOS')
  const application = resolve(applicationDirectory), app = join(application, 'Singhouse.app')
  await verifySigningCertificate(selection, run)
  // This validates every original native file against the assembled inventory
  // before code signing changes any of those bytes.
  await deriveIdentityFromApplication({ applicationDirectory: application, policy, packageLock })
  const native = join(app, 'Contents', 'Resources', 'native')
  const filesPath = join(native, 'files.json'), assemblyPath = join(native, 'assembly.json'), manifestPath = join(native, 'manifest.json')
  const files = JSON.parse(await readFile(filesPath, 'utf8'))
  const { files: nativeEntries } = await walk(native)
  const nativeNames = nativeInventoryMemberNames(nativeEntries.map(path => relative(native, path).split(sep).join('/')))
  if (canonicalJson(nativeNames) !== canonicalJson(Object.keys(files).sort())) throw new Error('Native assembly has added or missing files before signing')
  const nativeMachO = []
  for (const path of nativeEntries) if (await isMachO(path)) nativeMachO.push(path)
  for (const path of nativeMachO.sort((a, b) => b.length - a.length)) await sign(path, selection, run)
  // The marker is constant for this certificate and carries no release ID or
  // inventory hash. It is sealed by the outer bundle signature.
  await writeFile(join(app, 'Contents', 'Resources', 'signed-release.json'),
    `${canonicalJson(signedMacMarker(selection))}\n`)
  const entries = await walk(app)
  const work = await mkdtemp(join(tmpdir(), 'singhouse-mac-sign-'))
  try {
    const entitlements = join(work, 'entitlements.plist')
    await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n`)
    for (const path of entries.files.sort((a, b) => b.length - a.length)) {
      if (path.startsWith(`${native}/`) || !await isMachO(path)) continue
      await sign(path, selection, run, { entitlements })
    }
    for (const path of entries.bundles.sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) {
      if (path === app) continue
      await sign(path, selection, run, { entitlements: path.startsWith(`${native}/`) ? undefined : entitlements })
    }
    const updatedNative = await walk(native)
    const updatedNames = nativeInventoryMemberNames(updatedNative.files.map(path => relative(native, path).split(sep).join('/')))
    if (canonicalJson(updatedNames) !== canonicalJson(nativeNames)) throw new Error('Code signing added or removed native assembly files')
    const observed = {}
    for (const name of nativeNames) {
      const path = resolve(native, ...name.split('/'))
      const digest = sha256Hex(await readFile(path))
      if (digest !== files[name] && !nativeMachO.includes(path)) throw new Error(`Non-Mach-O native assembly file changed during signing: ${name}`)
      if (digest !== files[name]) await verifyDeveloperId(path, selection, run)
      observed[name] = digest
    }
    const sortedFiles = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)))
    const assembly = JSON.parse(await readFile(assemblyPath, 'utf8'))
    assembly.payloadDigest = sha256Hex(canonicalJson(sortedFiles))
    await writeFile(filesPath, `${JSON.stringify(sortedFiles, null, 2)}\n`)
    await writeFile(assemblyPath, `${JSON.stringify(assembly, null, 2)}\n`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.runtimeId = sha256Hex(await readFile(filesPath))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await sign(app, selection, run, { entitlements, deep: true })
    return { app, manifest }
  } finally { await rm(work, { recursive: true, force: true }) }
}

export async function notarizeAndStaple(path, selection, run = execFile, report = console.log) {
  const target = path.endsWith('.app') ? 'application' : 'disk image'
  let work, stage = 'preparation', accepted = false, submissionId
  const readResult = stdout => {
    let result
    try { result = JSON.parse(stdout) } catch { return undefined }
    if (!result || typeof result !== 'object') return undefined
    // Only display recognized status values and a validated ID. Neither command
    // errors nor arbitrary Apple response fields belong in the build log.
    const status = ['Accepted', 'Invalid', 'Rejected', 'In Progress'].includes(result.status) ? result.status : 'unknown'
    submissionId = typeof result.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.id) ? result.id : undefined
    report(`Apple notarization status for ${target}: ${status}; submission ID: ${submissionId || 'unavailable'}.`)
    return { status, id: submissionId }
  }
  try {
    work = await mkdtemp(join(tmpdir(), 'singhouse-mac-notary-'))
    let submission = path
    if (path.endsWith('.app')) {
      submission = join(work, `${basename(path)}.zip`)
      await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', path, submission])
    }
    stage = 'submission'
    report(`Submitting ${target} to Apple for notarization; waiting for Apple's result.`)
    let stdout
    try {
      ({ stdout } = await run('/usr/bin/xcrun', ['notarytool', 'submit', submission, '--keychain-profile', selection.keychainProfile, '--wait', '--output-format', 'json'], { maxBuffer: 1024 * 1024 }))
    } catch (error) {
      readResult(error?.stdout)
      throw new Error('Notary submission command failed')
    }
    const result = readResult(stdout)
    if (result?.status !== 'Accepted' || !result.id) throw new Error('Notary acceptance was not verified')
    accepted = true
    stage = 'stapling'
    report(`Stapling Apple's notarization ticket to ${target}.`)
    await run('/usr/bin/xcrun', ['stapler', 'staple', path])
    report(`Notarization ticket stapled to ${target}.`)
    stage = 'ticket validation'
    await run('/usr/bin/xcrun', ['stapler', 'validate', path])
    report(`Notarization ticket validation succeeded for ${target}; submission ID: ${submissionId}.`)
  } catch {
    const message = accepted
      ? `Apple notarization Accepted for ${target} (submission ID: ${submissionId}), but ${stage} failed.`
      : `Apple notarization failed during ${stage} for ${target}; acceptance was not verified${submissionId ? ` (submission ID: ${submissionId})` : ''}.`
    report(message)
    // Do not attach the subprocess error: its message/stdout/stderr may include
    // command arguments, keychain profile names, or other sensitive output.
    throw new Error(message)
  } finally { if (work) await rm(work, { recursive: true, force: true }) }
}

export async function signMacDiskImage(path, selection, run = execFile) {
  await run('/usr/bin/codesign', ['--force', '--sign', selection.fingerprint, '--timestamp', path])
  await verifyDeveloperId(path, selection, run)
  await notarizeAndStaple(path, selection, run)
  await verifyDeveloperId(path, selection, run)
}

export function appRelativeInventory(files) {
  if (!Array.isArray(files) || !files.some(record => record.path === 'Singhouse.app' && record.type === 'directory')) {
    throw new Error('Expected inventory lacks Singhouse.app')
  }
  return files.filter(record => record.path.startsWith('Singhouse.app/')).map(record => {
    const path = record.path.slice('Singhouse.app/'.length)
    if (record.type !== 'symlink') return { ...record, path }
    if (!record.target.startsWith('Singhouse.app/')) throw new Error('Expected application symlink escapes Singhouse.app')
    return { ...record, path, target: record.target.slice('Singhouse.app/'.length) }
  })
}

export async function macExecutableModes(bundle, files) {
  const modes = {}
  for (const record of files) {
    if (record.type !== 'file') continue
    const path = resolve(bundle, ...record.path.split('/'))
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`Container application file changed type: ${record.path}`)
    modes[record.path] = info.mode & 0o111
  }
  return modes
}

export async function verifyMacExecutableModes(bundle, expectedFiles, expectedModes) {
  if (canonicalJson(await macExecutableModes(bundle, expectedFiles)) !== canonicalJson(expectedModes)) {
    throw new Error('Container application changed executable permissions')
  }
}

export async function verifyMacDiskImageApplication(path, expectedInventory, expectedModes, selection, run = execFile) {
  const mount = await mkdtemp(join(tmpdir(), 'singhouse-mac-dmg-'))
  let attached = false
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path])
    attached = true
    const installed = await inspectApplicationInventory(join(mount, 'Singhouse.app'))
    const expected = appRelativeInventory(expectedInventory.files)
    if (canonicalJson(installed.files) !== canonicalJson(expected)) {
      throw new Error('DMG application differs from the signed portable application')
    }
    await verifyMacExecutableModes(join(mount, 'Singhouse.app'), expected, expectedModes)
    await verifySignedMacApplication(join(mount, 'Singhouse.app'), selection, run)
  } finally {
    if (attached) await run('/usr/bin/hdiutil', ['detach', mount])
    await rm(mount, { recursive: true, force: true })
  }
}

export async function verifyMacZipApplication(path, expectedInventory, expectedModes, selection, run = execFile) {
  const extracted = await mkdtemp(join(tmpdir(), 'singhouse-mac-zip-'))
  try {
    await run('/usr/bin/ditto', ['-x', '-k', path, extracted])
    const installed = await inspectApplicationInventory(join(extracted, 'Singhouse.app'))
    const expected = appRelativeInventory(expectedInventory.files)
    if (canonicalJson(installed.files) !== canonicalJson(expected)) {
      throw new Error('ZIP application differs from the signed portable application')
    }
    await verifyMacExecutableModes(join(extracted, 'Singhouse.app'), expected, expectedModes)
    await verifySignedMacApplication(join(extracted, 'Singhouse.app'), selection, run)
  } finally { await rm(extracted, { recursive: true, force: true }) }
}
