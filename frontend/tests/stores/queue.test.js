// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// BasicManualQueue store: the manual-order contract as the UI sees it —
// write-then-refetch actions, reorder consuming the endpoint's response, the
// 409 stale-client recovery, and the ref-counted shared poll timer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const list = vi.fn()
const add = vi.fn()
const remove = vi.fn()
const reorder = vi.fn()
const clear = vi.fn()

vi.mock('@/api/client', () => ({
  queueApi: {
    list: (...a) => list(...a),
    add: (...a) => add(...a),
    remove: (...a) => remove(...a),
    reorder: (...a) => reorder(...a),
    clear: (...a) => clear(...a),
  },
}))

import { useQueueStore } from '@/stores/queue'

function entry(id, position, singer = null) {
  return {
    id,
    song_id: 100 + id,
    singer_name: singer,
    position,
    title: `Song ${id}`,
    artist: 'A',
    duration: null,
    status: 'ready',
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  list.mockResolvedValue({ data: { entries: [] } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetch', () => {
  it('populates entries and flips fetchedOnce', async () => {
    const store = useQueueStore()
    list.mockResolvedValue({ data: { entries: [entry(1, 0, 'Alice'), entry(2, 1)] } })

    expect(store.fetchedOnce).toBe(false)
    await store.fetch()

    expect(store.entries).toHaveLength(2)
    expect(store.upNext.id).toBe(1)
    expect(store.count).toBe(2)
    expect(store.fetchedOnce).toBe(true)
  })

  it('keeps last-known entries and sets error on failure', async () => {
    const store = useQueueStore()
    list.mockResolvedValueOnce({ data: { entries: [entry(1, 0)] } })
    await store.fetch()

    list.mockRejectedValueOnce(new Error('network down'))
    await store.fetch()

    expect(store.entries).toHaveLength(1)
    expect(store.error).toBe('network down')
  })
})

describe('mutations', () => {
  it('add posts then refetches', async () => {
    const store = useQueueStore()
    add.mockResolvedValue({ data: {} })

    await store.add(42, 'Alice')

    expect(add).toHaveBeenCalledWith(42, 'Alice')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('remove deletes then refetches', async () => {
    const store = useQueueStore()
    remove.mockResolvedValue({ data: {} })

    await store.remove(7)

    expect(remove).toHaveBeenCalledWith(7)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('surfaces an add failure on error instead of throwing', async () => {
    const store = useQueueStore()
    add.mockRejectedValue(new Error('song not found'))

    const ok = await store.add(42, 'Alice')

    expect(ok).toBe(false)
    expect(store.error).toBe('song not found')
    expect(list).not.toHaveBeenCalled()
  })

  it('clear empties then refetches', async () => {
    const store = useQueueStore()
    clear.mockResolvedValue({ data: {} })

    await store.clear()

    expect(clear).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
  })
})

describe('reorder', () => {
  it('consumes the response list without an extra fetch', async () => {
    const store = useQueueStore()
    reorder.mockResolvedValue({ data: { entries: [entry(2, 0), entry(1, 1)] } })

    await store.reorder([2, 1])

    expect(reorder).toHaveBeenCalledWith([2, 1])
    expect(store.entries.map(e => e.id)).toEqual([2, 1])
    expect(list).not.toHaveBeenCalled()
  })

  it('recovers from a 409 by refetching and surfacing a soft error', async () => {
    const store = useQueueStore()
    // The interceptor's real contract: a plain Error with `.status` bolted
    // on — NOT an axios error with `.response` (api/client.js rewraps).
    const conflict = new Error('queue changed — refresh and retry')
    conflict.status = 409
    reorder.mockRejectedValue(conflict)
    list.mockResolvedValue({ data: { entries: [entry(3, 0)] } })

    await store.reorder([1, 2])

    expect(store.error).toBe('Queue changed — try again')
    expect(store.entries.map(e => e.id)).toEqual([3])
  })

  it('moveUp / moveDown send the swapped permutation', async () => {
    const store = useQueueStore()
    list.mockResolvedValue({ data: { entries: [entry(1, 0), entry(2, 1), entry(3, 2)] } })
    await store.fetch()
    reorder.mockResolvedValue({ data: { entries: [] } })

    await store.moveUp(2)
    expect(reorder).toHaveBeenLastCalledWith([2, 1, 3])

    // Store consumed the (empty) response; refetch to reset for the next move.
    list.mockResolvedValue({ data: { entries: [entry(1, 0), entry(2, 1), entry(3, 2)] } })
    await store.fetch()
    await store.moveDown(2)
    expect(reorder).toHaveBeenLastCalledWith([1, 3, 2])
  })

  it('moveUp on first and moveDown on last are no-ops', async () => {
    const store = useQueueStore()
    list.mockResolvedValue({ data: { entries: [entry(1, 0), entry(2, 1)] } })
    await store.fetch()

    await store.moveUp(1)
    await store.moveDown(2)
    await store.moveUp(999) // unknown id — also a no-op

    expect(reorder).not.toHaveBeenCalled()
  })
})

describe('polling', () => {
  it('is ref-counted: one timer shared, cleared only at zero', async () => {
    vi.useFakeTimers()
    const store = useQueueStore()

    store.startPolling() // fetch #1 (immediate)
    store.startPolling() // no second timer, no second immediate fetch
    expect(list).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(2)

    store.stopPolling() // one consumer left — timer stays
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(3)

    store.stopPolling() // zero consumers — timer cleared
    await vi.advanceTimersByTimeAsync(15000)
    expect(list).toHaveBeenCalledTimes(3)
  })
})
