// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '../release.mjs'
import { developerIdRequirement, inspectInstalledLaunchBoundary, INSTALLED_MAC_SIGNATURE_FAILURE, installedMacCodesignArguments, verifyInstalledMacCodesign, inspectSignedMacMarker, isMachO, MAC_RELEASE_CERT_SHA1, macSigningSelection, signedMacMarker, verifyDeveloperId, verifySignedMacApplication, verifySigningCertificate } from '../macos_signing.mjs'
import { assertPackagingMode, sha256File } from '../build/package.mjs'
import { appRelativeInventory, macExecutableModes, nativeInventoryMemberNames, notarizeAndStaple, verifyMacDiskImageApplication, verifyMacExecutableModes } from '../build/sign_macos.mjs'
import { inspectApplicationInventory } from '../build/release_receipt.mjs'

const environment = {
  SINGHOUSE_MAC_TEAM_ID: '25Y7U443K6',
  SINGHOUSE_MAC_PUBLISHER: 'MICHAEL ALAN JONES',
  SINGHOUSE_MAC_IDENTITY: 'Developer ID Application: MICHAEL ALAN JONES (25Y7U443K6)',
  SINGHOUSE_MAC_CERT_SHA1: '55FEEAA93960DD9E278519CA68338BACFC2A3617',
  SINGHOUSE_MAC_NOTARY_PROFILE: 'private-release',
}

test('signed release requires an exact intended Developer ID selection', () => {
  const selected = macSigningSelection(environment)
  assert.equal(selected.teamId, '25Y7U443K6')
  for (const key of Object.keys(environment)) {
    const missing = { ...environment }; delete missing[key]
    assert.throws(() => macSigningSelection(missing), /requires exact intended/)
  }
  assert.throws(() => macSigningSelection({ ...environment, SINGHOUSE_MAC_PUBLISHER: 'Rack Performance LLC',
    SINGHOUSE_MAC_IDENTITY: 'Developer ID Application: Rack Performance LLC (25Y7U443K6)' }), /requires exact intended/)
  assert.throws(() => macSigningSelection({ ...environment, SINGHOUSE_MAC_TEAM_ID: '4Q2SGU7A2D',
    SINGHOUSE_MAC_IDENTITY: 'Developer ID Application: MICHAEL ALAN JONES (4Q2SGU7A2D)' }), /requires exact intended/)
  assert.throws(() => macSigningSelection({ ...environment, SINGHOUSE_MAC_IDENTITY: 'Apple Development: MICHAEL ALAN JONES (25Y7U443K6)' }), /requires exact intended/)
  assert.throws(() => macSigningSelection({ ...environment, SINGHOUSE_MAC_CERT_SHA1: 'A'.repeat(40) }), /requires exact intended/)
  assert.match(developerIdRequirement(selected.teamId), /1\.2\.840\.113635\.100\.6\.1\.13/)
  assert.match(developerIdRequirement(selected.teamId), new RegExp(MAC_RELEASE_CERT_SHA1))
})

test('macOS signing flag fails closed across platform and release modes', () => {
  assert.deepEqual(assertPackagingMode(['--playback-only'], 'linux', {}).signedMacRelease, false)
  assert.throws(() => assertPackagingMode(['--signed-macos-release', '--playback-only'], 'darwin', {}), /requires --first-installers/)
  assert.throws(() => assertPackagingMode(['--signed-macos-release', '--first-installers', '--playback-only'], 'linux', {}), /requires macOS/)
  assert.throws(() => assertPackagingMode(['--signed-macos-release', '--first-installers', '--signed-release', '--playback-only'], 'darwin', {}), /cannot combine/)
  assert.throws(() => assertPackagingMode(['--signed-macos-release', '--first-installers'], 'darwin', {}), /requires exactly one of --processing-ready or --playback-only/)
  assert.equal(assertPackagingMode(['--signed-macos-release', '--first-installers', '--playback-only'], 'darwin', {}).signedMacRelease, true)
})

