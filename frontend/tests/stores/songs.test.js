// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Store-level contract for the library load.
//
// The commit that introduced this called the processing-poll "the subtle half
// of the fix": the poll overwrites `songs` wholesale every 3s, so a poll that
// fetched one page would quietly undo a paginated fetchSongs seconds later.
// That regression is invisible in the component tests, so it is pinned here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
  lyricsSetsApi: {},
}))

import { useSongsStore } from '@/stores/songs'
import { SONG_PAGE_SIZE } from '@/utils/fetchAllSongs'

const rows = (n, offset = 0, status = 'ready') =>
  Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, status }))

// A full first page plus a short second one, with one row still ingesting so
// the poll arms itself.
function twoPageLibrary() {
  const page1 = rows(SONG_PAGE_SIZE)
  page1[0] = { id: 1, status: 'processing', phase: 'separating' }
  const page2 = rows(54, SONG_PAGE_SIZE)
  return { page1, page2, total: SONG_PAGE_SIZE + 54 }
}

function serveTwoPages() {
  const { page1, page2, total } = twoPageLibrary()
  listSongs.mockImplementation(({ page }) =>
    Promise.resolve({ data: { songs: page === 1 ? page1 : page2, total } })
  )
  return total
}

beforeEach(() => {
  setActivePinia(createPinia())
  listSongs.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchSongs', () => {
  it('loads the whole library, not just the first page', async () => {
    const total = serveTwoPages()
    const store = useSongsStore()

    await store.fetchSongs()

    expect(store.songs).toHaveLength(total)
    expect(listSongs).toHaveBeenCalledTimes(2)
  })

  it('keeps the last known-good list when a page request fails', async () => {
    serveTwoPages()
    const store = useSongsStore()
    await store.fetchSongs()
    const loaded = store.songs.length

    listSongs.mockRejectedValue(new Error('network blip'))
    await store.fetchSongs()

    // Blanking the library mid-show is worse than a briefly stale one.
    expect(store.songs).toHaveLength(loaded)
    expect(store.error).toBe('network blip')
    expect(store.loading).toBe(false)
  })

  it('discards a walk that was superseded while it was in flight', async () => {
    const store = useSongsStore()
    let releaseFirst
    const firstPage = new Promise(res => { releaseFirst = res })

    listSongs
      .mockImplementationOnce(() => firstPage)                                     // stale walk
      .mockImplementation(() => Promise.resolve({ data: { songs: rows(2, 900), total: 2 } }))

    const stale = store.fetchSongs({ search: '' })       // starts, then blocks
    const fresh = store.fetchSongs({ search: 'bowie' })  // supersedes it
    await fresh

    releaseFirst({ data: { songs: rows(400), total: 400 } })
    await stale

    // The stale walk resolved LAST; it must not repaint the full library over
    // the search results.
    expect(store.songs).toHaveLength(2)
    expect(store.searchQuery).toBe('bowie')
  })
})

describe('the processing poll', () => {
  it('paginates too, so it cannot shrink a fully-loaded library', async () => {
    vi.useFakeTimers()
    const total = serveTwoPages()
    const store = useSongsStore()

    await store.fetchSongs()
    expect(store.songs).toHaveLength(total)
    listSongs.mockClear()

    await vi.advanceTimersByTimeAsync(3000)

    // Both pages requested again, and the list did not snap back to page 1.
    expect(listSongs).toHaveBeenCalledTimes(2)
    expect(listSongs.mock.calls.map(c => c[0].page)).toEqual([1, 2])
    expect(store.songs).toHaveLength(total)
  })

  it('does not arm when nothing is ingesting', async () => {
    vi.useFakeTimers()
    listSongs.mockResolvedValue({ data: { songs: rows(3), total: 3 } })
    const store = useSongsStore()

    await store.fetchSongs()
    listSongs.mockClear()

    await vi.advanceTimersByTimeAsync(6000)

    expect(listSongs).not.toHaveBeenCalled()
  })
})
