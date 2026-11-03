// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Undo of a ▶ Sing in the core queue: the dequeued entry goes back on top
// (one atomic front insert) and the deck reloads what it held before, behind
// the same play guard as any other load.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const queueList = vi.fn()
const queueAdd = vi.fn()
const queueRemove = vi.fn()
const songsMock = { currentSong: null, loadSong: vi.fn() }
const historyRecord = vi.fn()
const historyRemove = vi.fn()
const historyComplete = vi.fn()
const queueClear = vi.fn()

vi.mock('@/api/client', () => ({
  queueApi: {
    list: (...a) => queueList(...a),
    add: (...a) => queueAdd(...a),
    remove: (...a) => queueRemove(...a),
    reorder: vi.fn(async () => ({ data: { entries: [] } })),
    clear: (...a) => queueClear(...a),
  },
  historyApi: {
    record: (...a) => historyRecord(...a),
    remove: (...a) => historyRemove(...a),
    complete: (...a) => historyComplete(...a),
  },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
}))
vi.mock('@/plugins/slots', () => ({ getSlot: () => null }))
vi.mock('@/stores/songs', () => ({ useSongsStore: () => songsMock }))

import QueuePanel from '@/components/QueuePanel.vue'
import { useQueueStore } from '@/stores/queue'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'
import { useUndoStack } from '@/composables/useUndoStack'
import { useHistoryStore } from '@/stores/history'

let wrapper = null

function entry(id, singer, title, songId = 100 + id) {
  return { id, song_id: songId, singer_name: singer, position: id, title, artist: 'Bowie', duration: null, status: 'ready' }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useUndoStack('queue').clear()
  songsMock.currentSong = null
  songsMock.loadSong.mockImplementation(async (song) => {
    songsMock.currentSong = { id: song.id, title: `song ${song.id}`, artist: 'X' }
  })
  queueList.mockResolvedValue({ data: { entries: [] } })
  queueAdd.mockResolvedValue({ data: {} })
  queueRemove.mockResolvedValue({ data: {} })
  let nextHistoryId = 500
  historyRecord.mockImplementation(async () => ({ data: { id: nextHistoryId++ } }))
  historyRemove.mockResolvedValue({ data: { ok: true, deleted: true } })
  historyComplete.mockResolvedValue({ data: { ok: true } })
  queueClear.mockResolvedValue({ data: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  usePlayGuard().cancel()
  wrapper?.unmount()
  wrapper = null
})

async function mountWithEntries(entries) {
  queueList.mockResolvedValue({ data: { entries } })
  await useQueueStore().fetch()
  wrapper = mount(QueuePanel)
}

const undoBtn = () => wrapper.find('.queue-panel__undo')

async function sing(i = 0) {
  await wrapper.findAll('.queue-entry__btn--sing')[i].trigger('click')
  await flushPromises()
}

describe('QueuePanel undo', () => {
  it('is disabled until a Sing has dequeued something', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    expect(undoBtn().attributes('disabled')).toBeDefined()
    expect(undoBtn().attributes('aria-label')).toBe('Undo')

    await sing()
    expect(undoBtn().attributes('disabled')).toBeUndefined()
    expect(undoBtn().attributes('title')).toContain('Alice, Heroes')
  })

  it('sits left of the History button', async () => {
    await mountWithEntries([])
    const actions = wrapper.find('.queue-panel__header-actions').element.children
    expect(actions[0].classList.contains('queue-panel__undo')).toBe(true)
    expect(actions[1].classList.contains('queue-panel__history')).toBe(true)
  })

  it('records the previous deck song and restores both on undo', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 101 })

    const [top] = useUndoStack('queue').entries.value
    expect(top).toMatchObject({
      kind: 'queue.sing',
      entry: { song_id: 101, singer_name: 'Alice', title: 'Heroes', artist: 'Bowie' },
      previousSong: { id: 7, title: 'Jump', artist: 'Van Halen' },
    })
    expect(undoBtn().attributes('title')).toContain('reload Jump')

    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 7 })
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })

  it('goes several levels deep, newest first', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0) // deck: 101, prev none
    await sing(1) // deck: 102, prev 101
    expect(useUndoStack('queue').entries.value).toHaveLength(2)

    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenLastCalledWith(102, 'Bob', { front: true })
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 101 })

    songsMock.loadSong.mockClear()
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenLastCalledWith(101, 'Alice', { front: true })
    // Nothing was loaded before the first Sing: the deck is left alone.
    expect(songsMock.loadSong).not.toHaveBeenCalled()
    expect(undoBtn().attributes('disabled')).toBeDefined()
  })

  it('does not record an undo when the dequeue failed', async () => {
    queueRemove.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })

  it('asks before reloading over a playing song; cancel changes nothing', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    usePlayerStore().setPlayState('playing')
    const guard = usePlayGuard()

    await undoBtn().trigger('click')
    expect(guard.pending.value).toMatchObject({ kind: 'load', title: 'Jump' })
    expect(undoBtn().attributes('aria-busy')).toBe('true')
    guard.cancel()
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
    expect(useUndoStack('queue').canUndo.value).toBe(true)

    await undoBtn().trigger('click')
    guard.confirm()
    await flushPromises()
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 7 })
  })

  it('keeps the undo on a transient failure and drops it when the song is gone', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    songsMock.loadSong.mockClear()

    queueAdd.mockRejectedValueOnce(Object.assign(new Error('Network'), { status: undefined }))
    await undoBtn().trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(true)
    expect(songsMock.loadSong).not.toHaveBeenCalled()
    expect(wrapper.find('.queue-panel__error').text()).toContain('Network')

    queueAdd.mockRejectedValueOnce(Object.assign(new Error('song not found'), { status: 404 }))
    await undoBtn().trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(false)
    expect(songsMock.loadSong).not.toHaveBeenCalled()
  })

  it('persists the history to localStorage', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    const raw = JSON.parse(window.localStorage.getItem('singhouse.undo.queue'))
    expect(raw).toHaveLength(1)
    expect(raw[0].entry.song_id).toBe(101)
  })
})

