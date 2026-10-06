// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library sidebar's browse controls: a Songs | Artists toggle, an artist
// index built from the loaded library that drills into one artist's songs
// with a way back, and a filter
// button beside the search field whose popover holds the status filters (with
// counts) and the sort. There is no separate status row.

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
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  exportApi: { getSettings: vi.fn(), setSettings: vi.fn(), exportSong: vi.fn() },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

const LIBRARY = [
  { id: 1, title: 'Harbor Test Tune', artist: 'Sample Ensemble', duration: 200, status: 'ready', created_at: '2026-08-04T00:00:00' },
  { id: 2, title: 'Lantern Test Tune', artist: 'Sample Ensemble', duration: 180, status: 'processing', phase: 'separating', progress: 40, created_at: '2026-08-03T00:00:00' },
  { id: 3, title: 'Porch Test Tune', artist: 'Fixture Trio', duration: 150, status: 'ready', created_at: '2026-08-02T00:00:00' },
  { id: 4, title: 'Ferry Test Tune', artist: 'Fixture Trio', duration: 170, status: 'failed', created_at: '2026-08-01T00:00:00' },
  { id: 5, title: 'Quarry Test Tune', artist: 'Mock Quartet', duration: 160, status: 'processing', phase: 'queued', created_at: '2026-07-31T00:00:00' },
  { id: 6, title: 'Nameless Test Tune', artist: '', duration: 140, status: 'ready', created_at: '2026-07-30T00:00:00' },
  { id: 7, title: 'Orphan Test Tune', artist: null, duration: 130, status: 'ready', created_at: '2026-07-29T00:00:00' },
]
const ALL_TITLES = LIBRARY.map(s => s.title)

let wrapper = null
let store = null

async function mountList(songs = LIBRARY) {
  wrapper = mount(SongList, { attachTo: document.body })
  store = useSongsStore()
  store.songs = songs.map(s => ({ ...s }))
  store.loading = false
  await flushPromises()
  return wrapper
}

const titles = () => wrapper.findAll('.song-item__title').map(n => n.text())
const modeButton = (label) => wrapper.findAll('.lib-mode').find(b => b.text() === label)
const popover = () => document.querySelector('.ui-pop')
const artistRows = () => wrapper.findAll('.artist-row').map(r => [r.find('.artist-row__name').text(), r.find('.artist-row__count').text()])
const artistRow = (name) => wrapper.findAll('.artist-row').find(r => r.find('.artist-row__name').text() === name)

async function showArtists() {
  await modeButton('Artists').trigger('click')
  await flushPromises()
}

