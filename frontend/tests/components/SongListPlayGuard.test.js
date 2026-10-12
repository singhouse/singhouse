// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A library row click over a playing song asks first; the confirmation itself
// belongs to the shell, so these tests answer it through the shared guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'

const PLAYING = { id: 1, title: 'Synthetic Opener', artist: 'Test Artist', status: 'ready' }
const NEXT = { id: 2, title: 'Synthetic Tune', artist: 'Test Artist', status: 'ready' }

let wrapper = null
let store = null
let loadSong = null

async function mountList() {
  wrapper = mount(SongList, { global: { stubs: { teleport: true } } })
  store = useSongsStore()
  store.songs = [PLAYING, NEXT]
  store.loading = false
  store.currentSong = PLAYING
  loadSong = vi.spyOn(store, 'loadSong').mockResolvedValue(undefined)
  await wrapper.vm.$nextTick()
}

function rowFor(title) {
  return wrapper.findAll('.song-item').find(r => r.text().includes(title))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

afterEach(() => {
  usePlayGuard().cancel()
  wrapper?.unmount()
  wrapper = null
})

describe('library row load while a song is playing', () => {
  it('asks first and loads only once confirmed', async () => {
    await mountList()
    usePlayerStore().setPlayState('playing')

    await rowFor('Synthetic Tune').trigger('click')
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'load', title: 'Synthetic Tune' })
    expect(loadSong).not.toHaveBeenCalled()

    usePlayGuard().confirm()
    await flushPromises()
    expect(loadSong).toHaveBeenCalledWith(NEXT)
  })

  it('Cancel leaves the current song playing', async () => {
    await mountList()
    const player = usePlayerStore()
    player.setPlayState('playing')

    await rowFor('Synthetic Tune').trigger('click')
    usePlayGuard().cancel()
    await flushPromises()
    expect(loadSong).not.toHaveBeenCalled()
    expect(store.currentSong).toEqual(PLAYING)
    expect(player.playState).toBe('playing')
  })

  it.each(['paused', 'stopped'])('loads without asking while %s', async (state) => {
    await mountList()
    usePlayerStore().setPlayState(state)

    await rowFor('Synthetic Tune').trigger('click')
    expect(usePlayGuard().pending.value).toBe(null)
    expect(loadSong).toHaveBeenCalledWith(NEXT)
  })
})
