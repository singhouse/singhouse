// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// BasicManualQueue panel: entries render in order with the top row
// marked, Sing = load-then-dequeue, freehand picks are rejected (the queue
// FKs the library), and the rendered copy never says the banned acquisition verb.
// It also owns its own poll lifecycle — the host shell stopped routing that
// when the queue area became a slot, so a dropped start/stop here is a panel
// that never updates (or a timer that outlives the show).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const queueList = vi.fn()
const queueAdd = vi.fn()
const queueRemove = vi.fn()
const loadSong = vi.fn()

vi.mock('@/api/client', () => ({
  queueApi: {
    list: (...a) => queueList(...a),
    add: (...a) => queueAdd(...a),
    remove: (...a) => queueRemove(...a),
    reorder: vi.fn(async () => ({ data: { entries: [] } })),
    clear: vi.fn(async () => ({ data: {} })),
  },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
}))
vi.mock('@/plugins/slots', () => ({
  getSlot: () => null, // core build: no catalog slot
}))
vi.mock('@/stores/songs', () => ({
  useSongsStore: () => ({ loadSong: (...a) => loadSong(...a) }),
}))

import QueuePanel from '@/components/QueuePanel.vue'
import { useQueueStore } from '@/stores/queue'

let wrapper = null

function entry(id, position, singer, title) {
  return {
    id,
    song_id: 100 + id,
    singer_name: singer,
    position,
    title,
    artist: 'Bowie',
    duration: null,
    status: 'ready',
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  queueList.mockResolvedValue({ data: { entries: [] } })
  queueAdd.mockResolvedValue({ data: {} })
  queueRemove.mockResolvedValue({ data: {} })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function mountWithEntries(entries) {
  queueList.mockResolvedValue({ data: { entries } })
  const store = useQueueStore()
  await store.fetch()
  wrapper = mount(QueuePanel)
  return store
}

describe('QueuePanel', () => {
  it('renders entries in order and marks the first as up next', async () => {
    await mountWithEntries([
      entry(1, 0, 'Alice', 'Heroes'),
      entry(2, 1, null, 'Life on Mars'),
    ])

    const rows = wrapper.findAll('.queue-entry')
    expect(rows).toHaveLength(2)
    expect(rows[0].classes()).toContain('queue-entry--next')
    expect(rows[0].text()).toContain('Alice')
    expect(rows[0].text()).toContain('Heroes')
    expect(rows[1].classes()).not.toContain('queue-entry--next')
    expect(rows[1].text()).toContain('—') // no singer
  })

  it('Sing loads the song and dequeues the entry', async () => {
    await mountWithEntries([entry(1, 0, 'Alice', 'Heroes')])

    await wrapper.find('.queue-entry__btn--sing').trigger('click')

    expect(loadSong).toHaveBeenCalledWith({ id: 101 })
    expect(queueRemove).toHaveBeenCalledWith(1)
  })

  it('rejects a freehand pick with a hint and no API call', async () => {
    await mountWithEntries([])

    // SongPicker emits pick(text, null) for freehand text.
    wrapper.findComponent({ name: 'SongPicker' }).vm.$emit('pick', 'Some Song', null)
    await wrapper.vm.$nextTick()

    expect(queueAdd).not.toHaveBeenCalled()
    expect(wrapper.find('.queue-panel__hint').text()).toContain('your library')
  })

  it('adds a library pick with the typed singer name, then clears it', async () => {
    await mountWithEntries([])

    await wrapper.find('.queue-panel__singer').setValue('  Alice  ')
    wrapper.findComponent({ name: 'SongPicker' }).vm.$emit('pick', 'Bowie — Heroes', 42)
    await new Promise(r => setTimeout(r)) // let the async add settle

    expect(queueAdd).toHaveBeenCalledWith(42, 'Alice')
    expect(wrapper.find('.queue-panel__singer').element.value).toBe('')
  })

  it('shows the empty state only after the first fetch', async () => {
    const store = useQueueStore()
    wrapper = mount(QueuePanel)
    expect(wrapper.find('.queue-panel__empty').exists()).toBe(false)

    await store.fetch()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.queue-panel__empty').text()).toContain('your library')
  })

  it('never renders the banned acquisition verb', async () => {
    await mountWithEntries([entry(1, 0, 'Alice', 'Heroes')])
    expect(wrapper.text()).not.toMatch(/download/i)
  })

  it('starts polling on mount and stops on unmount', async () => {
    const store = useQueueStore()
    const start = vi.spyOn(store, 'startPolling').mockImplementation(() => {})
    const stop = vi.spyOn(store, 'stopPolling').mockImplementation(() => {})

    wrapper = mount(QueuePanel)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()

    wrapper.unmount()
    wrapper = null
    // Paired, because the store ref-counts: one unmatched start leaves a 5s
    // timer running against a panel nobody is looking at.
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

// Core play history moved here from the retired sidebar footer. This
// panel only mounts when no queue provider is registered, so the button needs
// no gate of its own; the modal mounts lazily so the list fetches on open.
describe('play history entry point', () => {
  it('opens the history modal from the header', async () => {
    wrapper = mount(QueuePanel, {
      global: { stubs: { HistoryModal: { template: '<div class="history-stub" />' }, teleport: true } },
    })
    const btn = wrapper.find('.queue-panel__history')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('Play history')
    expect(wrapper.find('.history-stub').exists()).toBe(false)

    await btn.trigger('click')
    expect(wrapper.find('.history-stub').exists()).toBe(true)
  })
})