test('signed marker is canonical, non-self-referential, and rejects Rack publisher', () => {
  const selected = macSigningSelection(environment)
  const marker = signedMacMarker(selected)
  assert.deepEqual(Object.keys(marker).sort(), ['kind', 'publisher', 'schema', 'teamId'])
  assert.equal(inspectSignedMacMarker(`${canonicalJson(marker)}\n`).identity, selected.identity)
  assert.throws(() => inspectSignedMacMarker(JSON.stringify(marker)), /Invalid signed macOS release marker/)
  assert.throws(() => inspectSignedMacMarker(`${canonicalJson({ ...marker, releaseId: 'a'.repeat(64) })}\n`), /Invalid signed macOS release marker/)
  assert.throws(() => inspectSignedMacMarker(`${canonicalJson({ ...marker, publisher: 'Rack Performance LLC' })}\n`), /Invalid signed macOS publisher selection/)
  assert.throws(() => inspectSignedMacMarker(`${canonicalJson({ ...marker, teamId: '4Q2SGU7A2D' })}\n`), /Unexpected Apple Team ID/)
})

test('Developer ID verification checks anchored team, exact authority, and timestamp', async () => {
  const selected = macSigningSelection(environment), calls = []
  const run = async (command, args) => {
    calls.push([command, args])
    if (args.includes('--display')) return { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026 at 12:00:00\n` }
    return { stdout: '' }
  }
  await verifyDeveloperId('/tmp/Singhouse.app', selected, run)
  await verifyDeveloperId('/tmp/Singhouse.app', selected, run, { deep: true })
  assert.ok(calls[0][1].includes('-R'))
  assert.equal(calls[0][1][calls[0][1].indexOf('-R') + 1], `=${developerIdRequirement(selected.teamId)}`)
  assert.equal(calls[2][1][calls[2][1].indexOf('-R') + 1], `=${developerIdRequirement(selected.teamId)}`)
  assert.ok(calls[2][1].includes('--deep'))
  await assert.rejects(verifyDeveloperId('/tmp/Singhouse.app', selected,
    async (_command, args) => args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=none\n` } : { stdout: '' }), /timestamp/)
  await assert.rejects(verifyDeveloperId('/tmp/Singhouse.app', selected,
    async (_command, args) => args.includes('--display') ? { stderr: `TeamIdentifier=WRONGTEAM0\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }), /expected Developer ID/)
})

test('managed descriptor is not read before signed Mac bundle verification', async () => {
  const marker = `${canonicalJson(signedMacMarker(macSigningSelection(environment)))}\n`
  const reads = []
  const read = path => { reads.push(path); return path.endsWith('signed-release.json') ? marker : '{"identity":"forged"}' }
  const args = { platform: 'darwin', resourcesPath: '/tmp/Singhouse.app/Contents/Resources', applicationRoot: '/tmp',
    exists: () => true, read }
  await assert.rejects(inspectInstalledLaunchBoundary({ ...args, verify: async () => { throw new Error('untrusted app') } }), /failed its code signature check/)
  assert.deepEqual(reads, ['/tmp/Singhouse.app/Contents/Resources/signed-release.json'])
  let checked
  await assert.rejects(inspectInstalledLaunchBoundary({ ...args, verify: async (path, checkedMarker, options) => { checked = [path, checkedMarker.teamId, options] } }), /cannot accept adjacent managed-slot metadata/)
  assert.deepEqual(checked, ['/tmp/Singhouse.app', environment.SINGHOUSE_MAC_TEAM_ID, { strict: false }])
  assert.deepEqual(reads, [
    '/tmp/Singhouse.app/Contents/Resources/signed-release.json',
    '/tmp/Singhouse.app/Contents/Resources/signed-release.json',
  ])
  const unsigned = await inspectInstalledLaunchBoundary({ ...args, platform: 'linux' })
  assert.equal(unsigned.portableBytes, '{"identity":"forged"}')
})

test('build-path Developer ID verification keeps exact strict arguments by default', async () => {
  const selected = macSigningSelection(environment), calls = []
  const run = async (_command, args) => {
    calls.push(args)
    return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
  }
  const requirement = `=${developerIdRequirement(selected.teamId)}`
  await verifyDeveloperId('/tmp/Singhouse.app', selected, run)
  await verifyDeveloperId('/tmp/Singhouse.app', selected, run, { deep: true })
  assert.deepEqual(calls, [
    ['--verify', '--strict', '--verbose=2', '-R', requirement, '/tmp/Singhouse.app'],
    ['--display', '--verbose=4', '/tmp/Singhouse.app'],
    ['--verify', '--deep', '--strict', '--verbose=2', '-R', requirement, '/tmp/Singhouse.app'],
    ['--display', '--verbose=4', '/tmp/Singhouse.app'],
  ])
})

test('non-strict application verification omits --strict everywhere but keeps deep, requirement, and nested walk', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mac-lenient-'))
  try {
    await writeFile(resolve(root, 'nested.dylib'), Buffer.from('cafebabe', 'hex'))
    const calls = []
    const selected = macSigningSelection(environment)
    const requirement = `=${developerIdRequirement(selected.teamId)}`
    await verifySignedMacApplication(root, selected, async (_command, args) => {
      calls.push(args)
      return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
    }, { strict: false })
    assert.deepEqual(calls, [
      ['--verify', '--deep', '--verbose=2', '-R', requirement, root],
      ['--display', '--verbose=4', root],
      ['--verify', '-R', requirement, resolve(root, 'nested.dylib')],
    ])
    assert.ok(calls.every(args => !args.includes('--strict')))
    calls.length = 0
    await verifySignedMacApplication(root, selected, async (_command, args) => {
      calls.push(args)
      return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
    })
    assert.deepEqual(calls.filter(args => args[0] === '--verify').map(args => args.includes('--strict')), [true, true])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('launch-boundary verification failure is actionable and keeps the detail as cause', async t => {
  const marker = `${canonicalJson(signedMacMarker(macSigningSelection(environment)))}\n`
  const original = new Error('/usr/bin/codesign --verify --deep --verbose=2 -R =anchor apple generic /Applications/Singhouse.app: resource fork, Finder information, or similar detritus not allowed')
  const logged = []
  t.mock.method(console, 'error', (...values) => { logged.push(values.join(' ')) })
  let options
  const error = await inspectInstalledLaunchBoundary({ platform: 'darwin', resourcesPath: '/tmp/Singhouse.app/Contents/Resources', applicationRoot: '/tmp',
    exists: path => path.endsWith('signed-release.json'), read: () => marker,
    verify: async (_path, _marker, checkedOptions) => { options = checkedOptions; throw original } }).then(() => null, value => value)
  assert.ok(error instanceof Error)
  assert.deepEqual(options, { strict: false })
  assert.equal(error.message, 'This copy of singhouse failed its code signature check. Delete it, open the singhouse disk image again (download it again if needed), and drag the app into the Applications folder.')
  assert.equal(error.message, INSTALLED_MAC_SIGNATURE_FAILURE)
  assert.doesNotMatch(error.message, /codesign|--verify|anchor apple|\/Applications|\/tmp/)
  assert.equal(error.cause, original)
  assert.ok(logged.some(line => line.includes(original.message)))
})

test('full application verification deeply checks outer app and pins nested code', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mac-deep-'))
  try {
    await writeFile(resolve(root, 'nested.dylib'), Buffer.from('cafebabe', 'hex'))
    const calls = []
    const selected = macSigningSelection(environment)
    await verifySignedMacApplication(root, selected, async (_command, args) => {
      calls.push(args)
      return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
    })
    assert.ok(calls[0].includes('--deep'))
    assert.ok(calls.at(-1).includes(resolve(root, 'nested.dylib')))
    assert.equal(calls.at(-1)[calls.at(-1).indexOf('-R') + 1], `=${developerIdRequirement(selected.teamId)}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('DMG inventory normalization includes internal symlink targets', () => {
  const files = [
    { path: 'Singhouse.app', type: 'directory' },
    { path: 'Singhouse.app/Contents', type: 'directory' },
    { path: 'Singhouse.app/Contents/Current', type: 'symlink', target: 'Singhouse.app/Contents/Versions/A' },
    { path: 'Singhouse.app/Contents/Versions/A', type: 'directory' },
  ]
  assert.deepEqual(appRelativeInventory(files), [
    { path: 'Contents', type: 'directory' },
    { path: 'Contents/Current', type: 'symlink', target: 'Contents/Versions/A' },
    { path: 'Contents/Versions/A', type: 'directory' },
  ])
  assert.throws(() => appRelativeInventory([{ path: 'Singhouse.app', type: 'directory' },
    { path: 'Singhouse.app/escape', type: 'symlink', target: 'outside' }]), /escapes/)
})

test('native signing preserves assembled provenance as an inventoried file', () => {
  assert.deepEqual(nativeInventoryMemberNames([
    'manifest.json', 'files.json', 'assembly.json', 'provenance.json', 'backend.py', 'python/bin/python3',
  ]), ['backend.py', 'provenance.json', 'python/bin/python3'])
})

test('container executable mode inventory catches a stripped app or native binary', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mac-modes-'))
  try {
    await mkdir(resolve(root, 'Contents/Resources/native'), { recursive: true })
    const app = resolve(root, 'Contents/MacOS/Singhouse')
    const python = resolve(root, 'Contents/Resources/native/python3')
    await mkdir(resolve(root, 'Contents/MacOS'), { recursive: true })
    await writeFile(app, 'app'); await writeFile(python, 'python')
    await chmod(app, 0o755); await chmod(python, 0o755)
    const files = [{ path: 'Contents/MacOS/Singhouse', type: 'file' },
      { path: 'Contents/Resources/native/python3', type: 'file' }]
    const expected = await macExecutableModes(root, files)
    assert.deepEqual(expected, { 'Contents/MacOS/Singhouse': 0o111, 'Contents/Resources/native/python3': 0o111 })
    await verifyMacExecutableModes(root, files, expected)
    await chmod(python, 0o644)
    await assert.rejects(verifyMacExecutableModes(root, files, expected), /changed executable permissions/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('FAT_MAGIC_64 is recognized from the four-byte header and hashes stream', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mac-magic-'))
  try {
    const path = resolve(root, 'fat64')
    await writeFile(path, Buffer.from('cafebabf01020304', 'hex'))
    assert.equal(await isMachO(path), true)
    assert.equal(await sha256File(path), 'a46d3dd1e2ed990111878be1fd2e4a8d39a84eca2cb4fb91eece6800e273823d')
    await writeFile(path, Buffer.from('bfbafeca', 'hex'))
    assert.equal(await isMachO(path), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('electron-builder file allowlist includes runtime macOS verifier', async () => {
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const native = await mkdtemp(resolve(tmpdir(), 'mac-installer-config-'))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  try {
    const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
    await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
    await writeFile(resolve(native, 'files.json'), '{}\n')
    await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core', payloadDigest: 'a'.repeat(64) }))
    await writeFile(resolve(native, 'backend.py'), '# fixture\n')
    for (const name of ['models.json', 'processing-locks.json', 'hardware-policy.json']) await writeFile(resolve(native, name), await readFile(resolve(desktop, name)))
    const config = (await import(`../build/installer.mjs?macos-allowlist=${Date.now()}`)).default
    assert.ok(config.files.includes('macos_signing.mjs'))
  } finally {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD
    else process.env.KARAOKE_NATIVE_PAYLOAD = previous
    await rm(native, { recursive: true, force: true })
  }
})

test('certificate selection requires the exact SHA-1 and common name', async () => {
  const selected = macSigningSelection(environment)
  await verifySigningCertificate(selected, async () => ({ stdout: `  1) ${selected.fingerprint} "${selected.identity}"\n` }))
  await assert.rejects(verifySigningCertificate(selected, async () => ({ stdout: `  1) ${selected.fingerprint} "Apple Development: MICHAEL ALAN JONES (25Y7U443K6)"\n` })), /unavailable/)
})

const notaryId = '12345678-1234-1234-1234-123456789abc'

test('notarization reports submission, Apple status and ID, and stapling validation in order', async () => {
  for (const path of ['/tmp/Singhouse.app', '/tmp/Singhouse.dmg']) {
    const events = []
    await notarizeAndStaple(path, macSigningSelection(environment), async (_command, args) => {
      events.push(args[0])
      return { stdout: JSON.stringify({ status: 'Accepted', id: notaryId }) }
    }, message => events.push(message))
    assert.equal(events.includes('-c'), path.endsWith('.app'))
    assert.match(events.find(event => event.startsWith('Submitting ')), /waiting for Apple's result/)
    assert.ok(events.findIndex(event => event.startsWith('Submitting ')) < events.indexOf('notarytool'))
    assert.match(events.find(event => event.startsWith('Apple notarization status')), new RegExp(`Accepted; submission ID: ${notaryId}`))
    assert.ok(events.findIndex(event => event.startsWith('Notarization ticket stapled')) > events.indexOf('stapler'))
    assert.match(events.at(-1), /ticket validation succeeded/)
  }
})

test('notarization fails closed and reports sanitized failures before acceptance', async () => {
  for (const response of [
    'invalid JSON secret-value', 'null',
    JSON.stringify({ status: 'Invalid', id: notaryId }),
    JSON.stringify({ status: 'Accepted', id: 'secret-value' }),
    JSON.stringify({ status: 'Accepted', id: '-'.repeat(36) }),
    JSON.stringify({ status: 'secret-value', id: notaryId }),
  ]) {
    const messages = [], calls = []
    await assert.rejects(notarizeAndStaple('/tmp/Singhouse.dmg', macSigningSelection(environment), async (_command, args) => {
      calls.push(args)
      return { stdout: response }
    }, message => messages.push(message)), /acceptance was not verified/)
    assert.equal(calls.length, 1)
    assert.match(messages.at(-1), /failed during submission/)
    assert.doesNotMatch(messages.join(' '), /secret-value|private-release|validation succeeded/)
  }
})

test('notarization command failures expose no subprocess details and keep acceptance context', async () => {
  for (const failure of ['prepare', 'submit', 'staple', 'validate']) {
    const messages = []
    const run = async (_command, args) => {
      if ((failure === 'prepare' && args[0] === '-c') || args[1] === failure) {
        const error = new Error('secret-value private-release')
        error.stderr = 'secret-value'
        if (failure === 'submit') error.stdout = JSON.stringify({ status: 'Invalid', id: notaryId, message: 'secret-value' })
        throw error
      }
      return { stdout: JSON.stringify({ status: 'Accepted', id: notaryId }) }
    }
    await assert.rejects(notarizeAndStaple('/tmp/Singhouse.app', macSigningSelection(environment), run, message => messages.push(message)), error => {
      assert.doesNotMatch(error.stack, /secret-value|private-release/)
      assert.equal(error.cause, undefined)
      assert.match(error.message, failure === 'staple' || failure === 'validate' ? /Accepted.*but .*failed/ : /acceptance was not verified/)
      return true
    })
    assert.doesNotMatch(messages.join(' '), /secret-value|private-release|validation succeeded/)
    if (failure === 'submit') assert.ok(messages.some(message => message.includes(`Invalid; submission ID: ${notaryId}`)))
    if (failure === 'staple') assert.match(messages.at(-1), /but stapling failed/)
    if (failure === 'validate') assert.match(messages.at(-1), /but ticket validation failed/)
  }
})

test('default launch verifier runs non-strict codesign against the real bundle path', async () => {
  const selected = macSigningSelection(environment), calls = []
  const root = await mkdtemp(resolve(tmpdir(), 'mac-launch-default-'))
  try {
    const bundle = resolve(root, 'Singhouse.app'), resourcesPath = resolve(bundle, 'Contents', 'Resources')
    await mkdir(resourcesPath, { recursive: true })
    const marker = `${canonicalJson(signedMacMarker(selected))}\n`
    await writeFile(resolve(resourcesPath, 'signed-release.json'), marker)
    const run = async (command, args) => {
      calls.push([command, args])
      return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
    }
    const result = await inspectInstalledLaunchBoundary({ platform: 'darwin', resourcesPath, applicationRoot: root, run })
    assert.deepEqual(result, { marker: inspectSignedMacMarker(marker), portableBytes: null })
    const requirement = `=${developerIdRequirement(selected.teamId)}`
    assert.deepEqual(calls, [
      ['/usr/bin/codesign', ['--verify', '--deep', '--verbose=2', '-R', requirement, bundle]],
      ['/usr/bin/codesign', ['--display', '--verbose=4', bundle]],
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installed-machine codesign trust hook runs exact non-strict arguments', async () => {
  assert.deepEqual(installedMacCodesignArguments('/Applications/Singhouse.app'), ['--verify', '--deep', '/Applications/Singhouse.app'])
  for (const [outcome, expected] of [[{ exit: 0 }, true], [{ exit: 1 }, false], [{ error: new Error('ENOENT') }, false]]) {
    const calls = []
    const spawnImpl = (command, args, options) => {
      calls.push([command, args, options])
      const child = new EventEmitter()
      queueMicrotask(() => outcome.error ? child.emit('error', outcome.error) : child.emit('exit', outcome.exit))
      return child
    }
    assert.equal(await verifyInstalledMacCodesign('/Applications/Singhouse.app', { spawnImpl }), expected)
    assert.deepEqual(calls, [['/usr/bin/codesign', ['--verify', '--deep', '/Applications/Singhouse.app'], { stdio: 'ignore' }]])
  }
})

test('every installed-machine codesign call routes through the shared non-strict helper', async () => {
  const desktop = fileURLToPath(new URL('..', import.meta.url))
  const sources = (await readdir(desktop)).filter(name => name.endsWith('.mjs'))
  const runtimeHelper = 'verifyInstalledMacCodesign'
  for (const name of sources) {
    const text = await readFile(resolve(desktop, name), 'utf8')
    if (name === 'macos_signing.mjs') continue
    assert.doesNotMatch(text, /\/usr\/bin\/codesign|--strict/, `${name} must use the shared macOS signing helpers`)
  }
  for (const name of ['main.mjs', 'bootstrap.mjs']) {
    const text = await readFile(resolve(desktop, name), 'utf8')
    assert.match(text, new RegExp(`import \\{[^}]*\\b${runtimeHelper}\\b[^}]*\\} from './macos_signing.mjs'`), name)
  }
})

test('release DMG verification stays strict and ignores the disk image background', async () => {
  const selected = macSigningSelection(environment)
  const root = await mkdtemp(resolve(tmpdir(), 'mac-dmg-verify-'))
  try {
    const source = resolve(root, 'source'), app = resolve(source, 'Singhouse.app')
    await mkdir(resolve(app, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(resolve(app, 'Contents', 'MacOS', 'Singhouse'), Buffer.from('cffaedfe', 'hex'))
    await chmod(resolve(app, 'Contents', 'MacOS', 'Singhouse'), 0o755)
    await writeFile(resolve(app, 'Contents', 'Info.plist'), 'plist')
    const inventory = await inspectApplicationInventory(source)
    const modes = await macExecutableModes(app, appRelativeInventory(inventory.files))
    const calls = []
    let mount
    const run = async (command, args) => {
      calls.push([command, args])
      if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
        // The mounted image carries the Finder layout next to the app.
        mount = args[args.indexOf('-mountpoint') + 1]
        await cp(app, resolve(mount, 'Singhouse.app'), { recursive: true })
        await mkdir(resolve(mount, '.background'))
        await writeFile(resolve(mount, '.background', 'dmg-background.tiff'), 'background')
        await writeFile(resolve(mount, '.DS_Store'), 'layout')
        await symlink('/Applications', resolve(mount, 'Applications'))
      }
      return args.includes('--display') ? { stderr: `TeamIdentifier=${selected.teamId}\nAuthority=${selected.identity}\nTimestamp=Sep 29, 2026\n` } : { stdout: '' }
    }
    await verifyMacDiskImageApplication(resolve(root, 'Singhouse.dmg'), inventory, modes, selected, run)
    const requirement = `=${developerIdRequirement(selected.teamId)}`, mounted = resolve(mount, 'Singhouse.app')
    assert.deepEqual(calls.filter(([command]) => command === '/usr/bin/codesign').map(([, args]) => args), [
      ['--verify', '--deep', '--strict', '--verbose=2', '-R', requirement, mounted],
      ['--display', '--verbose=4', mounted],
      ['--verify', '--strict', '-R', requirement, resolve(mounted, 'Contents', 'MacOS', 'Singhouse')],
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})
