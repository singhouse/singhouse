// SPDX-License-Identifier: AGPL-3.0-only
// Pagination contract for the library fetch.
//
// The list endpoint caps page_size at 500 server-side, so one request returns
// a PREFIX of the library with nothing in the response marking it as partial.
// This is the seam that hid 354 of 554 songs from the host UI, so the
// stop conditions are pinned here rather than left to inspection.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
}))

import { fetchAllSongs, SONG_PAGE_SIZE, MAX_PAGES } from '@/utils/fetchAllSongs'

const rows = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: offset + i + 1 }))

beforeEach(() => {
  listSongs.mockReset()
})

describe('fetchAllSongs', () => {
  it('walks every page and concatenates them in server order', async () => {
    listSongs
      .mockResolvedValueOnce({ data: { songs: rows(SONG_PAGE_SIZE), total: 554 } })
      .mockResolvedValueOnce({ data: { songs: rows(54, SONG_PAGE_SIZE), total: 554 } })

    const all = await fetchAllSongs()

    expect(all).toHaveLength(554)
    expect(all[0].id).toBe(1)
    expect(all[553].id).toBe(554)
    expect(listSongs).toHaveBeenCalledTimes(2)
    expect(listSongs.mock.calls[0][0]).toMatchObject({ page: 1, pageSize: SONG_PAGE_SIZE })
    expect(listSongs.mock.calls[1][0]).toMatchObject({ page: 2, pageSize: SONG_PAGE_SIZE })
  })

  it('stops after one request when the first page is short', async () => {
    listSongs.mockResolvedValue({ data: { songs: rows(12), total: 12 } })

    const all = await fetchAllSongs()

    expect(all).toHaveLength(12)
    expect(listSongs).toHaveBeenCalledTimes(1)
  })

  it('stops on an exactly-full last page once total is reached', async () => {
    // A library of exactly PAGE_SIZE would otherwise cost a wasted request
    // for the empty page 2.
    listSongs.mockResolvedValue({
      data: { songs: rows(SONG_PAGE_SIZE), total: SONG_PAGE_SIZE },
    })

    const all = await fetchAllSongs()

    expect(all).toHaveLength(SONG_PAGE_SIZE)
    expect(listSongs).toHaveBeenCalledTimes(1)
  })

  it('stops after one request when the response carries no total', async () => {
    listSongs.mockResolvedValue({ data: { songs: [] } })

    const all = await fetchAllSongs()

    expect(all).toEqual([])
    expect(listSongs).toHaveBeenCalledTimes(1)
  })

  it('passes the search term through on every page', async () => {
    listSongs
      .mockResolvedValueOnce({ data: { songs: rows(SONG_PAGE_SIZE), total: 501 } })
      .mockResolvedValueOnce({ data: { songs: rows(1), total: 501 } })

    await fetchAllSongs('bowie')

    expect(listSongs.mock.calls[0][0]).toMatchObject({ search: 'bowie' })
    expect(listSongs.mock.calls[1][0]).toMatchObject({ search: 'bowie' })
  })

  it('does not spin forever when total never agrees with the pages served', async () => {
    // A backend that keeps returning full pages against an inflated total
    // must hit the page backstop, not loop until the tab dies. Each page
    // returns DISTINCT ids so the no-new-rows stop does not mask this.
    let n = 0
    listSongs.mockImplementation(() => Promise.resolve({
      data: { songs: rows(SONG_PAGE_SIZE, SONG_PAGE_SIZE * n++), total: Number.MAX_SAFE_INTEGER },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchAllSongs()

    expect(listSongs).toHaveBeenCalledTimes(MAX_PAGES)
    // Truncating silently is the bug class this util exists to remove.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('stops when a full page contributes no new rows', async () => {
    // A backend that ignores `page` would otherwise be walked MAX_PAGES times
    // for one page of data.
    listSongs.mockResolvedValue({ data: { songs: rows(SONG_PAGE_SIZE) } })

    const all = await fetchAllSongs()

    expect(all).toHaveLength(SONG_PAGE_SIZE)
    expect(listSongs).toHaveBeenCalledTimes(2)
  })

  it('deduplicates rows repeated across pages', async () => {
    // Offset pagination over a non-unique sort key (created_at DESC, no
    // tiebreak) can serve the same row on two pages — and does, when a row is
    // inserted mid-walk by an ingest that is still running.
    listSongs
      .mockResolvedValueOnce({ data: { songs: rows(SONG_PAGE_SIZE), total: 501 } })
      .mockResolvedValueOnce({ data: { songs: [{ id: SONG_PAGE_SIZE }, { id: 501 }], total: 501 } })

    const all = await fetchAllSongs()

    const ids = all.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(501)
  })

  it('does not let duplicates satisfy `total` and hide unfetched songs', async () => {
    // The stop condition must count rows REQUESTED, not rows kept. Page 2 here
    // is all duplicates; counting kept rows would leave page 3 unfetched.
    listSongs
      .mockResolvedValueOnce({ data: { songs: rows(SONG_PAGE_SIZE), total: 1002 } })
      .mockResolvedValueOnce({ data: { songs: rows(SONG_PAGE_SIZE), total: 1002 } })
      .mockResolvedValueOnce({ data: { songs: rows(2, 1000), total: 1002 } })

    const all = await fetchAllSongs()

    // Page 2 duplicated page 1 entirely, so the walk stops there on the
    // no-new-rows rule — but it must NOT have stopped because `all.length`
    // reached `total` off the back of duplicates.
    expect(all.every((s, i, arr) => arr.findIndex(x => x.id === s.id) === i)).toBe(true)
    expect(listSongs).toHaveBeenCalledTimes(2)
  })

  it('breaks rather than throwing when the payload is not a list', async () => {
    listSongs.mockResolvedValue({ data: { songs: { nope: true }, total: 9 } })

    await expect(fetchAllSongs()).resolves.toEqual([])
  })
})
