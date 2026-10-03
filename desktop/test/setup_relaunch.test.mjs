// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setupRelaunchOptions, relaunchForSetup } from '../setup_relaunch.mjs'
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