describe('QueuePanel undo and play history', () => {
  it('records the Sing’s history row id in the undo entry', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    expect(useUndoStack('queue').peek()).toMatchObject({
      historyId: 500,
      previousPlay: { historyId: null, songId: null },
    })
  })

  it('deletes the undone Sing’s row only if incomplete (server-checked)', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    await undoBtn().trigger('click')
    await flushPromises()
    expect(historyRemove).toHaveBeenCalledWith(500, { ifIncomplete: true, songId: 101 })
  })

  it('a completed row is kept: the undo still finishes cleanly', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    // The song ended naturally before the host undid it.
    await useHistoryStore().completeIfPending({ reason: 'natural', songId: 101 })
    expect(historyComplete).toHaveBeenCalledWith(500)
    historyRemove.mockResolvedValue({ data: { ok: true, deleted: false } })

    await undoBtn().trigger('click')
    await flushPromises()
    // Only the guarded delete is ever sent, so the server keeps the row.
    expect(historyRemove).toHaveBeenCalledTimes(1)
    expect(historyRemove).toHaveBeenCalledWith(500, { ifIncomplete: true, songId: 101 })
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(useUndoStack('queue').canUndo.value).toBe(false)
    expect(wrapper.find('.queue-panel__error').exists()).toBe(false)
  })

  it('rewinds the pending pointer so a later ended cannot complete the undone row', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0) // row 500 pending for song 101
    await sing(1) // row 501 pending for song 102, previous pending 500/101
    const history = useHistoryStore()
    expect(history.currentHistoryId).toBe(501)

    await undoBtn().trigger('click')
    await flushPromises()
    expect(historyRemove).toHaveBeenLastCalledWith(501, { ifIncomplete: true, songId: 102 })
    expect(history.currentHistoryId).toBe(500)
    expect(history.currentPlaySongId).toBe(101)

    await history.completeIfPending({ reason: 'natural', songId: 102 })
    expect(historyComplete).not.toHaveBeenCalled()
    await history.completeIfPending({ reason: 'natural', songId: 101 })
    expect(historyComplete).toHaveBeenCalledWith(500)
  })

  it('skips the history step silently when the record had failed', async () => {
    historyRecord.mockRejectedValue(new Error('history down'))
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing()
    expect(useUndoStack('queue').peek()).toMatchObject({ historyId: null })

    await undoBtn().trigger('click')
    await flushPromises()
    expect(historyRemove).not.toHaveBeenCalled()
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 7 })
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })
})

