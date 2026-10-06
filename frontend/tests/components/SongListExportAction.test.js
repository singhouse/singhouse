// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Gate contract for the library's per-row export action (an item in the
// row's ⋯ menu): the item exists
// only when the server reports the cdg_export capability AND the song is
// ready, it opens the export dialog for that song, and nothing the row or
// dialog renders uses the banned verb. Feature flags are a UI hint — the
// server enforces the route either way — so the OFF default must hide the
// affordance rather than render one that can only fail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()
const getFeatures = vi.fn()
const getSettings = vi.fn()
const setSettings = vi.fn()
const exportSong = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
  featuresApi: { get: (...a) => getFeatures(...a) },
  exportApi: {
    getSettings: (...a) => getSettings(...a),
    setSettings: (...a) => setSettings(...a),
    exportSong: (...a) => exportSong(...a),
  },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

const LIBRARY = [
  { id: 1, title: 'Ready Song', artist: 'A', duration: 200, status: 'ready', created_at: '2026-08-03T00:00:00' },
  { id: 2, title: 'Busy Song', artist: 'B', duration: 100, status: 'processing', created_at: '2026-08-02T00:00:00' },
]

let wrapper = null

async function mountList() {
  const w = mount(SongList, { attachTo: document.body })
  const store = useSongsStore()
  store.songs = [...LIBRARY]
  store.loading = false
  await flushPromises()
  return w
}

// The row ⋯ menu teleports to <body>; find its panel through the trigger.
async function rowMenu(title) {
  const row = wrapper.findAll('.song-item').find(r => r.text().includes(title))
  const btn = row.find('.more-btn')
  await btn.trigger('click')
  await flushPromises()
  return document.getElementById(btn.attributes('aria-controls'))
}

async function closeMenus() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
}

async function exportItem(title = 'Ready Song') {
  return (await rowMenu(title)).querySelector('.row-menu__export')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  getFeatures.mockReset()
  getFeatures.mockResolvedValue({ data: { cdg_export: true } })
  getSettings.mockReset()
  getSettings.mockResolvedValue({ data: { attribution_card: true } })
  setSettings.mockReset()
  exportSong.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('export action gating', () => {
  it('hides the export item when the capability is off', async () => {
    getFeatures.mockResolvedValue({ data: { cdg_export: false } })
    wrapper = await mountList()
    expect(await exportItem()).toBeNull()
  })

  it('hides the export item when the flags never load', async () => {
    getFeatures.mockRejectedValue(new Error('unreachable'))
    wrapper = await mountList()
    expect(await exportItem()).toBeNull()
  })

  it('offers export only on ready songs when the capability is on', async () => {
    wrapper = await mountList()
    expect(await exportItem('Ready Song')).not.toBeNull()
    await closeMenus()
    expect(await exportItem('Busy Song')).toBeNull()
  })

  it('opens the export dialog for the chosen song', async () => {
    wrapper = await mountList()
    ;(await exportItem()).click()
    await flushPromises()

    const card = document.body.querySelector('.modal-card')
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Export CD+G')
    expect(card.textContent).toContain('Ready Song')
    expect(getSettings).toHaveBeenCalled()
  })
})

describe('vocabulary', () => {
  it('renders no banned verb anywhere in the list or the open dialog', async () => {
    wrapper = await mountList()
    ;(await exportItem()).click()
    await flushPromises()

    expect(wrapper.html()).not.toMatch(/download/i)
    expect(document.body.innerHTML).not.toMatch(/download/i)
  })
})
