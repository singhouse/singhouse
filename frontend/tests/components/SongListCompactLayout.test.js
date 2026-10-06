// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library list fits its panel instead of scrolling sideways: one
// always-visible ⋯ menu per row (Song tools, Export, Delete), a compact
// two-line row when the panel is narrower than the chosen columns need, and
// draggable column widths that persist alongside the column choice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()
const deleteSong = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    list: (...a) => listSongs(...a),
    delete: (...a) => deleteSong(...a),
  },
  featuresApi: { get: vi.fn(async () => ({ data: { cdg_export: true } })) },
  exportApi: { getSettings: vi.fn(async () => ({ data: {} })), setSettings: vi.fn(), exportSong: vi.fn() },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

const LIBRARY = [
  { id: 1, title: 'Paper Lantern', artist: 'The Test Pattern', duration: 222, status: 'ready', created_at: '2026-08-03T00:00:00' },
  { id: 2, title: 'Busy Sample', artist: 'Placeholder Band', status: 'processing', phase: 'separating', progress: 42, created_at: '2026-08-02T00:00:00' },
  { id: 3, title: 'Broken Sample', artist: '', status: 'failed', created_at: '2026-08-01T00:00:00' },
]

// A controllable ResizeObserver: tests report the list's width by hand.
let observers = []
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; observers.push(this) }
  observe(el) { this.el = el }
  disconnect() {}
}

let wrapper = null

async function mountList(songs = LIBRARY) {
  const w = mount(SongList, { attachTo: document.body })
  const store = useSongsStore()
  store.songs = [...songs]
  store.loading = false
  await flushPromises()
  return w
}

async function setListWidth(width) {
  for (const o of observers) o.cb([{ contentRect: { width }, target: o.el }])
  await flushPromises()
}

function row(title) {
  return wrapper.findAll('.song-item').find(r => r.text().includes(title))
}

