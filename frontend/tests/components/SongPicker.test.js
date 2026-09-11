// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The picker's sheet. The behaviour under test is the one that made the join
// page unusable on a phone: search results used to live and die with input
// focus, so closing the soft keyboard to read them threw them away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  songApi: { list: (...a) => listSongs(...a) },
}))
// Core with no catalog provider installed: local library search only.
vi.mock('@/plugins/slots', () => ({ getSlot: () => null }))

import SongPicker from '@/components/SongPicker.vue'

const SONGS = [
  { id: 1, title: 'Heroes', artist: 'Bowie', status: 'ready' },
  { id: 2, title: 'Modern Love', artist: 'Bowie', status: 'ready' },
  { id: 3, title: 'Still Cooking', artist: 'Bowie', status: 'processing' },
]

let wrapper = null

beforeEach(() => {
  vi.useFakeTimers()
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: SONGS } })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const sheet = () => document.body.querySelector('.sheet')
const isOpen = () => sheet() !== null && sheet().style.display !== 'none'
const input = () => document.body.querySelector('.sheet__input')
const rows = () => [...document.body.querySelectorAll('.sheet__row')]
const freehand = () => document.body.querySelector('.sheet__freehand')

function mountPicker(props = {}) {
  wrapper = mount(SongPicker, {
    props: { mode: 'singer', ...props },
    attachTo: document.body,
  })
  return wrapper
}

async function search(text) {
  input().value = text
  await input().dispatchEvent(new Event('input'))
  await vi.advanceTimersByTimeAsync(300)
}

describe('the sheet', () => {
  it('starts closed, behind a trigger rather than an inline input', async () => {
    mountPicker()
    expect(wrapper.find('.picker__trigger').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(isOpen()).toBe(false)
  })

  it('opens on the trigger and closes on Cancel', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    expect(isOpen()).toBe(true)

    await document.body.querySelector('.sheet__cancel').dispatchEvent(
      new Event('click', { bubbles: true })
    )
    await wrapper.vm.$nextTick()
    expect(isOpen()).toBe(false)
  })

  it('does not open while the parent is busy saving a pick', async () => {
    mountPicker({ busy: true })
    await wrapper.find('.picker__trigger').trigger('click')
    expect(isOpen()).toBe(false)
  })
})

describe('results', () => {
  it('lists ready local songs and skips ones still processing', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')

    expect(rows()).toHaveLength(2)
    expect(sheet().textContent).toContain('Heroes')
    expect(sheet().textContent).not.toContain('Still Cooking')
  })

  it('SURVIVES the keyboard closing — blur must not clear them', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')
    expect(rows()).toHaveLength(2)

    // Tapping "Done" on the soft keyboard is exactly this. The old code closed
    // on a 150ms timer, so the wait past it is the whole point of the test.
    await input().dispatchEvent(new Event('blur', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)
    await wrapper.vm.$nextTick()

    expect(isOpen()).toBe(true)
    expect(rows()).toHaveLength(2)
  })

  it('picks a local song by tap, emitting "artist — title" and the id', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')

    await rows()[0].dispatchEvent(new Event('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('pick')[0]).toEqual(['Bowie — Heroes', 1])
    expect(isOpen()).toBe(false)   // picking closes the sheet
  })

  it('keeps the freehand action pinned even with a full result list', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')

    // Pinned in the footer, not appended after the rows.
    expect(freehand()).not.toBeNull()
    expect(freehand().closest('.sheet__foot')).not.toBeNull()
    expect(freehand().closest('.sheet__results')).toBeNull()

    await freehand().dispatchEvent(new Event('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('pick')[0]).toEqual(['bowie', null])
  })

  it('does not paint an in-flight query over a shortened one', async () => {
    // The request must still be PENDING when the user backspaces — a mock that
    // resolves immediately paints before the backspace and tests nothing.
    let release
    listSongs.mockImplementation(() => new Promise(r => { release = r }))

    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')

    input().value = 'bowie'
    await input().dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)   // debounce fired; request in flight
    expect(rows()).toHaveLength(0)           // nothing painted yet

    input().value = 'b'                      // backspace below the 2-char floor
    await input().dispatchEvent(new Event('input'))
    release({ data: { songs: SONGS } })      // the stale request lands late
    await vi.advanceTimersByTimeAsync(500)

    expect(rows()).toHaveLength(0)
  })

  it('does not paint a stale error over a shortened query either', async () => {
    let reject
    listSongs.mockImplementation(() => new Promise((_, r) => { reject = r }))

    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')

    input().value = 'bowie'
    await input().dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)

    input().value = 'b'
    await input().dispatchEvent(new Event('input'))
    reject(new Error('Network Error'))
    await vi.advanceTimersByTimeAsync(500)

    expect(sheet().textContent).not.toContain('not responding')
  })

  it('does not refill the list from a debounce armed before the pick', async () => {
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bow')
    expect(rows()).toHaveLength(2)

    // Type again, then pick a visible row before the new debounce fires.
    input().value = 'bowie'
    await input().dispatchEvent(new Event('input'))
    await rows()[0].dispatchEvent(new Event('click', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)

    expect(wrapper.emitted('pick')).toHaveLength(1)
    expect(isOpen()).toBe(false)
    expect(rows()).toHaveLength(0)   // reopening must not show stale results
  })

  it('offers freehand when nothing matches', async () => {
    listSongs.mockResolvedValue({ data: { songs: [] } })
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('a song nobody owns')

    expect(rows()).toHaveLength(0)
    expect(sheet().textContent).toContain('Nothing here matches')
    expect(freehand()).not.toBeNull()
  })

  // A backend that is simply down rejects the request. allSettled absorbs
  // that, so it reaches the UI as an empty result set — and claiming "nothing
  // matches" is then a lie about the host's library that sends the guest off
  // to request a song that is sitting right there with stems.
  it('says the search failed, not that the library is empty, on a rejected request', async () => {
    listSongs.mockRejectedValue(new Error('Network Error'))
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')

    expect(sheet().textContent).not.toContain('Searching…')
    expect(sheet().textContent).not.toContain('Nothing here matches')
    expect(sheet().textContent).toContain('Library search is not responding')
    expect(freehand()).not.toBeNull()   // still usable: type it in by hand
  })

  it('reports a synchronous blow-up in the search too', async () => {
    listSongs.mockImplementation(() => { throw new Error('boom') })
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')

    expect(sheet().textContent).not.toContain('Searching…')
    expect(sheet().textContent).toContain('Search is not responding')
  })

  it('recovers on the next keystroke after a failed search', async () => {
    listSongs.mockRejectedValue(new Error('Network Error'))
    mountPicker()
    await wrapper.find('.picker__trigger').trigger('click')
    await search('bowie')
    expect(sheet().textContent).toContain('not responding')

    listSongs.mockResolvedValue({ data: { songs: SONGS } })
    await search('bowie h')
    expect(sheet().textContent).not.toContain('not responding')
    expect(rows()).toHaveLength(2)
  })
})
