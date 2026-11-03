// SPDX-License-Identifier: AGPL-3.0-only
//
// incomingSongId: the song-detail fetch on its way to the deck.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const get = vi.fn()
vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { get: (...a) => get(...a), list: vi.fn() },
  lyricsSetsApi: {},
}))

import { useSongsStore } from '@/stores/songs'

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  get.mockReset()
})

describe('incomingSongId', () => {
  it('names a new song while its details are fetched', async () => {
    const store = useSongsStore()
    const d = deferred()
    get.mockReturnValueOnce(d.promise)
    const done = store.loadSong({ id: 5 })
    expect(store.incomingSongId).toBe(5)
    d.resolve({ data: { id: 5 } })
    await done
    expect(store.incomingSongId).toBe(null)
    expect(store.currentSong.id).toBe(5)
  })

  it('is not set by a refresh of the song already in the deck', async () => {
    const store = useSongsStore()
    store.currentSong = { id: 5 }
    const d = deferred()
    get.mockReturnValueOnce(d.promise)
    const done = store.loadSong({ id: 5 }, { refresh: true })
    expect(store.incomingSongId).toBe(null)
    d.resolve({ data: { id: 5, title: 'refreshed' } })
    await done
    expect(store.currentSong.title).toBe('refreshed')   // refreshes still apply
  })

  it('a later load takes it over, and the earlier finish leaves it alone', async () => {
    const store = useSongsStore()
    const first = deferred()
    const second = deferred()
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = store.loadSong({ id: 5 })
    const b = store.loadSong({ id: 6 })
    expect(store.incomingSongId).toBe(6)
    first.resolve({ data: { id: 5 } })
    await a
    expect(store.incomingSongId).toBe(6)
    expect(store.currentSong).toBe(null)                // superseded: never applied
    second.resolve({ data: { id: 6 } })
    await b
    expect(store.incomingSongId).toBe(null)
    expect(store.currentSong.id).toBe(6)
  })

  it('ignores a superseded response that arrives last', async () => {
    const store = useSongsStore()
    const first = deferred()
    const second = deferred()
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = store.loadSong({ id: 2 })
    const b = store.loadSong({ id: 1 })
    second.resolve({ data: { id: 1 } })
    await b
    expect(store.currentSong.id).toBe(1)
    expect(store.incomingSongId).toBe(null)
    first.resolve({ data: { id: 2 } })
    await a
    expect(store.currentSong.id).toBe(1)
    expect(store.incomingSongId).toBe(null)
  })

  it('a late failure of a superseded load changes nothing', async () => {
    const store = useSongsStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = deferred()
    let failFirst
    get.mockReturnValueOnce(new Promise((_, r) => { failFirst = r }))
      .mockReturnValueOnce(first.promise)
    const a = store.loadSong({ id: 2 })
    const b = store.loadSong({ id: 1 })
    first.resolve({ data: { id: 1 } })
    await b
    failFirst(new Error('late'))
    await a
    expect(store.currentSong.id).toBe(1)
    err.mockRestore()
  })

  it('re-clicking the loaded song supersedes a different pending load', async () => {
    const store = useSongsStore()
    store.currentSong = { id: 1 }
    const toTwo = deferred()
    const backToOne = deferred()
    get.mockReturnValueOnce(toTwo.promise).mockReturnValueOnce(backToOne.promise)
    const a = store.loadSong({ id: 2 })
    const b = store.loadSong({ id: 1 })
    expect(store.incomingSongId).toBe(1)
    toTwo.resolve({ data: { id: 2 } })
    await a
    expect(store.currentSong.id).toBe(1)
    backToOne.resolve({ data: { id: 1 } })
    await b
    expect(store.currentSong.id).toBe(1)
    expect(store.incomingSongId).toBe(null)
  })

  it('a refresh never cancels a newer deck load, and a stale refresh is dropped', async () => {
    const store = useSongsStore()
    store.currentSong = { id: 1 }
    const refresh = deferred()
    const deck = deferred()
    get.mockReturnValueOnce(refresh.promise).mockReturnValueOnce(deck.promise)
    const r = store.loadSong({ id: 1 }, { refresh: true })
    const d = store.loadSong({ id: 2 })
    deck.resolve({ data: { id: 2 } })
    await d
    refresh.resolve({ data: { id: 1 } })
    await r
    expect(store.currentSong.id).toBe(2)
  })

  it('clears on a failed fetch', async () => {
    const store = useSongsStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    get.mockRejectedValueOnce(new Error('offline'))
    await store.loadSong({ id: 9 })
    expect(store.incomingSongId).toBe(null)
    err.mockRestore()
  })
})
