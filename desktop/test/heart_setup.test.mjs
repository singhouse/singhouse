// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeartSetup, authorizedHeartCaller, heartManifest } from '../heart_setup.mjs'

const files = [{ path: 'huggingface/heart/abc/config.json', size: 25, revision: 'abc', url: 'https://huggingface.co/model/resolve/abc/config.json' }]
const policy = { models: [{ id: 'heart-transcriptor', files }] }
function fixture(overrides = {}) {
  const calls = []
  const cache = { active: async () => null, validate: () => {},
    install: async () => calls.push('install'),
    installFromDirectory: async (...args) => calls.push(['local', ...args]) }
  const setup = new HeartSetup({ cache, policy, loadedModels: null,
    consent: async () => 'upstream', chooseDirectory: async () => '/chosen/heart',
    notify: async message => calls.push(message), ...overrides })
  return { setup, cache, calls }
}
test('declined consent never retrieves files or reports installation', async () => {
  const { setup, calls } = fixture({ consent: async () => 'cancel' })
  assert.deepEqual(await setup.prepare(), { installed: false, restartRequired: false })
  assert.deepEqual(calls, [])
})
test('verified files loaded in this process need no consent or network', async () => {
  const active = { id: 'verified', manifest: { models: ['heart-transcriptor'] } }
  const { setup, cache, calls } = fixture({ loadedModels: active, consent: () => assert.fail('unexpected consent') })
  cache.active = async () => active
  assert.deepEqual(await setup.prepare(), { installed: true, restartRequired: false })
  assert.deepEqual(calls, [])
})
test('new installation requests reopen and never pretends the backend was updated', async () => {
  const { setup, calls } = fixture()
  assert.deepEqual(await setup.prepare(), { installed: false, restartRequired: true })
  assert.equal(calls[0], 'install')
  assert.match(calls[1], /Reopen/)
})
test('damaged checkpoint asks consent again and preserves the trusted selection for repair', async () => {
  const damaged = { id: 'damaged', manifest: { models: ['heart-transcriptor'] } }
  const { setup, cache, calls } = fixture({ loadedModels: damaged, consent: async options => {
    assert.equal(options.repair, true)
    return 'upstream'
  } })
  cache.active = async () => { throw new Error('checksum') }
  cache.selectionForRepair = async () => damaged
  assert.equal((await setup.prepare()).restartRequired, true)
  assert.equal(calls[0], 'install')
})
test('offline selection uses the chosen directory and fixed inventory prefix', async () => {
  const { setup, calls } = fixture({ consent: async () => 'directory' })
  await setup.prepare()
  assert.equal(calls[0][0], 'local')
  assert.equal(calls[0][2], '/chosen/heart')
  assert.equal(calls[0][3].prefix, 'huggingface/heart/abc')
  assert.ok(!calls.includes('install'))
})
test('concurrent clicks share one consent and cancellation is recoverable', async () => {
  const { setup, cache, calls } = fixture()
  let started
  const pending = new Promise(resolve => { started = resolve })
  cache.install = async (_, { signal }) => {
    started()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  }
  const first = setup.prepare(), second = setup.prepare()
  assert.equal(first, second)
  await pending
  setup.cancel()
  assert.match((await first).reason, /cancelled/)
  cache.install = async () => calls.push('retry')
  assert.equal((await setup.prepare()).restartRequired, true)
  assert.ok(calls.includes('retry'))
})
test('adding Heart preserves existing model selections', () => {
  const other = { id: 'other', files: [{ path: 'torch/other' }] }
  const result = heartManifest({ models: [...policy.models, other] }, { manifest: { models: ['other'] } })
  assert.deepEqual(result.models, ['other', 'heart-transcriptor'])
  assert.equal(result.files.length, 2)
})
test('setup IPC accepts only the host main frame at its private origin', () => {
  const frame = { url: 'http://127.0.0.1:8765/library' }
  const contents = { mainFrame: frame }
  const host = { webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  assert.equal(authorizedHeartCaller(event, host, 'http://127.0.0.1:8765'), true)
  assert.equal(authorizedHeartCaller({ ...event, sender: {} }, host, 'http://127.0.0.1:8765'), false)
  assert.equal(authorizedHeartCaller({ ...event, senderFrame: { ...frame } }, host, 'http://127.0.0.1:8765'), false)
  assert.equal(authorizedHeartCaller(event, host, 'http://malicious.example'), false)
})
