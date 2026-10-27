// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Wire contract for the two requests behind the host's undo of a ▶ Sing: a
// front insert into the queue and a conditional delete of the play row. The
// plain forms of both must stay byte-for-byte what they were.

import { beforeEach, describe, expect, it } from 'vitest'
import client, { historyApi, queueApi } from '@/api/client'

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

describe('queueApi.add', () => {
  it('appends without a front flag by default', async () => {
    await queueApi.add(5, 'Sam')
    expect(lastConfig.url).toBe('/queue')
    expect(JSON.parse(lastConfig.data)).toEqual({ song_id: 5, singer_name: 'Sam' })
  })

  it('sends front: true for an undo', async () => {
    await queueApi.add(5, null, { front: true })
    expect(JSON.parse(lastConfig.data)).toEqual({ song_id: 5, singer_name: null, front: true })
  })
})

describe('historyApi.remove', () => {
  it('sends no conditions by default', async () => {
    await historyApi.remove(9)
    expect(lastConfig.url).toBe('/history/9')
    expect(lastConfig.method).toBe('delete')
    expect(lastConfig.params).toBeUndefined()
  })

  it('sends if_incomplete and song_id for an undo', async () => {
    await historyApi.remove(9, { ifIncomplete: true, songId: 101 })
    expect(lastConfig.params).toEqual({ if_incomplete: true, song_id: 101 })
  })

  it('sends if_incomplete alone when no song is given', async () => {
    await historyApi.remove(9, { ifIncomplete: true })
    expect(lastConfig.params).toEqual({ if_incomplete: true })
  })
})
