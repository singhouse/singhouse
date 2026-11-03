// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Flat play-history store. The two invariants that matter most: the ▶
// Sing action must never break because a history write failed (recordPlay
// swallows the failure and never throws), and a natural end only completes the
// row it actually belongs to (reason gate + songId match), so a Stop or an
// unrelated intervening play never flips the wrong row.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const record = vi.fn()
const complete = vi.fn()
const list = vi.fn()
const remove = vi.fn()
const clear = vi.fn()
const getSettings = vi.fn()
const setSettings = vi.fn()

vi.mock('@/api/client', () => ({
  historyApi: {
    record: (...a) => record(...a),
    complete: (...a) => complete(...a),
    list: (...a) => list(...a),
    remove: (...a) => remove(...a),
    clear: (...a) => clear(...a),
    getSettings: (...a) => getSettings(...a),
    setSettings: (...a) => setSettings(...a),
  },
}))

import { useHistoryStore } from '@/stores/history'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  list.mockResolvedValue({ data: { entries: [], total: 0 } })
  complete.mockResolvedValue({ data: { ok: true } })
  remove.mockResolvedValue({ data: { ok: true } })
  clear.mockResolvedValue({ data: { ok: true, cleared: 0 } })
  getSettings.mockResolvedValue({ data: { retention_days: 30 } })
  setSettings.mockResolvedValue({ data: { retention_days: 30 } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('recordPlay', () => {
  it('records the play and stashes the id + songId', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 77 } })

    const id = await store.recordPlay(101, 'Alice')

    expect(record).toHaveBeenCalledWith(101, 'Alice')
    expect(id).toBe(77)
    expect(store.currentHistoryId).toBe(77)
    expect(store.currentPlaySongId).toBe(101)
  })

  it('defaults the singer name to null', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 1 } })

    await store.recordPlay(5)

    expect(record).toHaveBeenCalledWith(5, null)
  })

  it('never throws on failure — sets error and leaves the ids null', async () => {
    const store = useHistoryStore()
    record.mockRejectedValue(new Error('history offline'))

    // The ▶ Sing path calls this bare; a throw here would break the sing.
    let id
    await expect(async () => { id = await store.recordPlay(101, 'Alice') }).not.toThrow()
    id = await store.recordPlay(101, 'Alice')

    expect(id).toBe(null)
    expect(store.error).toBe('history offline')
    expect(store.currentHistoryId).toBe(null)
    expect(store.currentPlaySongId).toBe(null)
  })
})

describe('completeIfPending', () => {
  async function withPendingPlay() {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 77 } })
    await store.recordPlay(101, 'Alice')
    return store
  }

  it('completes and clears the ids on a matching natural end', async () => {
    const store = await withPendingPlay()

    await store.completeIfPending({ reason: 'natural', songId: 101 })

    expect(complete).toHaveBeenCalledWith(77)
    expect(store.currentHistoryId).toBe(null)
    expect(store.currentPlaySongId).toBe(null)
  })

  it('no-ops on a manual stop (reason=stopped)', async () => {
    const store = await withPendingPlay()

    await store.completeIfPending({ reason: 'stopped', songId: 101 })

    expect(complete).not.toHaveBeenCalled()
    // Still armed — the turn is not over.
    expect(store.currentHistoryId).toBe(77)
  })

  it('no-ops when the ended songId is not the recorded play', async () => {
    const store = await withPendingPlay()

    // A direct library load of a different song ended naturally in between.
    await store.completeIfPending({ reason: 'natural', songId: 999 })

    expect(complete).not.toHaveBeenCalled()
    expect(store.currentHistoryId).toBe(77)
  })

  it('no-ops when there is no pending play', async () => {
    const store = useHistoryStore()

    await store.completeIfPending({ reason: 'natural', songId: 101 })

    expect(complete).not.toHaveBeenCalled()
  })

  it('swallows a complete failure to the error ref and still clears', async () => {
    const store = await withPendingPlay()
    complete.mockRejectedValue(new Error('complete failed'))

    await store.completeIfPending({ reason: 'natural', songId: 101 })

    expect(store.error).toBe('complete failed')
    expect(store.currentHistoryId).toBe(null)
  })
})

