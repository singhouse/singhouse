// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library list as a keyboard grid: one roving Tab stop among the rows,
// arrows/Home/End move it, Enter or Space loads a ready song, Delete opens the
// existing confirm on Cancel, and → reaches the row's ⋯ button, which is
// never hidden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const listSongs = vi.fn()
const deleteSong = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a), delete: (...a) => deleteSong(...a) },
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

// Default sort is newest first, so the rows render Alpha, Beta, Gamma.
const LIBRARY = [
  { id: 1, title: 'Alpha Test Tune', artist: 'A', duration: 200, status: 'ready', created_at: '2026-08-03T00:00:00' },
  { id: 2, title: 'Beta Test Tune', artist: 'B', duration: 100, status: 'processing', created_at: '2026-08-02T00:00:00' },
  { id: 3, title: 'Gamma Test Tune', artist: 'C', duration: 150, status: 'ready', created_at: '2026-08-01T00:00:00' },
]

let wrapper = null
let store = null
let loadSpy = null

async function mountList({ current = null } = {}) {
  wrapper = mount(SongList, { attachTo: document.body })
  store = useSongsStore()
  store.songs = LIBRARY.map(s => ({ ...s }))
  store.loading = false
  if (current) store.currentSong = store.songs.find(s => s.id === current)
  loadSpy = vi.spyOn(store, 'loadSong').mockImplementation(() => {})
  await flushPromises()
  return wrapper
}

const rows = () => [...document.querySelectorAll('.song-item')]
const row = (title) => rows().find(r => r.textContent.includes(title))
const tabStops = () => rows().filter(r => r.getAttribute('tabindex') === '0')

function key(el, k, init = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}

