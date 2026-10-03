// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Sorting + column-visibility contract for the library table.
// Covers the ordering rules a host actually notices: default order matches
// what the server already returned, headers toggle direction, unknown values
// stay at the bottom in both directions, and hidden columns persist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

// Timestamps are deliberately chosen so that added-desc, title-asc and
// artist-asc are three DIFFERENT orders. If they coincided, a sort test would
// pass against an implementation that ignored the click entirely.
//   added-desc  → Zither, Alpha, Middle
//   title-asc   → Alpha, Middle, Zither
//   artist-asc  → Zither(Ackerman), Middle(Marley), Alpha(Zeppelin)
// `created_at` is written in the backend's real wire format: naive UTC, no
// offset. A parser that reads it as local time drifts by the runner's zone.
const LIBRARY = [
  { id: 1, title: 'Zither Blues',  artist: 'Ackerman', duration: 200,  status: 'ready', created_at: '2026-08-03T00:00:00' },
  { id: 2, title: 'Alpha Song',    artist: 'Zeppelin', duration: 100,  status: 'ready', created_at: '2026-08-02T00:00:00' },
  { id: 3, title: 'Middle Ground', artist: 'Marley',   duration: null, status: 'ready', created_at: '2026-08-01T00:00:00' },
]

let wrapper = null

function titles() {
  return wrapper.findAll('.song-item__title').map(n => n.text())
}

async function mountList(songs = LIBRARY) {
  // The ⋯ popover teleports to <body>; stubbed so its panel renders in place
  // and stays reachable through the wrapper.
  const w = mount(SongList, { global: { stubs: { teleport: true } } })
  const store = useSongsStore()
  store.songs = [...songs]
  store.loading = false
  await w.vm.$nextTick()
  return w
}

// The column chooser is the library ⋯ menu's second face.
async function openColumns() {
  await wrapper.find('.lib-menu__btn').trigger('click')
  await wrapper.find('.lib-menu__columns').trigger('click')
}

function headerFor(label) {
  return wrapper.findAll('.lib-th').find(b => b.text().toLowerCase().includes(label))
}

// Scoped to rows on purpose. The header buttons carry their own `lib-th--*`
// classes, so a bare `.lib-cell--artist` would match the header and pass even
// if every row cell vanished.
function rowCells(key) {
  return wrapper.findAll(`.song-item .lib-cell--${key}`)
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: [] } })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('library sorting', () => {
  it('defaults to newest-first, matching the server order the host already saw', async () => {
    wrapper = await mountList()
    expect(titles()).toEqual(['Zither Blues', 'Alpha Song', 'Middle Ground'])
  })

  it('sorts by title ascending on first click of the Title header', async () => {
    wrapper = await mountList()
    await headerFor('title').trigger('click')
    // Differs from the default order, so this cannot pass on a no-op click.
    expect(titles()).toEqual(['Alpha Song', 'Middle Ground', 'Zither Blues'])
  })

  it('reverses direction on a second click of the same header', async () => {
    wrapper = await mountList()
    await headerFor('title').trigger('click')
    await headerFor('title').trigger('click')
    expect(titles()).toEqual(['Zither Blues', 'Middle Ground', 'Alpha Song'])
  })

  it('sorts by artist independently of title', async () => {
    wrapper = await mountList()
    await headerFor('artist').trigger('click')
    expect(titles()).toEqual(['Zither Blues', 'Middle Ground', 'Alpha Song'])
  })

  it('reports sort state to assistive tech via aria-sort', async () => {
    wrapper = await mountList()
    await headerFor('title').trigger('click')
    expect(headerFor('title').attributes('aria-sort')).toBe('ascending')
    await headerFor('title').trigger('click')
    expect(headerFor('title').attributes('aria-sort')).toBe('descending')
    expect(headerFor('artist').attributes('aria-sort')).toBe('none')
  })

  it('reads created_at as UTC, not as the viewer local time', async () => {
    // The backend emits naive UTC with no offset. Parsed as local time, a
    // late-evening add renders as the NEXT day for any negative-offset host.
    wrapper = await mountList([
      { id: 9, title: 'Late Add', artist: 'X', duration: 10, status: 'ready',
        created_at: '2026-08-11T01:35:18' },
    ])
    await openColumns()
    const addedBox = wrapper.findAll('.col-menu__item')
      .find(l => l.text().toLowerCase().includes('added'))
      .find('input')
    await addedBox.setValue(true)

    const shown = rowCells('added')[0].text()
    const expected = new Date(Date.parse('2026-08-11T01:35:18Z'))
      .toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' })
    expect(shown).toBe(expected)
  })

  it('treats a zero duration as unknown, consistently with the blank it renders', async () => {
    wrapper = await mountList([
      { id: 1, title: 'Has Time', artist: 'A', duration: 90, status: 'ready', created_at: '2026-08-01T00:00:00' },
      { id: 2, title: 'Zero Time', artist: 'B', duration: 0, status: 'ready', created_at: '2026-08-02T00:00:00' },
    ])
    await headerFor('time').trigger('click')          // desc
    expect(titles()[1]).toBe('Zero Time')
    await headerFor('time').trigger('click')          // asc
    expect(titles()[1]).toBe('Zero Time')
    expect(rowCells('duration')[1].text()).toBe('')
  })

  it('keeps songs with no duration at the bottom in BOTH directions', async () => {
    wrapper = await mountList()
    await headerFor('time').trigger('click')          // desc first for numerics
    expect(titles()[2]).toBe('Middle Ground')
    await headerFor('time').trigger('click')          // asc
    expect(titles()[2]).toBe('Middle Ground')
  })

  it('restores the saved sort on remount', async () => {
    wrapper = await mountList()
    await headerFor('title').trigger('click')
    await headerFor('title').trigger('click')         // title desc
    wrapper.unmount()

    wrapper = await mountList()
    expect(titles()).toEqual(['Zither Blues', 'Middle Ground', 'Alpha Song'])
  })
})

