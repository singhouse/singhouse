// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Wire contract for the Plex slice. The load-bearing parts are the shapes the
// backend routes actually expose: settings that never carry a token back, a
// library key that is URL-encoded rather than interpolated raw, and a track
// listing whose paging travels as query params.

import { beforeEach, describe, expect, it } from 'vitest'
import client, { plexApi } from '@/api/client'

let lastConfig

function okAdapter(config) {
  lastConfig = config
  return Promise.resolve({
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  })
}

beforeEach(() => {
  lastConfig = undefined
  client.defaults.adapter = okAdapter
})

describe('plexApi', () => {
  it('exposes the whole slice', () => {
    for (const name of [
      'getSettings', 'setSettings', 'test',
      'listLibraries', 'listTracks', 'importTracks',
    ]) {
      expect(typeof plexApi[name]).toBe('function')
    }
  })

  it('reads the settings', async () => {
    await plexApi.getSettings()
    expect(lastConfig.url).toBe('/plex/settings')
    expect(lastConfig.method).toBe('get')
  })

  it('PUTs only the fields the caller passed', async () => {
    await plexApi.setSettings({ url: 'http://plex.lan:32400' })
    expect(lastConfig.url).toBe('/plex/settings')
    expect(lastConfig.method).toBe('put')
    expect(JSON.parse(lastConfig.data)).toEqual({ url: 'http://plex.lan:32400' })
  })

  it('tests the connection with a POST and no body of its own', async () => {
    await plexApi.test()
    expect(lastConfig.url).toBe('/plex/test')
    expect(lastConfig.method).toBe('post')
  })

  it('lists libraries', async () => {
    await plexApi.listLibraries()
    expect(lastConfig.url).toBe('/plex/libraries')
  })

  it('encodes the library key into the path', async () => {
    await plexApi.listTracks('a/b', { offset: 100, limit: 50, q: 'zither' })
    expect(lastConfig.url).toBe('/plex/libraries/a%2Fb/tracks')
    expect(lastConfig.params).toEqual({ offset: 100, limit: 50, q: 'zither' })
  })

  it('posts the selected tracks', async () => {
    const body = { tracks: [{ rating_key: '5501', title: 'Zither Blues' }] }
    await plexApi.importTracks(body)
    expect(lastConfig.url).toBe('/plex/import')
    expect(lastConfig.method).toBe('post')
    expect(JSON.parse(lastConfig.data)).toEqual(body)
  })
})