function deferred() {
  let resolve
  let reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

const stackNames = () => useUndoStack('queue').entries.value.map((e) => e.entry?.singer_name)
const singBtns = () => wrapper.findAll('.queue-entry__btn--sing')

// A record another tab of the host view pushed, delivered by the storage event.
function foreignRecord(over = {}) {
  return {
    kind: 'queue.sing',
    entry: { song_id: 103, singer_name: 'Cara', title: 'Fame', artist: 'Bowie' },
    previousSong: { id: 7, title: 'Jump', artist: 'Van Halen' },
    historyId: 900,
    previousPlay: { historyId: 899, songId: 7 },
    id: 'foreign-1',
    at: Date.now(),
    tab: 'some-other-tab',
    ...over,
  }
}

function deliverFromOtherTab(list) {
  const raw = JSON.stringify(list)
  window.localStorage.setItem('singhouse.undo.queue', raw)
  window.dispatchEvent(new StorageEvent('storage', { key: 'singhouse.undo.queue', newValue: raw }))
}

describe('QueuePanel undo: record identity', () => {
  it('removes the undone record by id even when another push lands mid-undo', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    const d = deferred()
    queueAdd.mockImplementationOnce(() => d.p)
    await undoBtn().trigger('click') // undo of Alice in flight
    await flushPromises()

    // Another tab pushes its own Sing while the POST is pending.
    deliverFromOtherTab([...useUndoStack('queue').entries.value, foreignRecord()])
    expect(stackNames()).toEqual(['Alice', 'Cara'])

    d.resolve({ data: {} })
    await flushPromises()
    expect(stackNames()).toEqual(['Cara'])
    expect(queueAdd).toHaveBeenCalledTimes(1)
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
  })

  it('removes by id on the drop path too', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    const d = deferred()
    queueAdd.mockImplementationOnce(() => d.p)
    await undoBtn().trigger('click')
    await flushPromises()
    deliverFromOtherTab([...useUndoStack('queue').entries.value, foreignRecord()])
    d.reject(Object.assign(new Error('song not found'), { status: 404 }))
    await flushPromises()
    expect(stackNames()).toEqual(['Cara'])
  })

  it('does nothing when the record was undone elsewhere before the confirmation', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    usePlayerStore().setPlayState('playing')
    const guard = usePlayGuard()
    await undoBtn().trigger('click')
    expect(guard.pending.value).not.toBe(null)
    deliverFromOtherTab([]) // the other tab undid it
    guard.confirm()
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
    expect(historyRemove).not.toHaveBeenCalled()
    expect(wrapper.find('.queue-panel__error').text()).toContain('changed in another tab')
  })
})

describe('QueuePanel undo: storage is the source of truth under the lock', () => {
  it('does not re-undo a record another tab removed before its storage event arrived', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request: async (n, cb) => cb() } })
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    // The other tab already undid it; its storage event is still in flight.
    window.localStorage.removeItem('singhouse.undo.queue')
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
    expect(historyRemove).not.toHaveBeenCalled()
    expect(wrapper.find('.queue-panel__error').text()).toContain('changed in another tab')
    expect(useUndoStack('queue').entries.value).toEqual([])
  })

  it('also checks storage without the Web Locks API', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: undefined })
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    window.localStorage.removeItem('singhouse.undo.queue')
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it('a Sing push keeps a record another tab wrote that has not reached this tab yet', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    window.localStorage.setItem('singhouse.undo.queue', JSON.stringify([foreignRecord()]))
    await sing(0)
    expect(stackNames()).toEqual(['Cara', 'Alice'])
  })
})

