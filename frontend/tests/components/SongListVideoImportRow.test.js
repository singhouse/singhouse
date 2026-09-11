// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// What a library row says while a karaoke video is being imported, and after.
// The phase map is the only thing standing between the host and a raw
// server-side phase token: an unmapped phase falls through as-is, so
// `importing` read as lowercase `importing` in the row while the upload card
// above it said "Importing" for the same file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

let wrapper = null

async function mountWith(songs) {
  const w = mount(SongList)
  const store = useSongsStore()
  store.songs = [...songs]
  store.loading = false
  await w.vm.$nextTick()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  localStorage.clear()
})

describe('a video import in progress', () => {
  it('reads "Importing", not the raw phase token', async () => {
    wrapper = await mountWith([
      { id: 1, title: 'Own Recording', artist: 'The Host', status: 'processing', phase: 'importing', has_video: true },
    ])
    expect(wrapper.find('.song-item__phase').text()).toBe('Importing')
  })

  it('says the same thing in the status badge', async () => {
    // The status column is off by default; switch it on the way a host does.
    localStorage.setItem('karaoke:libraryColumns', JSON.stringify(['title', 'artist', 'status']))
    wrapper = await mountWith([
      { id: 1, title: 'Own Recording', artist: 'The Host', status: 'processing', phase: 'importing', has_video: true },
    ])
    expect(wrapper.find('.lib-cell--status').text()).toContain('Importing')
  })
})

describe('the video mark', () => {
  it('marks a song that plays its own picture', async () => {
    wrapper = await mountWith([
      { id: 1, title: 'Own Recording', artist: 'The Host', status: 'ready', has_video: true },
    ])
    expect(wrapper.find('.song-item__video-mark').exists()).toBe(true)
  })

  it('leaves an ordinary song unmarked', async () => {
    wrapper = await mountWith([
      { id: 2, title: 'Ordinary Song', artist: 'The Host', status: 'ready' },
    ])
    expect(wrapper.find('.song-item__video-mark').exists()).toBe(false)
  })
})
