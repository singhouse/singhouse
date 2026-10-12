// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library row's way into Song tools, through the row's ⋯ menu.
//
// It is offered for EVERY status on purpose: a processing song's progress and
// a failed song's error (and its retry) are the two states that most need a
// way in, and neither can be loaded onto the deck to reach a mixer. The row
// also carries the only always-visible sign that a job is running on a song
// the panel is not currently showing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  lyricsSetsApi: {},
  exportApi: { getSettings: vi.fn(), setSettings: vi.fn(), exportSong: vi.fn() },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'
import { useSongToolsStore } from '@/stores/songTools'

const LIBRARY = [
  { id: 1, title: 'Ready Song', artist: 'A', status: 'ready', created_at: '2026-08-03T00:00:00' },
  { id: 2, title: 'Busy Song', artist: 'B', status: 'processing', phase: 'separating', created_at: '2026-08-02T00:00:00' },
  { id: 3, title: 'Broken Song', artist: 'C', status: 'failed', created_at: '2026-08-01T00:00:00' },
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
async function openRowMenu(i) {
  const btn = wrapper.findAll('.song-item .more-btn')[i]
  await btn.trigger('click')
  await flushPromises()
  return document.getElementById(btn.attributes('aria-controls'))
}

async function pickTools(i) {
  const panel = await openRowMenu(i)
  panel.querySelector('.row-menu__tools').click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  listSongs.mockResolvedValue({ data: { songs: [] } })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('the row’s Song tools action', () => {
  it('is offered for ready, processing AND failed songs alike', async () => {
    wrapper = await mountList()
    for (const i of [0, 1, 2]) {
      const panel = await openRowMenu(i)
      expect(panel.querySelector('.row-menu__tools')).not.toBeNull()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()
    }
  })

  it('opens the panel on that song without loading it onto the deck', async () => {
    wrapper = await mountList()
    const songs = useSongsStore()
    const tools = useSongToolsStore()
    const loadSong = vi.spyOn(songs, 'loadSong')

    // The failed row: it cannot be played at all, which is exactly why the
    // panel has to be reachable from here.
    await pickTools(2)

    expect(tools.songId).toBe(3)
    expect(loadSong).not.toHaveBeenCalled()
  })

  it('closes again when the same row is clicked twice', async () => {
    wrapper = await mountList()
    const tools = useSongToolsStore()

    await pickTools(0)
    expect(tools.songId).toBe(1)
    await pickTools(0)
    expect(tools.songId).toBeNull()
  })

  it('re-points at another song rather than closing', async () => {
    wrapper = await mountList()
    const tools = useSongToolsStore()

    await pickTools(0)
    await pickTools(1)

    expect(tools.songId).toBe(2)
  })
})

describe('the row’s job mark', () => {
  it('shows nothing when no job has run', async () => {
    wrapper = await mountList()
    expect(wrapper.findAll('.song-item__job')).toHaveLength(0)
  })

  it('spins on the song whose job is in flight, and only that one', async () => {
    wrapper = await mountList()
    const songs = useSongsStore()
    songs.activeJobs = { 2: { kind: 'transcribe', status: 'running', phase: 'transcribing' } }
    await flushPromises()

    const marks = wrapper.findAll('.song-item__job')
    expect(marks).toHaveLength(1)
    expect(marks[0].attributes('title')).toContain('Listen again')
    expect(marks[0].find('.spinner').exists()).toBe(true)
  })

  it('marks the last job’s failure with its reason', async () => {
    wrapper = await mountList()
    const songs = useSongsStore()
    songs.activeJobs = {
      3: { kind: 'retry', status: 'failed', error: 'the source audio is gone' },
    }
    await flushPromises()

    const mark = wrapper.find('.song-item__job')
    expect(mark.classes()).toContain('song-item__job--failed')
    expect(mark.text()).toContain('✗')
    expect(mark.attributes('title')).toContain('the source audio is gone')
  })

  it('goes quiet once a job has finished well', async () => {
    wrapper = await mountList()
    const songs = useSongsStore()
    songs.activeJobs = { 1: { kind: 'realign', status: 'done', message: 'Finished' } }
    await flushPromises()

    expect(wrapper.findAll('.song-item__job')).toHaveLength(0)
  })
})
