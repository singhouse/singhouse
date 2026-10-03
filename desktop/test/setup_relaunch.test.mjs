// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setupRelaunchOptions, relaunchForSetup, verifiedSetupAppImageRuntime } from '../setup_relaunch.mjs'
import { restartForSetup } from '../onboarding_state.mjs'

test('AppImage setup relaunch validates outer image bytes and preserves every argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-relaunch-'))
  try {
    const outerPath = join(root, 'Singhouse.AppImage'), mountPath = join(root, 'mount')
    mkdirSync(mountPath)
    const actualExecutablePath = join(mountPath, 'Singhouse')
    writeFileSync(outerPath, 'outer image'); writeFileSync(actualExecutablePath, 'inner executable')
    const evidence = { verified: true, outerPath, mountPath, actualExecutablePath,
      outerSha256: createHash('sha256').update('outer image').digest('hex') }
    const args = ['--user-data-dir=/tmp/profile with spaces', '--another-option', 'value']
    const options = { platform: 'linux', executablePath: actualExecutablePath, args,
      detectMount: () => ({ readOnly: true }), verifyImage: () => evidence }
    assert.deepEqual(setupRelaunchOptions(options), { execPath: outerPath, args })
    writeFileSync(outerPath, 'changed image')
    assert.throws(() => setupRelaunchOptions(options), /bytes changed/)
    assert.throws(() => setupRelaunchOptions({ ...options, args: ['bad\0argument'] }), /Invalid setup relaunch/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('regular Linux and Windows retain their executable and arguments without AppImage authority', () => {
  for (const platform of ['linux', 'win32']) {
    const options = { platform, executablePath: '/regular/Singhouse', args: ['--user-data-dir=/isolated'],
      detectMount: () => null, verifyImage: () => { throw new Error('must not inspect image') } }
    assert.deepEqual(setupRelaunchOptions(options), { execPath: options.executablePath, args: options.args })
  }
})

test('failed AppImage authentication resumes backend and never schedules relaunch or quit', async () => {
  const calls = []
  await assert.rejects(restartForSetup({
    activity: async () => ({ backendReady: true, activeJobs: 1, deferredJobs: 1 }),
    quiesce: async () => ({ quiesced: true, activeMutations: 0, jobs: { nonterminal: 1, deferred: 1 } }),
    resume: async () => calls.push('resume'),
    restart: () => relaunchForSetup({ relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') }, {
      platform: 'linux', detectMount: () => ({ readOnly: true }), verifyImage: () => { throw new Error('No authenticated ancestor') },
    }),
  }), /No authenticated ancestor/)
  assert.deepEqual(calls, ['resume'])
})

test('relaunch is scheduled before quit and scheduling errors leave the application open', () => {
  const calls = []
  const options = { platform: 'win32', executablePath: '/application', args: ['--profile=isolated'] }
  relaunchForSetup({ relaunch: value => calls.push(value), quit: () => calls.push('quit') }, options)
  assert.deepEqual(calls, [{ execPath: '/application', args: ['--profile=isolated'] }, 'quit'])
  assert.throws(() => relaunchForSetup({ relaunch: () => { throw new Error('schedule failed') }, quit: () => assert.fail() }, options), /schedule failed/)
})


test('daemonized keeper must bind the exact FUSE connection, lifetime pipe and outer image', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-keeper-'))
  try {
    const mount = join(root, '.mount_Singho'), procRoot = join(root, 'proc')
    mkdirSync(mount)
    const executablePath = join(mount, 'Singhouse'), outer = join(root, 'Singhouse.AppImage')
    writeFileSync(executablePath, 'inner')
    const bytes = Buffer.alloc(64); bytes.write('\x7fELF'); bytes.set([0x41, 0x49, 2], 8)
    writeFileSync(outer, bytes)
    for (const pid of ['self', '17']) {
      mkdirSync(join(procRoot, pid, 'fd'), { recursive: true })
      mkdirSync(join(procRoot, pid, 'fdinfo'))
      writeFileSync(join(procRoot, pid, 'stat'), `${pid === 'self' ? 99 : 17} (runtime) S 1 0 0 0\n`)
    }
    symlinkSync(executablePath, join(procRoot, 'self', 'exe'))
    symlinkSync(outer, join(procRoot, '17', 'exe'))
    writeFileSync(join(procRoot, 'self', 'mountinfo'), `2339 53 0:136 / ${mount} ro,nosuid,nodev - fuse.Singhouse Singhouse.AppImage ro\n`)
    const fd = (pid, name, target, info) => {
      const path = join(procRoot, pid, 'fd', name)
      rmSync(path, { force: true }); symlinkSync(target, path)
      writeFileSync(join(procRoot, pid, 'fdinfo', name), info)
    }
    fd('self', '1023', mount, 'flags: 0100000\nmnt_id: 2339\n')
    fd('self', '3', 'pipe:[1234]', 'flags: 00\nmnt_id: 18\n')
    fd('17', '3', outer, 'flags: 0100000\nmnt_id: 53\n')
    fd('17', '4', 'pipe:[1234]', 'flags: 01\nmnt_id: 18\n')
    fd('17', '5', '/dev/fuse', 'flags: 0100002\nfuse_connection: 136\n')
    // An enclosing launcher can itself be an AppImage without serving our
    // mount. Its ancestry and header must never outrank the exact keeper.
    const enclosing = join(root, 'terminal.AppImage')
    writeFileSync(enclosing, bytes)
    mkdirSync(join(procRoot, '23'))
    symlinkSync(enclosing, join(procRoot, '23', 'exe'))
    writeFileSync(join(procRoot, '23', 'stat'), '23 (terminal) S 1 0 0 0\n')
    writeFileSync(join(procRoot, 'self', 'stat'), '99 (Singhouse) S 23 0 0 0\n')
    const check = () => verifiedSetupAppImageRuntime({ platform: 'linux', executablePath, procRoot })
    assert.equal(check().outerPath, outer)
    assert.equal(check().outerSha256, createHash('sha256').update(bytes).digest('hex'))
    assert.notEqual(check().outerPath, enclosing)
    fd('17', '5', '/dev/fuse', 'flags: 0100002\nfuse_connection: 137\n')
    assert.throws(check, /no authenticated runtime keeper/)
    fd('17', '5', '/dev/fuse', 'flags: 0100002\nfuse_connection: 136\n')
    fd('17', '4', 'pipe:[5678]', 'flags: 01\nmnt_id: 18\n')
    assert.throws(check, /no authenticated runtime keeper/)
    fd('17', '4', 'pipe:[1234]', 'flags: 01\nmnt_id: 18\n')
    fd('self', '1023', mount, 'flags: 0100000\nmnt_id: 9999\n')
    assert.throws(check, /runtime descriptors/)
    fd('self', '1023', mount, 'flags: 0100000\nmnt_id: 2339\n')
    const unrelated = join(root, 'unrelated.AppImage'); writeFileSync(unrelated, bytes)
    fd('17', '3', unrelated, 'flags: 0100000\n')
    assert.throws(check, /no authenticated runtime keeper/)
    fd('17', '3', outer, 'flags: 0100000\n')
    writeFileSync(outer, 'not an AppImage')
    assert.throws(check, /no authenticated runtime keeper/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
