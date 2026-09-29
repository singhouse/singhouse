// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { checkModalConnection } from '../modal_connection.mjs'

const configuration = { app: 'owned-app', environment: 'main', version: 2,
  tokenId: 'test_id', tokenSecret: 'secret_only_on_stdin', consent: { uploads: false, usage: false } }
function fake(response, { neverClose = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdin = new EventEmitter()
  child.kill = () => { child.killed = true }
  child.stdin.end = value => {
    child.input = value
    if (!neverClose) queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(response))
      child.emit('close', 0)
    })
  }
  return { child, spawnImpl: (python, args, options) => { child.launch = { python, args, options }; return child } }
}
const success = { schema: 1, accessChecked: true, compatible: true, qualified: false, ready: false,
  stages: { access: 'passed', tags: 'passed', functions: 'passed' } }

test('metadata check sends secrets only to private stdin, strips response fields and never claims ready', async () => {
  const fixture = fake(JSON.stringify({ ...success, tokenSecret: configuration.tokenSecret }))
  const result = await checkModalConnection({ ...fixture, configuration, python: '/owned/python', helper: '/owned/helper' })
  assert.deepEqual(result, success)
  assert.equal(JSON.stringify(fixture.child.launch).includes(configuration.tokenSecret), false)
  assert.deepEqual(JSON.parse(fixture.child.input), { app: configuration.app, environment: 'main', version: 2,
    tokenId: configuration.tokenId, tokenSecret: configuration.tokenSecret })
  assert.equal(fixture.child.launch.options.stdio[2], 'ignore')
})
test('helper failures, oversized output, and unexpected ready claims fail closed', async () => {
  for (const response of ['not json', 'x'.repeat(32769), JSON.stringify({ ...success, ready: true }),
    JSON.stringify({ ...success, qualified: true })]) {
    const result = await checkModalConnection({ ...fake(response), configuration })
    assert.equal(result.ready, false)
    assert.equal(result.compatible, false)
    assert.equal(result.errorCode, 'invalid_response')
  }
})
test('timeout kills a stalled helper and no configured credentials means no process', async () => {
  const fixture = fake('', { neverClose: true })
  const result = await checkModalConnection({ ...fixture, configuration, timeoutMs: 5 })
  assert.equal(result.errorCode, 'timeout')
  assert.equal(fixture.child.killed, true)
  const absent = await checkModalConnection({ configuration: null, spawnImpl: () => assert.fail('must not spawn') })
  assert.equal(absent.errorCode, 'not_configured')
})
