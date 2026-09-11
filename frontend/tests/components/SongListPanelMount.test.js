// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract test for core SongList's neutral 'library-panel' mount.
// An installed package (premium's LibraryPanel in real builds) registers a
// component under that slot; core must render it, feed it the live query,
// and refetch the library when it announces a change. This pins the seam so
// core refactors cannot silently break an out-of-tree-registered panel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
}))

const PanelStub = vi.hoisted(() => ({
  name: 'PanelStub',
  props: { query: { type: String, default: '' } },
  emits: ['library-changed'],
  template: '<div class="panel-stub">panel:{{ query }}</div>',
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'library-panel' ? PanelStub : null),
  registerSlot: vi.fn(),
  slotHasContent: (name) => name === 'library-panel',
}))

import SongList from '@/components/SongList.vue'

let wrapper = null

beforeEach(() => {
  setActivePinia(createPinia())
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: [] } })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('the library-panel mount', () => {
  it('renders a registered panel', () => {
    wrapper = mount(SongList)
    expect(wrapper.find('.panel-stub').exists()).toBe(true)
  })

  it('feeds the panel the live search query', async () => {
    wrapper = mount(SongList)
    await wrapper.find('.search-input').setValue('bowie')
    expect(wrapper.find('.panel-stub').text()).toBe('panel:bowie')
  })

  it('refetches the library with the current query on library-changed', async () => {
    wrapper = mount(SongList)
    await wrapper.find('.search-input').setValue('bowie')
    listSongs.mockClear()

    wrapper.findComponent(PanelStub).vm.$emit('library-changed')
    await wrapper.vm.$nextTick()

    expect(listSongs).toHaveBeenCalledTimes(1)
    expect(listSongs.mock.calls[0][0]).toMatchObject({ search: 'bowie' })
  })
})
