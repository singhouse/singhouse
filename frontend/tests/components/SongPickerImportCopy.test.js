// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Pins the import vocabulary on SongPicker's host-mode catalog rows: the button
// says "Import", and "Download" appears nowhere. This copy is legally
// load-bearing — a revert that re-introduces Download-verb copy must
// fail the suite, not slide through. Lives apart from SongPicker.test.js
// because that file mocks the catalog slot away entirely.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const listSongs = vi.fn()
const searchCatalog = vi.fn()

vi.mock('@/api/client', () => ({
  songApi: { list: (...a) => listSongs(...a) },
}))
vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'catalog'
    ? { searchCatalog: (...a) => searchCatalog(...a), importCatalog: vi.fn() }
    : null),
}))

import SongPicker from '@/components/SongPicker.vue'

let wrapper = null

beforeEach(() => {
  vi.useFakeTimers()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  searchCatalog.mockResolvedValue([{
    provider: 'testcat',
    providerLabel: 'Test Source',
    providerIcon: '🎵',
    external_id: '101',
    title: 'Heroes',
    artist: 'Bowie',
  }])
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('host-mode catalog rows', () => {
  it('offer Import — never Download', async () => {
    wrapper = mount(SongPicker, { props: { mode: 'host' }, attachTo: document.body })
    await wrapper.find('.picker__trigger').trigger('click')

    const input = document.body.querySelector('.sheet__input')
    input.value = 'bowie'
    await input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)

    const btn = document.body.querySelector('.sheet__dl')
    expect(btn).not.toBeNull()
    expect(btn.textContent.trim()).toBe('Import')
    expect(document.body.querySelector('.sheet').textContent).not.toMatch(/download/i)
  })
})