describe('table structure', () => {
  // The grid template is generated from COLUMNS while the row cells are
  // hand-written v-if blocks. If those two ever disagree, every row's columns
  // shift against the header. Pin the parity rather than trusting the order.
  it('emits the same cell count in the header and every row, for any column set', async () => {
    wrapper = await mountList()
    await openColumns()   // open once; re-clicking would close it

    for (const col of ['added', 'status', 'artist']) {
      const box = wrapper.findAll('.col-menu__item')
        .find(l => l.text().toLowerCase().includes(col))
        .find('input')
      await box.setValue(!box.element.checked)

      const headCount = wrapper.find('.lib-head').element.children.length
      const rows = wrapper.findAll('.song-item')
      for (const row of rows) {
        expect(row.element.children.length).toBe(headCount)
      }
      // …and the grid declares exactly that many tracks.
      const tracks = wrapper.find('.lib-head').attributes('style')
        .match(/grid-template-columns:\s*([^;]+)/)[1]
        .trim().split(/\s+(?![^(]*\))/)
      expect(tracks.length).toBe(headCount)
    }
  })
})

describe('column visibility', () => {
  it('shows the default column set on every row', async () => {
    wrapper = await mountList()
    expect(rowCells('artist')).toHaveLength(LIBRARY.length)
    expect(rowCells('duration')).toHaveLength(LIBRARY.length)
    expect(rowCells('added')).toHaveLength(0)
  })

  it('hides a column when it is unchecked, and persists that across remounts', async () => {
    wrapper = await mountList()
    await openColumns()

    const artistBox = wrapper.findAll('.col-menu__item')
      .find(l => l.text().toLowerCase().includes('artist'))
      .find('input')
    await artistBox.setValue(false)

    expect(rowCells('artist')).toHaveLength(0)

    wrapper.unmount()
    wrapper = await mountList()
    expect(rowCells('artist')).toHaveLength(0)
  })

  it('can switch a hidden column back on', async () => {
    wrapper = await mountList()
    await openColumns()

    const addedBox = wrapper.findAll('.col-menu__item')
      .find(l => l.text().toLowerCase().includes('added'))
      .find('input')
    await addedBox.setValue(true)

    expect(rowCells('added')).toHaveLength(LIBRARY.length)
  })

  it('refuses to hide the title column', async () => {
    wrapper = await mountList()
    await openColumns()

    const titleItem = wrapper.findAll('.col-menu__item')
      .find(l => l.text().toLowerCase().includes('title'))
    expect(titleItem.find('input').attributes('disabled')).toBeDefined()
    expect(rowCells('title')).toHaveLength(LIBRARY.length)
  })

  it('drops an unknown saved column and forces the locked one back on', async () => {
    localStorage.setItem('karaoke:libraryColumns', JSON.stringify(['bogus', 'artist']))
    wrapper = await mountList()

    expect(rowCells('title')).toHaveLength(LIBRARY.length)
    expect(rowCells('artist')).toHaveLength(LIBRARY.length)
    expect(rowCells('bogus')).toHaveLength(0)
  })

  it('closes the column menu on Escape', async () => {
    wrapper = await mountList()
    await openColumns()
    expect(wrapper.find('.col-menu__pop').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.col-menu__pop').exists()).toBe(false)
  })
})