describe('QueuePanel undo: one action at a time', () => {
  it('disables Undo while a Sing is in flight, and undoes that Sing afterwards', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0) // stack [Alice]
    const d = deferred()
    queueRemove.mockImplementationOnce(() => d.p)
    await singBtns()[1].trigger('click') // Bob's dequeue in flight
    await flushPromises()

    expect(undoBtn().attributes('disabled')).toBeDefined()
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()

    d.resolve({ data: {} })
    await flushPromises()
    expect(undoBtn().attributes('disabled')).toBeUndefined()
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenCalledWith(102, 'Bob', { front: true })
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 101 })
    expect(stackNames()).toEqual(['Alice'])
  })

  it('disables every Sing button while an Undo is in flight', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0)
    const d = deferred()
    queueAdd.mockImplementationOnce(() => d.p)
    await undoBtn().trigger('click')
    await flushPromises()

    expect(singBtns().every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    await singBtns()[0].trigger('click')
    await flushPromises()
    expect(queueRemove).toHaveBeenCalledTimes(1) // only the first Sing

    d.resolve({ data: {} })
    await flushPromises()
    expect(singBtns().every((b) => b.attributes('disabled') === undefined)).toBe(true)
  })

  it('a Sing confirmed while an Undo is in flight does nothing', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0) // nothing on the deck before: its undo needs no confirmation
    usePlayerStore().setPlayState('playing')
    const guard = usePlayGuard()
    await singBtns()[1].trigger('click') // Bob: confirmation open
    expect(guard.pending.value).toMatchObject({ title: 'Changes' })

    const d = deferred()
    queueAdd.mockImplementationOnce(() => d.p)
    await undoBtn().trigger('click') // Alice's undo in flight, no confirmation
    await flushPromises()
    guard.confirm() // the host now confirms Bob's Sing
    await flushPromises()
    expect(queueRemove).toHaveBeenCalledTimes(1)
    expect(historyRecord).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.queue-panel__error').text()).toContain('an undo was in progress')

    d.resolve({ data: {} })
    await flushPromises()
    expect(useUndoStack('queue').entries.value).toEqual([])
  })

  it('a double click on Sing records one play and one undo', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    const btn = singBtns()[0]
    btn.trigger('click')
    btn.trigger('click')
    await flushPromises()
    expect(historyRecord).toHaveBeenCalledTimes(1)
    expect(queueRemove).toHaveBeenCalledTimes(1)
    expect(useUndoStack('queue').entries.value).toHaveLength(1)
  })

  it('keeps the play row when the dequeue fails transiently: the song is on the deck', async () => {
    queueRemove.mockRejectedValue(Object.assign(new Error('Network Error'), { status: undefined }))
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    expect(songsMock.loadSong).toHaveBeenCalledWith({ id: 101 })
    expect(historyRemove).not.toHaveBeenCalled()
    expect(useHistoryStore().currentHistoryId).toBe(500)
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })

  it('takes back the play row when the entry was already dequeued (404)', async () => {
    queueRemove.mockRejectedValue(Object.assign(new Error('queue entry not found'), { status: 404 }))
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    expect(historyRecord).toHaveBeenCalledTimes(1)
    expect(historyRemove).toHaveBeenCalledWith(500, { ifIncomplete: true, songId: 101 })
    expect(useHistoryStore().currentHistoryId).toBe(null)
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })
})

describe('QueuePanel undo: deck snapshot', () => {
  it('a quick Sing-Sing records the song the first Sing asked for, not a stale one', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    const loads = []
    songsMock.loadSong.mockImplementation((song) => {
      const d = deferred()
      loads.push(d)
      return d.p.then(() => {
        songsMock.currentSong = { id: song.id, title: `song ${song.id}`, artist: 'X' }
      })
    })
    await sing(0) // loadSong(101) still pending
    await sing(1)
    loads.forEach((d) => d.resolve())
    await flushPromises()

    const recs = useUndoStack('queue').entries.value
    expect(recs.map((r) => [r.entry.singer_name, r.previousSong?.id])).toEqual([
      ['Alice', 7],
      ['Bob', 101],
    ])
    expect(recs[1].previousSong).toEqual({ id: 101, title: 'Heroes', artist: 'Bowie' })
  })

  it('after the load settles, a library load in between is what gets recorded', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0)
    songsMock.currentSong = { id: 55, title: 'Library pick', artist: 'Y' }
    await sing(1)
    expect(useUndoStack('queue').peek().previousSong).toMatchObject({ id: 55 })
  })

  it('skips the reload and its confirmation when the previous song is already on the deck', async () => {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    // The host put Jump back on the deck by hand.
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    usePlayerStore().setPlayState('playing')
    songsMock.loadSong.mockClear()

    await undoBtn().trigger('click')
    await flushPromises()
    expect(usePlayGuard().pending.value).toBe(null)
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(songsMock.loadSong).not.toHaveBeenCalled()
  })
})

