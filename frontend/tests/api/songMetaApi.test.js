// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Wire contract for the two song-scoped routes the Song tools Details tab
// speaks. `updateSong` has existed server-side with zero frontend callers, so
// this is the first thing pinning its path and verb; `retryIngest` is new.

import { beforeEach, describe, expect, it } from 'vitest'
import client, { songApi } from '@/api/client'

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

describe('songApi.updateSong', () => {
  it('PATCHes the song with only the fields it was given', async () => {
    await songApi.updateSong(12, { artist: 'Bowie', title: 'Heroes' })
    expect(lastConfig.url).toBe('/songs/12')
    expect(lastConfig.method).toBe('patch')
    expect(JSON.parse(lastConfig.data)).toEqual({ artist: 'Bowie', title: 'Heroes' })
  })

  it('is reachable under the older `update` spelling too', async () => {
    await songApi.update(12, { title: 'Heroes' })
    expect(lastConfig.url).toBe('/songs/12')
    expect(lastConfig.method).toBe('patch')
    expect(JSON.parse(lastConfig.data)).toEqual({ title: 'Heroes' })
  })
})

describe('songApi.retryIngest', () => {
  it('posts to the song’s retry route with no body of its own', async () => {
    // The options are recovered server-side from the original ingest job —
    // there is nothing for the client to send, and sending anything would
    // invite a caller to think it could choose.
    await songApi.retryIngest(9)
    expect(lastConfig.url).toBe('/songs/9/retry')
    expect(lastConfig.method).toBe('post')
    expect(lastConfig.data).toBeUndefined()
  })
})