async function openFilter() {
  await wrapper.find('.filter-btn').trigger('click')
  await flushPromises()
  return popover()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  deleteSong.mockResolvedValue({})
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('Songs | Artists toggle', () => {
  it('starts on Songs and is a pair of pressed-state buttons', async () => {
    await mountList()
    const group = wrapper.find('.lib-modes')
    expect(group.attributes('role')).toBe('group')
    expect(modeButton('Songs').attributes('aria-pressed')).toBe('true')
    expect(modeButton('Artists').attributes('aria-pressed')).toBe('false')
    expect(modeButton('Artists').element.tagName).toBe('BUTTON')
    expect(titles()).toHaveLength(LIBRARY.length)
  })

  it('switches to the artist index, built from the library, and back', async () => {
    await mountList()
    await showArtists()
    expect(listSongs).not.toHaveBeenCalled()
    expect(modeButton('Artists').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.lib-table').exists()).toBe(false)
    // Every status counts; a missing artist name is one Unknown Artist entry, last.
    expect(artistRows()).toEqual([
      ['Fixture Trio', '2 songs'],
      ['Mock Quartet', '1 song'],
      ['Sample Ensemble', '2 songs'],
      ['Unknown Artist', '2 songs'],
    ])
    expect(wrapper.find('.artist-pages').exists()).toBe(false)
    expect(wrapper.find('.search-input').attributes('placeholder')).toBe('Search artists')

    await modeButton('Songs').trigger('click')
    await flushPromises()
    expect(wrapper.find('.artist-row').exists()).toBe(false)
    expect(titles()).toHaveLength(LIBRARY.length)
    expect(wrapper.find('.search-input').attributes('placeholder')).toBe('Search title, artist, or filename…')
  })

  it('drills into an artist, shows its songs and the way back, by keyboard', async () => {
    await mountList()
    modeButton('Artists').element.focus()
    await showArtists()

    const artist = artistRow('Fixture Trio')
    expect(artist.element.tagName).toBe('BUTTON')
    artist.element.focus()
    expect(document.activeElement).toBe(artist.element)
    await artist.trigger('click')
    await flushPromises()

    expect(wrapper.find('.artist-crumb__name').text()).toBe('Fixture Trio')
    const back = wrapper.find('.artist-crumb__back')
    expect(back.text()).toBe('← All artists')
    // Focus stays in the panel: the clicked artist button is gone.
    expect(document.activeElement).toBe(back.element)
    expect(titles().sort()).toEqual(['Ferry Test Tune', 'Porch Test Tune'])
    expect(wrapper.find('.search-input').attributes('placeholder')).toBe('Search this artist’s songs')

    await back.trigger('click')
    await flushPromises()
    expect(wrapper.find('.artist-crumb').exists()).toBe(false)
    expect(document.activeElement).toBe(artistRow('Fixture Trio').element)
  })

  it('drills into the unnamed artist', async () => {
    await mountList()
    await showArtists()
    await artistRow('Unknown Artist').trigger('click')
    await flushPromises()
    expect(wrapper.find('.artist-crumb__name').text()).toBe('Unknown Artist')
    expect(titles().sort()).toEqual(['Nameless Test Tune', 'Orphan Test Tune'])
  })

  it('lists an artist whose only songs are still processing', async () => {
    await mountList()
    await showArtists()
    expect(artistRows()).toContainEqual(['Mock Quartet', '1 song'])
    await artistRow('Mock Quartet').trigger('click')
    await flushPromises()
    expect(titles()).toEqual(['Quarry Test Tune'])
    expect(wrapper.find('.song-item__phase').text()).toBe('Queued')
  })

  it('counts only songs that pass the status filter', async () => {
    await mountList()
    await showArtists()
    store.statusFilter = 'ready'
    await flushPromises()
    expect(artistRows()).toEqual([
      ['Fixture Trio', '1 song'],
      ['Sample Ensemble', '1 song'],
      ['Unknown Artist', '2 songs'],
    ])
    store.statusFilter = 'all'
    await flushPromises()
    expect(artistRow('Mock Quartet').exists()).toBe(true)
  })

  it('applies the status filter inside an artist', async () => {
    await mountList()
    await showArtists()
    await artistRow('Fixture Trio').trigger('click')
    await flushPromises()
    store.statusFilter = 'failed'
    await flushPromises()
    expect(titles()).toEqual(['Ferry Test Tune'])
  })

  it('follows the library: deletes and finished processing update both views', async () => {
    await mountList()
    await showArtists()
    await artistRow('Fixture Trio').trigger('click')
    await flushPromises()
    await store.deleteSong(4)
    await flushPromises()
    expect(deleteSong).toHaveBeenCalledWith(4)
    expect(titles()).toEqual(['Porch Test Tune'])

    await wrapper.find('.artist-crumb__back').trigger('click')
    await flushPromises()
    expect(artistRow('Fixture Trio').find('.artist-row__count').text()).toBe('1 song')

    // A song finishing processing reaches the index under the status filter.
    store.statusFilter = 'ready'
    await flushPromises()
    expect(artistRow('Mock Quartet')).toBe(undefined)
    store.songs = store.songs.map(s => (s.id === 5 ? { ...s, status: 'ready', phase: null } : s))
    await flushPromises()
    expect(artistRow('Mock Quartet').find('.artist-row__count').text()).toBe('1 song')
  })

  it('searches artists tolerantly, without asking the server', async () => {
    await mountList()
    await showArtists()
    await wrapper.find('.search-input').setValue('trio fixture')
    await flushPromises()
    expect(artistRows()).toEqual([['Fixture Trio', '2 songs']])
    await wrapper.find('.search-input').setValue('nobody here')
    await flushPromises()
    expect(wrapper.find('.song-list__empty').text()).toBe('No matching artists')
    expect(listSongs).not.toHaveBeenCalled()
  })

  it('shows the empty-library copy in Artists view too', async () => {
    await mountList([])
    await showArtists()
    expect(wrapper.find('.song-list__empty').text()).toBe('Add files to get started')
  })

  it('a Songs search does not narrow the Artists view, and comes back with Songs', async () => {
    const matching = LIBRARY.filter(s => s.title.startsWith('Harbor'))
    listSongs.mockImplementation(async ({ search } = {}) => ({
      data: { songs: search ? matching : LIBRARY, total: search ? matching.length : LIBRARY.length },
    }))
    vi.useFakeTimers()
    try {
      await mountList()
      await wrapper.find('.search-input').setValue('harbor')
      await vi.advanceTimersByTimeAsync(300)
      expect(store.searchQuery).toBe('harbor')
      expect(titles()).toEqual(['Harbor Test Tune'])

      await modeButton('Artists').trigger('click')
      await vi.advanceTimersByTimeAsync(300)
      expect(store.searchQuery).toBe('')
      expect(artistRows().map(([name]) => name)).toEqual(['Fixture Trio', 'Mock Quartet', 'Sample Ensemble', 'Unknown Artist'])

      await modeButton('Songs').trigger('click')
      await vi.advanceTimersByTimeAsync(300)
      expect(wrapper.find('.search-input').element.value).toBe('harbor')
      expect(store.searchQuery).toBe('harbor')
      expect(titles()).toEqual(['Harbor Test Tune'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a separate search per view', async () => {
    await mountList()
    await wrapper.find('.search-input').setValue('harbor')
    await showArtists()
    expect(wrapper.find('.search-input').element.value).toBe('')
    await modeButton('Songs').trigger('click')
    await flushPromises()
    expect(wrapper.find('.search-input').element.value).toBe('harbor')
  })
})

describe('filter popover', () => {
  it('replaces the status row', async () => {
    await mountList()
    expect(wrapper.find('.filter-tabs').exists()).toBe(false)
    expect(wrapper.find('.filter-tab').exists()).toBe(false)
    expect(wrapper.find('.sort-row').exists()).toBe(false)
    const btn = wrapper.find('.search-row .filter-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('Filter')
    expect(btn.text()).toBe('')
  })

  it('lists the four statuses with counts, and the sort', async () => {
    await mountList()
    const pop = await openFilter()
    expect(pop.getAttribute('aria-label')).toBe('Filter')
    const radios = [...pop.querySelectorAll('[role="radio"]')]
    expect(radios.map(r => r.querySelector('.filter-menu__label').textContent)).toEqual(['All', 'Ready', 'Processing', 'Failed'])
    expect(radios.map(r => r.querySelector('.filter-menu__count').textContent)).toEqual(['7', '4', '2', '1'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    const select = pop.querySelector('select.sort-select')
    expect(select.value).toBe('added')
    expect([...select.options].map(o => o.textContent)).toContain('Date added')
  })

  it('choosing a status filters the list and marks the button', async () => {
    await mountList()
    const pop = await openFilter()
    pop.querySelector('[data-filter="ready"]').click()
    await flushPromises()
    expect(titles()).toEqual(['Harbor Test Tune', 'Porch Test Tune', 'Nameless Test Tune', 'Orphan Test Tune'])
    expect(wrapper.find('.filter-btn').classes()).toContain('filter-btn--set')
    expect(pop.querySelector('[data-filter="ready"]').getAttribute('aria-checked')).toBe('true')

    pop.querySelector('[data-filter="all"]').click()
    await flushPromises()
    expect(titles()).toEqual(ALL_TITLES)
    expect(wrapper.find('.filter-btn').classes()).not.toContain('filter-btn--set')
  })

  it('is keyboard operable: one Tab stop, arrows choose, Escape returns to the button', async () => {
    await mountList()
    const btn = wrapper.find('.filter-btn')
    btn.element.focus()
    const pop = await openFilter()
    const tabbable = [...pop.querySelectorAll('[role="radio"]')].filter(r => r.getAttribute('tabindex') === '0')
    expect(tabbable.map(r => r.dataset.filter)).toEqual(['all'])

    tabbable[0].focus()
    tabbable[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(store.statusFilter).toBe('ready')
    expect(document.activeElement.dataset.filter).toBe('ready')
    expect(titles()).toHaveLength(4)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await flushPromises()
    expect(store.statusFilter).toBe('all')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(popover()).toBe(null)
    expect(document.activeElement).toBe(btn.element)
  })

  it('the sort choice reorders the list', async () => {
    await mountList()
    const pop = await openFilter()
    const select = pop.querySelector('select.sort-select')
    select.value = 'title'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(titles()).toEqual([...ALL_TITLES].sort())
  })
})

describe('empty library copy', () => {
  it('asks to add files, never to upload', async () => {
    wrapper = mount(SongList, { attachTo: document.body })
    store = useSongsStore()
    store.songs = []
    store.loading = false
    await flushPromises()
    expect(wrapper.find('.song-list__empty').text()).toBe('Add files to get started')
    expect(wrapper.text().toLowerCase()).not.toContain('upload')
  })
})

describe('row menu', () => {
  it('holds Song tools, Export and Delete', async () => {
    await mountList()
    const ready = wrapper.findAll('.song-item').find(r => r.text().includes('Harbor Test Tune'))
    const more = ready.find('.more-btn')
    await more.trigger('click')
    await flushPromises()
    const menu = document.getElementById(more.attributes('aria-controls'))
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim())
    expect(items[0]).toBe('Song tools…')
    expect(items[items.length - 1]).toBe('Delete song…')
  })
})