describe('QueuePanel undo: previous song left the library', () => {
  afterEach(() => {
    delete songsMock.songs
    delete songsMock.searchQuery
  })

  async function singOverJump() {
    songsMock.currentSong = { id: 7, title: 'Jump', artist: 'Van Halen' }
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    usePlayerStore().setPlayState('playing')
    songsMock.loadSong.mockClear()
  }

  it('skips the reload (and its confirmation) when the full library no longer has it', async () => {
    await singOverJump()
    songsMock.songs = [{ id: 101 }, { id: 300 }]
    songsMock.searchQuery = ''
    await undoBtn().trigger('click')
    await flushPromises()
    expect(usePlayGuard().pending.value).toBe(null)
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(songsMock.loadSong).not.toHaveBeenCalled()
  })

  it('reloads when the library has it', async () => {
    await singOverJump()
    songsMock.songs = [{ id: 7 }, { id: 101 }]
    await undoBtn().trigger('click')
    usePlayGuard().confirm()
    await flushPromises()
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 7 })
  })

  it.each([
    ['not loaded', [], ''],
    ['narrowed by a search', [{ id: 101 }], 'bowie'],
  ])('reloads as before when the list is %s', async (_, list, query) => {
    await singOverJump()
    songsMock.songs = list
    songsMock.searchQuery = query
    await undoBtn().trigger('click')
    usePlayGuard().confirm()
    await flushPromises()
    expect(songsMock.loadSong).toHaveBeenLastCalledWith({ id: 7 })
  })
})

describe('QueuePanel undo: expiry and clearing', () => {
  it('clearing the queue clears its undo history', async () => {
    window.confirm = vi.fn(() => true)
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0)
    await wrapper.find('.queue-panel__clear').trigger('click')
    await flushPromises()
    expect(queueClear).toHaveBeenCalled()
    expect(useUndoStack('queue').canUndo.value).toBe(false)
    delete window.confirm
  })

  it('a failed or cancelled clear keeps the undo history', async () => {
    const confirm = vi.fn(() => false)
    window.confirm = confirm
    await mountWithEntries([entry(1, 'Alice', 'Heroes'), entry(2, 'Bob', 'Changes')])
    await sing(0)
    await wrapper.find('.queue-panel__clear').trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(true)

    confirm.mockReturnValue(true)
    queueClear.mockRejectedValueOnce(new Error('Network'))
    await wrapper.find('.queue-panel__clear').trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(true)
    delete window.confirm
  })

  it('an expired record is not undone', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 12 * 60 * 60 * 1000 + 1)
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
    expect(useUndoStack('queue').entries.value).toEqual([])
    spy.mockRestore()
  })
})

describe('QueuePanel undo: other tabs', () => {
  it('a record from another tab restores the queue and the row but leaves this deck and pointer alone', async () => {
    songsMock.currentSong = { id: 55, title: 'Here', artist: 'Y' }
    await mountWithEntries([])
    const history = useHistoryStore()
    history.currentHistoryId = 900 // coincidence or not, this tab's pointer stays
    history.currentPlaySongId = 103
    usePlayerStore().setPlayState('playing')
    deliverFromOtherTab([foreignRecord()])
    await flushPromises()
    expect(undoBtn().attributes('title')).not.toContain('reload')

    await undoBtn().trigger('click')
    await flushPromises()
    expect(usePlayGuard().pending.value).toBe(null) // no deck change, nothing to confirm
    expect(queueAdd).toHaveBeenCalledWith(103, 'Cara', { front: true })
    expect(historyRemove).toHaveBeenCalledWith(900, { ifIncomplete: true, songId: 103 })
    expect(songsMock.loadSong).not.toHaveBeenCalled()
    expect(history.currentHistoryId).toBe(900)
    expect(history.currentPlaySongId).toBe(103)
    expect(useUndoStack('queue').canUndo.value).toBe(false)
  })

  it('holds the cross-tab lock around the undo when Web Locks exist', async () => {
    const order = []
    const request = vi.fn(async (name, cb) => {
      order.push(`lock:${name}`)
      const r = await cb()
      order.push('unlock')
      return r
    })
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
    queueAdd.mockImplementation(async () => { order.push('post'); return { data: {} } })
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    await undoBtn().trigger('click')
    await flushPromises()
    expect(order).toEqual(['lock:singhouse.undo.queue', 'post', 'unlock'])
  })
})

