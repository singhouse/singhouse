// SPDX-License-Identifier: AGPL-3.0-only
import { execFile as callback } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, open, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalJson } from './release.mjs'

const execFile = promisify(callback)
const teamPattern = /^[A-Z0-9]{10}$/
const fingerprintPattern = /^[A-F0-9]{40}$/
// Initial Developer ID release team. Changing publisher or team requires a
// reviewed source change and a new first-install trust decision.
export const MAC_RELEASE_PUBLISHER = 'MICHAEL ALAN JONES'
export const MAC_RELEASE_TEAM_ID = '25Y7U443K6'
export const MAC_RELEASE_CERT_SHA1 = '55FEEAA93960DD9E278519CA68338BACFC2A3617'

export function macSigningSelection(environment = process.env) {
  const teamId = environment.SINGHOUSE_MAC_TEAM_ID
  const identity = environment.SINGHOUSE_MAC_IDENTITY
  const publisher = environment.SINGHOUSE_MAC_PUBLISHER
  const fingerprint = environment.SINGHOUSE_MAC_CERT_SHA1
  const keychainProfile = environment.SINGHOUSE_MAC_NOTARY_PROFILE
  if (!teamPattern.test(teamId || '') || !fingerprintPattern.test(fingerprint || '') ||
      publisher !== MAC_RELEASE_PUBLISHER || teamId !== MAC_RELEASE_TEAM_ID || fingerprint !== MAC_RELEASE_CERT_SHA1 ||
      identity !== `Developer ID Application: ${publisher} (${teamId})` ||
      typeof keychainProfile !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(keychainProfile)) {
    throw new Error('Signed macOS release requires exact intended Developer ID publisher, identity, Team ID, certificate SHA-1, and notarytool keychain profile')
  }
  return { teamId, publisher, identity, fingerprint, keychainProfile }
}

export function developerIdRequirement(teamId) {
  if (!teamPattern.test(teamId || '')) throw new Error('Invalid Apple Team ID')
  if (teamId !== MAC_RELEASE_TEAM_ID) throw new Error('Unexpected Apple Team ID')
  return `anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf = H"${MAC_RELEASE_CERT_SHA1}"`
}

export function signedMacMarker(selection) {
  developerIdRequirement(selection.teamId)
  if (selection.publisher !== MAC_RELEASE_PUBLISHER || selection.teamId !== MAC_RELEASE_TEAM_ID ||
      selection.identity !== `Developer ID Application: ${selection.publisher} (${selection.teamId})`) throw new Error('Invalid signed macOS publisher selection')
  return { schema: 1, kind: 'singhouse-macos-developer-id-release', teamId: selection.teamId, publisher: selection.publisher }
}

export function inspectSignedMacMarker(raw) {
  let marker
  try { marker = JSON.parse(raw) } catch { throw new Error('Invalid signed macOS release marker') }
  if (raw !== `${canonicalJson(marker)}\n` || canonicalJson(marker) !== canonicalJson(signedMacMarker({
    teamId: marker.teamId, publisher: marker.publisher,
    identity: `Developer ID Application: ${marker.publisher} (${marker.teamId})`,
  }))) throw new Error('Invalid signed macOS release marker')
  return { ...marker, identity: `Developer ID Application: ${marker.publisher} (${marker.teamId})` }
}

// The managed-slot descriptor is adjacent to the bundle. Authenticate a
// signed bundle before even reading that descriptor so adding portable.json
// cannot turn a first installer into an unchecked managed slot.
export async function inspectInstalledLaunchBoundary({ platform, resourcesPath, applicationRoot,
  exists = existsSync, read = readFileSync, verify = verifySignedMacApplication }) {
  const markerPath = resolve(resourcesPath, 'signed-release.json')
  let marker = null
  if (platform === 'darwin' && exists(markerPath)) {
    marker = inspectSignedMacMarker(read(markerPath, 'utf8'))
    await verify(resolve(resourcesPath, '../..'), marker)
  }
  const portablePath = resolve(applicationRoot, 'portable.json')
  const portableExists = exists(portablePath)
  if (marker && portableExists) throw new Error('Signed macOS first installer cannot accept adjacent managed-slot metadata')
  return { marker, portableBytes: portableExists ? read(portablePath, 'utf8') : null }
}

export async function verifySigningCertificate(selection, run = execFile) {
  const { stdout } = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
  const matches = stdout.split('\n').filter(line => line.includes(selection.fingerprint) && line.includes(`"${selection.identity}"`))
  if (matches.length !== 1) throw new Error('Exact Developer ID Application certificate is unavailable or ambiguous')
}

export async function isMachO(path) {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(4)
    const { bytesRead } = await file.read(bytes, 0, 4, 0)
    return bytesRead === 4 && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'))
  } finally { await file.close() }
}

export async function verifyDeveloperId(path, selection, run = execFile, { deep = false } = {}) {
  const requirement = developerIdRequirement(selection.teamId)
  await run('/usr/bin/codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', '--verbose=2', '-R', requirement, path])
  const { stderr = '', stdout = '' } = await run('/usr/bin/codesign', ['--display', '--verbose=4', path])
  const details = `${stdout}\n${stderr}`
  if (!details.split('\n').includes(`TeamIdentifier=${selection.teamId}`) ||
      !details.split('\n').some(line => line === `Authority=${selection.identity}`) ||
      !/^Timestamp=(?!none\s*$).+$/m.test(details)) {
    throw new Error('macOS signature lacks expected Developer ID team, certificate authority, or secure timestamp')
  }
  return true
}

const nestedCodeBundle = /\.(?:app|framework|xpc|appex|plugin|bundle)$/i

export async function verifySignedMacApplication(bundle, selection, run = execFile) {
  await verifyDeveloperId(bundle, selection, run, { deep: true })
  const nested = []
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name), info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await walk(path)
        if (nestedCodeBundle.test(name)) nested.push(path)
      } else if (info.isFile() && await isMachO(path)) nested.push(path)
    }
  }
  await walk(bundle)
  const requirement = developerIdRequirement(selection.teamId)
  for (const path of nested) {
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, path])
  }
  return true
}