async function press(k, init) {
  const ev = key(document.activeElement, k, init)
  await flushPromises()
  return ev
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  deleteSong.mockReset()
  deleteSong.mockResolvedValue({ data: {} })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('grid structure', () => {
  it('names the header row\'s status and actions columns', async () => {
    await mountList()
    const heads = [...document.querySelectorAll('.lib-head [role="columnheader"]')]
    expect(heads[0].textContent.trim()).toBe('Status')
    expect(heads[heads.length - 1].textContent.trim()).toBe('Actions')
    expect(heads[0].querySelector('.sr-only')).not.toBeNull()
    expect(heads[heads.length - 1].querySelector('.sr-only')).not.toBeNull()
  })

  it('is a grid of rows with exactly one tab stop among them', async () => {
    await mountList()
    const grid = document.querySelector('.lib-table')
    expect(grid.getAttribute('role')).toBe('grid')
    expect(document.getElementById(grid.getAttribute('aria-labelledby')).textContent).toBe('Library')
    expect(rows()).toHaveLength(3)
    expect(rows().every(r => r.getAttribute('role') === 'row')).toBe(true)
    expect(tabStops()).toEqual([row('Alpha')])
    // Only the roving row's ⋯ button is in the Tab order.
    const menuStops = rows().map(r => r.querySelector('.more-btn').getAttribute('tabindex'))
    expect(menuStops).toEqual(['0', '-1', '-1'])
  })

  it('starts on the loaded song when it is in the list', async () => {
    await mountList({ current: 3 })
    expect(tabStops()).toEqual([row('Gamma')])
  })

  it('moves the tab stop when the roving row is filtered out', async () => {
    await mountList()
    row('Beta').focus()
    await flushPromises()
    expect(tabStops()).toEqual([row('Beta')])

    store.statusFilter = 'ready'
    await flushPromises()
    expect(row('Beta')).toBeUndefined()
    expect(tabStops()).toEqual([row('Alpha')])
  })
})

describe('arrow keys', () => {
  it('ArrowDown and ArrowUp move the active row', async () => {
    await mountList()
    row('Alpha').focus()

    await press('ArrowDown')
    expect(document.activeElement).toBe(row('Beta'))
    expect(tabStops()).toEqual([row('Beta')])

    await press('ArrowDown')
    expect(document.activeElement).toBe(row('Gamma'))
    await press('ArrowDown')     // stops at the end
    expect(document.activeElement).toBe(row('Gamma'))

    await press('ArrowUp')
    expect(document.activeElement).toBe(row('Beta'))
    expect(tabStops()).toEqual([row('Beta')])
  })

  it('Home and End jump to the ends', async () => {
    await mountList()
    row('Beta').focus()
    await press('End')
    expect(document.activeElement).toBe(row('Gamma'))
    await press('Home')
    expect(document.activeElement).toBe(row('Alpha'))
  })

  it('→ enters the row\'s ⋯ button and ← returns to the row', async () => {
    await mountList()
    row('Alpha').focus()
    await press('ArrowRight')
    expect(document.activeElement).toBe(row('Alpha').querySelector('.more-btn'))
    await press('ArrowLeft')
    expect(document.activeElement).toBe(row('Alpha'))
  })
})

describe('loading', () => {
  it('Enter and Space on a ready row load it', async () => {
    await mountList()
    row('Alpha').focus()
    const enter = await press('Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy.mock.calls[0][0].id).toBe(1)

    row('Gamma').focus()
    const space = await press(' ')
    expect(space.defaultPrevented).toBe(true)
    expect(loadSpy).toHaveBeenCalledTimes(2)
    expect(loadSpy.mock.calls[1][0].id).toBe(3)
  })

  it('a not-ready row ignores Enter', async () => {
    await mountList()
    row('Beta').focus()
    await press('Enter')
    await press(' ')
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('a click still loads a ready row', async () => {
    await mountList()
    row('Gamma').click()
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })
})

describe('Delete key', () => {
  it('opens the existing confirm with focus on Cancel; Escape returns to the row', async () => {
    await mountList()
    row('Beta').focus()
    await press('Delete')

    const dialog = document.querySelector('dialog.modal-overlay')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Delete Song?')
    expect(document.activeElement.textContent).toBe('Cancel')
    expect(deleteSong).not.toHaveBeenCalled()

    await press('Escape')
    expect(document.querySelector('dialog.modal-overlay')).toBeNull()
    expect(document.activeElement).toBe(row('Beta'))
    expect(deleteSong).not.toHaveBeenCalled()
  })

  it('after a confirmed delete, focus moves to the next row', async () => {
    await mountList()
    row('Beta').focus()
    await press('Delete')
    document.querySelector('dialog.modal-overlay .ui-btn--danger').click()
    await flushPromises()
    await flushPromises()

    expect(deleteSong).toHaveBeenCalledWith(2)
    expect(row('Beta')).toBeUndefined()
    expect(document.activeElement).toBe(row('Gamma'))
    expect(tabStops()).toEqual([row('Gamma')])
  })
})

describe('delete in flight and leaving rows', () => {
  it('moves focus on even while the deleted row is still leaving the DOM', async () => {
    await mountList()
    const doomed = row('Beta')
    // Stand in for the list-leave transition: the deleted row stays connected.
    const parent = doomed.parentNode
    const removeChild = parent.removeChild.bind(parent)
    parent.removeChild = (el) => (el === doomed ? el : removeChild(el))

    doomed.focus()
    await press('Delete')
    document.querySelector('dialog.modal-overlay .ui-btn--danger').click()
    await flushPromises()
    await flushPromises()

    expect(deleteSong).toHaveBeenCalledWith(2)
    expect(doomed.isConnected).toBe(true)
    const next = rows().find(r => r !== doomed && r.textContent.includes('Gamma'))
    expect(document.activeElement).toBe(next)
    parent.removeChild = removeChild
  })

  it('holds the confirm open and ignores a second confirm while the delete is pending', async () => {
    let finish
    deleteSong.mockReturnValue(new Promise((r) => { finish = r }))
    await mountList()
    row('Beta').focus()
    await press('Delete')
    const dialog = document.querySelector('dialog.modal-overlay')
    const confirm = dialog.querySelector('.ui-btn--danger')
    confirm.click()
    await flushPromises()

    expect(confirm.disabled).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    key(dialog, 'Escape')
    await flushPromises()
    expect(document.querySelector('dialog.modal-overlay')).not.toBeNull()

    // A second Enter (or click) on the confirm issues no second delete.
    confirm.focus()
    await press('Enter')
    confirm.click()
    wrapper.findComponent({ name: 'Modal' }).vm.$emit('confirm')
    await flushPromises()
    expect(deleteSong).toHaveBeenCalledTimes(1)

    finish({ data: {} })
    await flushPromises()
    expect(document.querySelector('dialog.modal-overlay')).toBeNull()
  })
})

describe('row actions on focus', () => {
  it('the ⋯ button is visible while the row has focus within it', async () => {
    await mountList()
    const r = row('Alpha')
    r.focus()
    await press('ArrowRight')
    const btn = r.querySelector('.more-btn')
    expect(document.activeElement).toBe(btn)
    expect(r.contains(document.activeElement)).toBe(true)
    expect([...btn.classList].some(c => /hidden|invisible/.test(c))).toBe(false)
    expect(btn.getAttribute('style') || '').not.toMatch(/opacity|visibility|display/)

    // No stylesheet rule hides the row's actions until hover.
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../../src/components/SongList.vue'), 'utf8').split('<style')[1]
    expect(css).not.toMatch(/(more-btn|lib-cell--more)[^{]*\{[^}]*(opacity:\s*0[;\s}]|visibility:\s*hidden|display:\s*none)/)
  })
})