describe('QueuePanel undo: malformed records', () => {
  it('skips (and keeps) a record of another kind; the Sing below it is undoable', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    useUndoStack('queue').push({ kind: 'something.else', foo: 1 })
    await flushPromises()
    expect(useUndoStack('queue').entries.value.map((r) => r.kind)).toEqual(['queue.sing', 'something.else'])
    expect(undoBtn().attributes('disabled')).toBeUndefined()
    expect(undoBtn().attributes('title')).toContain('Alice, Heroes')

    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenCalledWith(101, 'Alice', { front: true })
    expect(useUndoStack('queue').entries.value.map((r) => r.kind)).toEqual(['something.else'])
    expect(undoBtn().attributes('disabled')).toBeDefined()
  })

  it.each([
    ['a string historyId', { historyId: '1 OR 1' }],
    ['a fractional historyId', { historyId: 1.5 }],
    ['a non-object previousPlay', { previousPlay: 'x' }],
    ['a bad previousPlay.historyId', { previousPlay: { historyId: 'x', songId: 7 } }],
    ['a bad previousPlay.songId', { previousPlay: { historyId: 1, songId: '7' } }],
    ['a previousSong without an integer id', { previousSong: { id: 'x', title: 'J' } }],
  ])('drops a Sing record with %s without sending anything', async (_, over) => {
    await mountWithEntries([])
    deliverFromOtherTab([foreignRecord(over)])
    await flushPromises()
    expect(useUndoStack('queue').entries.value).toEqual([])
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).not.toHaveBeenCalled()
    expect(historyRemove).not.toHaveBeenCalled()
  })

  it('accepts null historyId and previousPlay', async () => {
    await mountWithEntries([])
    deliverFromOtherTab([foreignRecord({ historyId: null, previousPlay: null, previousSong: null })])
    await flushPromises()
    await undoBtn().trigger('click')
    await flushPromises()
    expect(queueAdd).toHaveBeenCalledWith(103, 'Cara', { front: true })
    expect(historyRemove).not.toHaveBeenCalled()
  })

  it.each([
    ['no entry', { entry: undefined }],
    ['a non-integer song id', { entry: { song_id: '101', title: 'X' } }],
    ['a fractional song id', { entry: { song_id: 1.5, title: 'X' } }],
  ])('never POSTs a record with %s', async (_, over) => {
    await mountWithEntries([])
    deliverFromOtherTab([foreignRecord(over)])
    await flushPromises()
    expect(undoBtn().attributes('disabled')).toBeDefined()
    expect(undoBtn().attributes('title')).toBe('Nothing to undo')
    expect(queueAdd).not.toHaveBeenCalled()
    expect(useUndoStack('queue').entries.value).toEqual([])
  })

  it.each([[400], [404], [409], [422]])('drops the record on a %i', async (status) => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    queueAdd.mockRejectedValueOnce(Object.assign(new Error('no'), { status }))
    await undoBtn().trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(false)
    expect(historyRemove).not.toHaveBeenCalled()
  })

  it.each([[401], [408], [429], [500], [503]])('keeps the record for a retry on a %i', async (status) => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])
    await sing(0)
    queueAdd.mockRejectedValueOnce(Object.assign(new Error('later'), { status }))
    await undoBtn().trigger('click')
    await flushPromises()
    expect(useUndoStack('queue').canUndo.value).toBe(true)
  })
})
