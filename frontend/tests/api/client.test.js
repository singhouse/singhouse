// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Core axios client: the X-Client-Id stamp is universal, the guest auth axis
// is off by default (premium wires it), and a 401 on the host UI bounces to
// the configurable auth-redirect path (default /unlock).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import client, {
  setAuthRedirectPath,
  setGuestAuthProvider,
  setGuestUnauthorizedHandler,
} from '@/api/client'

let lastConfig

function okAdapter(config) {
  lastConfig = config
  return Promise.resolve({
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  })
}

function unauthAdapter(config) {
  lastConfig = config
  const err = new Error('Request failed with status code 401')
  err.response = { status: 401, data: {}, headers: {}, config }
  err.config = config
  return Promise.reject(err)
}

function mockLocation(pathname = '/') {
  const replace = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname, search: '', replace },
  })
  return replace
}

beforeEach(() => {
  lastConfig = undefined
  // Reset the module-level seams to their core defaults each test.
  setGuestAuthProvider(() => null)
  setGuestUnauthorizedHandler(null)
  setAuthRedirectPath('/unlock')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('request interceptor', () => {
  it('stamps X-Client-Id and sends no guest credential by default (core)', async () => {
    client.defaults.adapter = okAdapter
    await client.get('/songs')
    expect(lastConfig.headers['X-Client-Id']).toBeTruthy()
    expect(lastConfig.headers['Authorization']).toBeUndefined()
  })

  it('presents the guest token once a provider is wired', async () => {
    client.defaults.adapter = okAdapter
    setGuestAuthProvider(() => 'tok-abc')
    await client.get('/songs')
    expect(lastConfig.headers['Authorization']).toBe('Guest tok-abc')
  })

  it('uses the Guest scheme, never Bearer', async () => {
    // A guest token authorizes far less than a host session. Sharing the
    // Bearer scheme would let anything that special-cases Bearer treat the
    // two as the same kind of credential.
    client.defaults.adapter = okAdapter
    setGuestAuthProvider(() => 'tok-abc')
    await client.get('/songs')
    expect(lastConfig.headers['Authorization']).not.toMatch(/^Bearer/i)
  })

  it('never overrides an Authorization the caller set', async () => {
    client.defaults.adapter = okAdapter
    setGuestAuthProvider(() => 'tok-abc')
    await client.get('/songs', { headers: { Authorization: 'Guest explicit' } })
    expect(lastConfig.headers['Authorization']).toBe('Guest explicit')
  })

  it('sends nothing when the provider has no token', async () => {
    // The gap between "premium is installed" and "this device has joined".
    client.defaults.adapter = okAdapter
    setGuestAuthProvider(() => null)
    await client.get('/songs')
    expect(lastConfig.headers['Authorization']).toBeUndefined()
  })

  it('no longer appends a ?host query param', async () => {
    // The regression test for the hole guest admission closed: ?host=<id> named
    // and proved nothing, and the server has stopped reading it. A client
    // still sending it would look like it worked while silently doing nothing.
    client.defaults.adapter = okAdapter
    setGuestAuthProvider(() => 'tok-abc')
    await client.get('/songs')
    expect(lastConfig.params?.host).toBeUndefined()
  })
})

describe('guest 401 handling', () => {
  it('repairs the guest surface instead of bouncing to a login', async () => {
    // /join has no login to send anyone to, so an expired token is handled in
    // place — re-join silently if the code is still in hand.
    mockLocation('/join')
    const repair = vi.fn()
    setGuestUnauthorizedHandler(repair)
    client.defaults.adapter = unauthAdapter

    await expect(client.get('/rotation')).rejects.toBeTruthy()
    expect(repair).toHaveBeenCalled()
  })

  it('does not re-enter the handler for a failed join exchange', async () => {
    // The exchange failing IS the condition the handler reacts to; calling it
    // from there is a loop.
    mockLocation('/join')
    const repair = vi.fn()
    setGuestUnauthorizedHandler(repair)
    client.defaults.adapter = unauthAdapter

    await expect(client.post('/join', { code: 'nope' })).rejects.toBeTruthy()
    expect(repair).not.toHaveBeenCalled()
  })

  it('leaves the host UI on its login bounce', async () => {
    const replace = mockLocation('/')
    const repair = vi.fn()
    setGuestUnauthorizedHandler(repair)
    client.defaults.adapter = unauthAdapter

    await expect(client.get('/songs')).rejects.toBeTruthy()
    expect(replace).toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
  })
})

describe('401 redirect', () => {
  it('bounces the host UI to /unlock by default', async () => {
    const replace = mockLocation('/')
    client.defaults.adapter = unauthAdapter
    await expect(client.get('/songs')).rejects.toBeTruthy()
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/unlock?next='))
  })

  it('honors setAuthRedirectPath (premium → /login)', async () => {
    const replace = mockLocation('/')
    setAuthRedirectPath('/login')
    client.defaults.adapter = unauthAdapter
    await expect(client.get('/songs')).rejects.toBeTruthy()
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/login?next='))
  })

  it('does not redirect guest pages (e.g. /screen)', async () => {
    const replace = mockLocation('/screen')
    client.defaults.adapter = unauthAdapter
    await expect(client.get('/songs')).rejects.toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
})
