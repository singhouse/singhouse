// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLaunch, ownURL, allowedRequest, allowSpeaker, childEnvironment } from '../policy.mjs'

const origin = 'http://127.0.0.1:43871'
const valid = { origin, password: 'p'.repeat(48), nonce: 'n'.repeat(48), controlToken: 'c'.repeat(48) }
test('private launch handshake rejects credentials, paths, non-loopback and weak secrets', () => {
  assert.deepEqual(parseLaunch(JSON.stringify(valid)), valid)
  for (const invalid of ['http://localhost:43871', 'http://127.0.0.1:80', `${origin}/`, `${origin}/api`, 'https://127.0.0.1:43871', 'http://u@127.0.0.1:43871', 'http://203.0.113.1:8000']) {
    assert.throws(() => parseLaunch(JSON.stringify({ ...valid, origin: invalid })))
  }
  assert.throws(() => parseLaunch(JSON.stringify({ ...valid, password: 'short' })))
  assert.throws(() => parseLaunch(JSON.stringify({ ...valid, nonce: null })))
})
test('request policy cannot reach another loopback service or an external origin', () => {
  assert.equal(ownURL(`${origin}/api/songs`, origin), true)
  assert.equal(allowedRequest(`blob:${origin}/abc`, origin), true)
  assert.equal(allowedRequest('data:image/png;base64,AAAA', origin), true)
  for (const url of ['file:///etc/passwd', 'https://example.org/', 'http://127.0.0.1:8000/api', 'http://127.0.0.1:43871.evil.test/', 'blob:https://example.org/abc', 'blob:null/abc', 'javascript:alert(1)', 'ws://127.0.0.1:43871/', 'http://u@127.0.0.1:43871/api']) {
    assert.equal(allowedRequest(url, origin), false, url)
  }
})
test('speaker permission belongs only to the host main frame at the owned origin', () => {
  const request = { permission: 'speaker-selection', hostId: 1, contentsId: 1, isMainFrame: true, url: `${origin}/`, origin }
  assert.equal(allowSpeaker(request), true)
  for (const patch of [{ contentsId: 2 }, { isMainFrame: false }, { isMainFrame: undefined }, { url: 'about:blank' }, { permission: 'media' }, { url: 'http://127.0.0.1:8000/' }, { hostId: undefined, contentsId: undefined }]) {
    assert.equal(allowSpeaker({ ...request, ...patch }), false)
  }
})
test('backend environment drops inherited configuration, home and Python injection', () => {
  assert.deepEqual(childEnvironment({ PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/private', PYTHONPATH: '/plugin', KARAOKE_PROVIDERS_DIR: '/personal', DATABASE_URL: '/live', SESSION_SECRET: 'private', HTTPS_PROXY: 'remote' }), { PATH: '/usr/bin', LANG: 'en_US.UTF-8' })
})

test('packaged handshake binds all runtime versions and refuses unexpected identity fields', async () => {
  const { validateManifest, sameIdentity } = await import('../policy.mjs')
  const identity = { schema: 1, appVersion: '1.0.0', backendVersion: '1.0.0', lyricsyncVersion: '1.0.0', pythonVersion: '3.12.8', platform: 'linux', arch: 'x64', runtimeId: 'build-123' }
  assert.equal(validateManifest(identity, '1.0.0', 'linux', 'x64'), identity)
  assert.equal(sameIdentity(identity, { ...identity }), true)
  for (const changed of [{ ...identity, extra: true }, { ...identity, arch: 'arm64' }, { ...identity, appVersion: '2.0.0' }]) {
    assert.throws(() => validateManifest(changed, '1.0.0', 'linux', 'x64'))
    assert.throws(() => parseLaunch(JSON.stringify({ ...valid, identity: changed }), identity))
  }
  assert.throws(() => parseLaunch(JSON.stringify(valid), identity))
  assert.deepEqual(parseLaunch(JSON.stringify({ ...valid, identity }), identity).identity, identity)
})
