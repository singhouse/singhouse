// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The play-recording wiring: clicking ▶ Sing in the core QueuePanel must
// record a play from the entry's snapshot — its song_id and its singer name —
// AND still load + dequeue. The recording is fire-and-forget: it rides
// alongside the existing load/dequeue, never gates them. (The completeIfPending
// half of the flow is exercised directly in tests/stores/history.test.js.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const queueList = vi.fn()
const queueRemove = vi.fn()
const historyRecord = vi.fn()
const loadSong = vi.fn()

vi.mock('@/api/client', () => ({
  queueApi: {
    list: (...a) => queueList(...a),
    add: vi.fn(async () => ({ data: {} })),
    remove: (...a) => queueRemove(...a),
    reorder: vi.fn(async () => ({ data: { entries: [] } })),
    clear: vi.fn(async () => ({ data: {} })),
  },
  historyApi: {
    record: (...a) => historyRecord(...a),
    complete: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
  },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
}))
vi.mock('@/plugins/slots', () => ({
  getSlot: () => null, // core build: no queue-provider slot
}))
vi.mock('@/stores/songs', () => ({
  useSongsStore: () => ({ loadSong: (...a) => loadSong(...a) }),
}))

import QueuePanel from '@/components/QueuePanel.vue'
import { useQueueStore } from '@/stores/queue'

let wrapper = null

function entry(id, singer, title) {
  return {
    id,
    song_id: 100 + id,
    singer_name: singer,
    position: 0,
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
  queueRemove.mockResolvedValue({ data: {} })
  historyRecord.mockResolvedValue({ data: { id: 1 } })
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

describe('QueuePanel Sing → recordPlay', () => {
  it('records the play with the entry song_id and singer name, and still loads + dequeues', async () => {
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])

    await wrapper.find('.queue-entry__btn--sing').trigger('click')

    expect(historyRecord).toHaveBeenCalledWith(101, 'Alice')
    // The existing contract is untouched: load then dequeue.
    expect(loadSong).toHaveBeenCalledWith({ id: 101 })
    expect(queueRemove).toHaveBeenCalledWith(1)
  })

  it('records a null singer for an anonymous entry', async () => {
    await mountWithEntries([entry(2, null, 'Life on Mars')])

    await wrapper.find('.queue-entry__btn--sing').trigger('click')

    expect(historyRecord).toHaveBeenCalledWith(102, null)
  })

  it('a failing history write does not break the sing (load + dequeue still run)', async () => {
    historyRecord.mockRejectedValue(new Error('history offline'))
    await mountWithEntries([entry(1, 'Alice', 'Heroes')])

    await wrapper.find('.queue-entry__btn--sing').trigger('click')
    await new Promise(r => setTimeout(r)) // let the rejected record settle

    expect(loadSong).toHaveBeenCalledWith({ id: 101 })
    expect(queueRemove).toHaveBeenCalledWith(1)
  })
})

describe('play history dialog', () => {
  it('opens as a named dialog on its search field; Escape closes it and returns to History', async () => {
    wrapper = mount(QueuePanel, { attachTo: document.body })
    const opener = wrapper.find('.queue-panel__history').element
    opener.focus()
    opener.click()
    await flushPromises()

    const dialog = document.querySelector('dialog.modal-overlay')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Play history')
    expect(document.activeElement.classList.contains('history-modal__search')).toBe(true)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('dialog.modal-overlay')).toBeNull()
    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })
})