async function openRowMenu(title) {
  const btn = row(title).find('.more-btn')
  await btn.trigger('click')
  await flushPromises()
  return document.getElementById(btn.attributes('aria-controls'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  deleteSong.mockResolvedValue({ data: {} })
  observers = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('row actions menu', () => {
  it('gives each row exactly one always-present button: the ⋯ menu trigger', async () => {
    wrapper = await mountList()
    for (const song of LIBRARY) {
      const buttons = row(song.title).findAll('button')
      expect(buttons).toHaveLength(1)
      expect(buttons[0].classes()).toContain('more-btn')
      expect(buttons[0].attributes('aria-label')).toBe(`Actions for ${song.title}`)
      expect(buttons[0].attributes('aria-haspopup')).toBe('menu')
    }
    expect(wrapper.find('.action-btn').exists()).toBe(false)
  })

  it('holds Song tools, Export and Delete, with Delete last and marked destructive', async () => {
    wrapper = await mountList()
    const panel = await openRowMenu('Paper Lantern')
    expect(panel.getAttribute('role')).toBe('menu')
    const items = [...panel.querySelectorAll('[role="menuitem"]')]
    expect(items.map(i => i.textContent.trim())).toEqual(['Song tools…', 'Export CD+G…', 'Delete song…'])
    expect(items[2].classList.contains('ui-menu__item--danger')).toBe(true)
  })

  it('opens the existing delete confirmation from the menu', async () => {
    wrapper = await mountList()
    const store = useSongsStore()
    const del = vi.spyOn(store, 'deleteSong').mockResolvedValue()
    const panel = await openRowMenu('Paper Lantern')
    panel.querySelector('.row-menu__delete').click()
    await flushPromises()

    const card = document.body.querySelector('.modal-card')
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Delete Song?')
    expect(card.textContent).toContain('Paper Lantern will be permanently removed including all stems.')
    expect(del).not.toHaveBeenCalled()

    const confirm = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete')
    confirm.click()
    await flushPromises()
    expect(del).toHaveBeenCalledWith(1)
  })

  it('does not load the song when its menu button is pressed', async () => {
    wrapper = await mountList()
    const store = useSongsStore()
    const load = vi.spyOn(store, 'loadSong')
    await openRowMenu('Paper Lantern')
    expect(load).not.toHaveBeenCalled()
  })
})

describe('compact layout', () => {
  it('keeps the columns while the list is wide enough, or not yet measured', async () => {
    wrapper = await mountList()
    expect(wrapper.find('.lib-head').exists()).toBe(true)
    await setListWidth(376)   // the 400px default sidebar minus its padding
    expect(wrapper.find('.lib-head').exists()).toBe(true)
    expect(wrapper.find('.song-item--compact').exists()).toBe(false)
  })

  it('switches to title-over-artist rows when the list is narrower than the columns need', async () => {
    wrapper = await mountList()
    await setListWidth(276)   // the 300px minimum sidebar
    expect(wrapper.find('.lib-head').exists()).toBe(false)
    expect(wrapper.findAll('.song-item--compact')).toHaveLength(LIBRARY.length)

    const ready = row('Paper Lantern')
    const title = ready.find('.lib-cell--title')
    const lines = title.findAll('p')
    expect(lines[0].text()).toContain('Paper Lantern')
    expect(lines[1].classes()).toContain('song-item__line2')
    expect(lines[1].text()).toBe('The Test Pattern')
    expect(ready.find('.song-item__meta .song-item__duration').text()).toBe('3:42')
    expect(ready.find('.more-btn').exists()).toBe(true)

    // Processing keeps its phase on line two; failed shows a badge on the right.
    expect(row('Busy Sample').find('.song-item__sub').text()).toContain('Separating stems')
    expect(row('Broken Sample').find('.song-item__meta').text()).toBe('Failed')
    expect(row('Broken Sample').find('.song-item__line2').text()).toBe('Unknown Artist')
  })

  it('switches back when the panel widens again', async () => {
    wrapper = await mountList()
    await setListWidth(276)
    expect(wrapper.find('.song-item--compact').exists()).toBe(true)
    await setListWidth(376)
    expect(wrapper.find('.song-item--compact').exists()).toBe(false)
  })

  it('raises the threshold when extra columns are switched on', async () => {
    localStorage.setItem('karaoke:libraryColumns', JSON.stringify(['title', 'artist', 'duration', 'added', 'status']))
    wrapper = await mountList()
    await setListWidth(376)
    expect(wrapper.find('.lib-head').exists()).toBe(false)
    await setListWidth(600)
    expect(wrapper.find('.lib-head').exists()).toBe(true)
  })

  it('keeps the sort reachable without headers, outside the scrolling list', async () => {
    wrapper = await mountList()
    expect(wrapper.find('.sort-row').exists()).toBe(false)
    await setListWidth(276)
    expect(wrapper.find('.song-list__header .sort-row').exists()).toBe(true)
    expect(wrapper.find('.song-list__body .sort-row').exists()).toBe(false)
    const select = wrapper.find('select.sort-select')
    expect(select.element.value).toBe('added')
    await select.setValue('title')
    const titles = wrapper.findAll('.song-item__title').map(n => n.text())
    expect(titles).toEqual(['Broken Sample', 'Busy Sample', 'Paper Lantern'])
    expect(JSON.parse(localStorage.getItem('karaoke:librarySort'))).toEqual({ key: 'title', dir: 'asc' })
  })
})

describe('column widths', () => {
  function stubHeaderWidth(key, width) {
    const el = wrapper.find(`.lib-th--${key}`).element
    el.getBoundingClientRect = () => ({ width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0 })
  }

  async function drag(col, from, to) {
    await wrapper.find(`.lib-th__resize[data-col="${col}"]`).trigger('pointerdown', { clientX: from })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: to }))
    await flushPromises()
  }

  const saved = () => JSON.parse(localStorage.getItem('karaoke:libraryColumnWidths'))
  const grid = () => wrapper.find('.lib-head').attributes('style')

  it('offers a separator between columns but not after the last', async () => {
    wrapper = await mountList()
    const handles = wrapper.findAll('.lib-th__resize').map(h => h.attributes('data-col'))
    expect(handles).toEqual(['title', 'artist'])
  })

  it('drags a column wider and persists the width', async () => {
    wrapper = await mountList()
    stubHeaderWidth('artist', 100)
    await drag('artist', 200, 230)
    expect(saved()).toEqual({ artist: 130 })
    expect(grid()).toContain('130px')
  })

  it('gives the title room by narrowing the column to its right', async () => {
    wrapper = await mountList()
    stubHeaderWidth('artist', 100)
    await drag('title', 200, 220)
    expect(saved()).toEqual({ artist: 80 })
  })

  it('does not treat the end of a drag as a sort click', async () => {
    wrapper = await mountList()
    stubHeaderWidth('artist', 100)
    await drag('artist', 200, 230)
    await wrapper.find('.lib-th--artist').trigger('click')
    expect(wrapper.find('.lib-th--artist').attributes('aria-sort')).toBe('none')
  })

  it('restores saved widths, including for extra columns, and clamps bad values', async () => {
    localStorage.setItem('karaoke:libraryColumns', JSON.stringify(['title', 'artist', 'duration', 'added']))
    localStorage.setItem('karaoke:libraryColumnWidths', JSON.stringify({ added: 96, artist: 5, title: 300, bogus: 40 }))
    wrapper = await mountList()
    const style = grid()
    expect(style).toContain('96px')
    expect(style).toContain('60px')               // artist clamped up to its floor
    expect(style).toContain('minmax(120px, 2fr)') // title always flexes
  })

  it('holds the layout during a drag and clamps the column to the room the list has', async () => {
    wrapper = await mountList()
    await setListWidth(376)
    stubHeaderWidth('artist', 80)
    await wrapper.find('.lib-th__resize[data-col="artist"]').trigger('pointerdown', { clientX: 200 })
    expect(wrapper.find('.song-list').classes()).toContain('song-list--col-resizing')

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
    await flushPromises()
    // Still columns mid-drag, and the artist stops where the columns still
    // fit: 376 list − 276 for everything else = 100.
    expect(wrapper.find('.lib-head').exists()).toBe(true)
    expect(grid()).toContain('100px')
    // Nothing is written until the drag ends.
    expect(localStorage.getItem('karaoke:libraryColumnWidths')).toBeNull()

    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 400 }))
    await flushPromises()
    expect(saved()).toEqual({ artist: 100 })
    expect(wrapper.find('.lib-head').exists()).toBe(true)
    expect(wrapper.find('.song-list').classes()).not.toContain('song-list--col-resizing')
  })

  it('shrinks an oversize saved width on first measure instead of forcing compact rows', async () => {
    localStorage.setItem('karaoke:libraryColumnWidths', JSON.stringify({ artist: 400 }))
    wrapper = await mountList()
    await setListWidth(376)
    expect(wrapper.find('.lib-head').exists()).toBe(true)
    expect(grid()).toContain('100px')
    // The saved preference itself is left alone.
    expect(saved()).toEqual({ artist: 400 })
  })
})