describe('list / mutations / settings', () => {
  it('fetchList populates entries + total and flips fetchedOnce', async () => {
    const store = useHistoryStore()
    store.search = 'bowie'
    list.mockResolvedValue({ data: { entries: [{ id: 1 }], total: 1 } })

    await store.fetchList()

    expect(list).toHaveBeenCalledWith({ search: 'bowie' })
    expect(store.entries).toHaveLength(1)
    expect(store.total).toBe(1)
    expect(store.fetchedOnce).toBe(true)
  })

  it('remove deletes then refetches', async () => {
    const store = useHistoryStore()

    await store.remove(9)

    expect(remove).toHaveBeenCalledWith(9)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('clear clears then refetches', async () => {
    const store = useHistoryStore()

    await store.clear()

    expect(clear).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('fetchSettings reads retention_days', async () => {
    const store = useHistoryStore()
    getSettings.mockResolvedValue({ data: { retention_days: 7 } })

    await store.fetchSettings()

    expect(store.retentionDays).toBe(7)
  })

  it('setRetention writes and adopts the returned value', async () => {
    const store = useHistoryStore()
    setSettings.mockResolvedValue({ data: { retention_days: 0 } })

    await store.setRetention(0)

    expect(setSettings).toHaveBeenCalledWith(0)
    expect(store.retentionDays).toBe(0)
  })
})

// Undo of a ▶ Sing: the server deletes the row only if it never completed,
// and the pending pointer must stop pointing at it before anything else.
describe('undoPlay', () => {
  it('conditionally deletes the row and rewinds the pointer to the previous play', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 9 } })
    await store.recordPlay(102, 'Bob')
    expect(store.currentHistoryId).toBe(9)

    const done = store.undoPlay(9, { historyId: 8, songId: 101 })
    // Rewound synchronously, before the delete round trip.
    expect(store.currentHistoryId).toBe(8)
    expect(store.currentPlaySongId).toBe(101)
    await done
    expect(remove).toHaveBeenCalledWith(9, { ifIncomplete: true })

    // A later natural end of the undone song completes nothing.
    await store.completeIfPending({ reason: 'natural', songId: 102 })
    expect(complete).not.toHaveBeenCalled()
    // The reloaded previous song still completes its own row.
    await store.completeIfPending({ reason: 'natural', songId: 101 })
    expect(complete).toHaveBeenCalledWith(8)
  })

  it('clears the pointer when there was no previous pending play', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 9 } })
    await store.recordPlay(102)
    await store.undoPlay(9, { historyId: null, songId: 55 })
    expect(store.currentHistoryId).toBe(null)
    expect(store.currentPlaySongId).toBe(null)
  })

  it('leaves the pointer alone when it has moved on to another row', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 12 } })
    await store.recordPlay(103)
    await store.undoPlay(9, { historyId: 8, songId: 101 })
    expect(store.currentHistoryId).toBe(12)
    expect(store.currentPlaySongId).toBe(103)
    expect(remove).toHaveBeenCalledWith(9, { ifIncomplete: true })
  })

  it('accepts a kept (completed) row without an error', async () => {
    const store = useHistoryStore()
    remove.mockResolvedValue({ data: { ok: true, deleted: false } })
    await expect(store.undoPlay(9)).resolves.toBeUndefined()
    expect(store.error).toBe(null)
  })

  it('is a no-op without an id, and never throws', async () => {
    const store = useHistoryStore()
    await store.undoPlay(null)
    expect(remove).not.toHaveBeenCalled()

    remove.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
    await expect(store.undoPlay(9)).resolves.toBeUndefined()
    expect(store.error).toBe(null)

    remove.mockRejectedValueOnce(new Error('Network'))
    await expect(store.undoPlay(9)).resolves.toBeUndefined()
    expect(store.error).toBe('Network')
  })

  it('passes the song along so the server only deletes that song’s row', async () => {
    const store = useHistoryStore()
    await store.undoPlay(9, null, { songId: 101 })
    expect(remove).toHaveBeenCalledWith(9, { ifIncomplete: true, songId: 101 })
  })

  it('rewind: false deletes the row but leaves the pointer alone', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 9 } })
    await store.recordPlay(102)
    await store.undoPlay(9, { historyId: 8, songId: 101 }, { rewind: false, songId: 102 })
    expect(store.currentHistoryId).toBe(9)
    expect(store.currentPlaySongId).toBe(102)
    expect(remove).toHaveBeenCalledWith(9, { ifIncomplete: true, songId: 102 })
  })

  it('a natural end of a row undone in another tab (404) is quiet', async () => {
    const store = useHistoryStore()
    record.mockResolvedValue({ data: { id: 9 } })
    await store.recordPlay(102)
    complete.mockRejectedValueOnce(Object.assign(new Error('history entry not found'), { status: 404 }))
    await store.completeIfPending({ reason: 'natural', songId: 102 })
    expect(store.error).toBe(null)
    expect(store.currentHistoryId).toBe(null)

    await store.recordPlay(102)
    complete.mockRejectedValueOnce(new Error('Network'))
    await store.completeIfPending({ reason: 'natural', songId: 102 })
    expect(store.error).toBe('Network')
  })
})
