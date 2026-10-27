// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library and the deck together: clicking a song row must not trap the
// deck's keys in the list, while a row the keyboard is walking keeps them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const engine = vi.hoisted(() => ({
  stub: {
    currentTime: { value: 0 },
    duration: { value: 0 },
    playerState: { value: 'stopped' },
    keyOffset: { value: 0 },
    keyShiftSupported: { value: true },
    loadStems: vi.fn(async () => ({ durations: [180] })),
    startAnimationLoop: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setKey: vi.fn(),
    setVolume: vi.fn(),
    cleanup: vi.fn(),
  },
}))

vi.mock('@/composables/useAudioEngine', () => ({
  useAudioEngine: () => engine.stub,
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })), get: vi.fn(), delete: vi.fn() },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  exportApi: { getSettings: vi.fn(), setSettings: vi.fn(), exportSong: vi.fn() },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ load: vi.fn(async () => {}), lyricsLookupEnabled: false }),
}))

import SongList from '@/components/SongList.vue'
import AudioPlayer from '@/components/AudioPlayer.vue'
import { useSongsStore } from '@/stores/songs'
import { usePlayGuard } from '@/composables/usePlayGuard'

const LIBRARY = [
  { id: 1, title: 'Alpha Test Tune', artist: 'A', status: 'ready', created_at: '2026-08-03T00:00:00',
    stems: { instrumental: '/a.mp3' } },
  { id: 2, title: 'Beta Test Tune', artist: 'B', status: 'ready', created_at: '2026-08-02T00:00:00',
    stems: { instrumental: '/b.mp3' } },
]

let list = null
let deck = null
let store = null
let loadSpy = null

async function mountBoth() {
  list = mount(SongList, { attachTo: document.body })
  store = useSongsStore()
  store.songs = LIBRARY.map(s => ({ ...s }))
  store.loading = false
  loadSpy = vi.spyOn(store, 'loadSong').mockImplementation(() => {})
  deck = mount(AudioPlayer, {
    props: { song: LIBRARY[0] },
    attachTo: document.body,
    global: { stubs: { ProgressBar: true } },
  })
  await flushPromises()
  engine.stub.currentTime.value = 60   // the load zeroes it
}

const row = (title) => [...document.querySelectorAll('.song-item')].find(r => r.textContent.includes(title))

function key(code, init = {}) {
  const k = { Space: ' ' }[code] ?? code
  const ev = new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...init })
  document.activeElement.dispatchEvent(ev)
  return ev
}

async function clickRow(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  el.focus()
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
  el.click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  engine.stub.playerState.value = 'stopped'
})

afterEach(() => {
  usePlayGuard().cancel()
  deck?.unmount()
  list?.unmount()
  deck = list = null
  document.body.innerHTML = ''
})

describe('after a pointer click on a library row', () => {
  it('Space plays, ←/→ seek and Home stops', async () => {
    await mountBoth()
    await clickRow(row('Beta'))
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(row('Beta'))

    expect(key('Space').defaultPrevented).toBe(true)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)          // the row did not reload

    key('ArrowLeft')
    key('ArrowRight')
    expect(engine.stub.seek.mock.calls).toEqual([[55], [65]])
    expect(document.activeElement).toBe(row('Beta'))  // → did not go to ⋯

    key('Home')
    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(row('Beta'))  // Home did not move rows
  })

  it('Space while playing still asks before pausing', async () => {
    await mountBoth()
    await clickRow(row('Alpha'))
    engine.stub.playerState.value = 'playing'
    const { usePlayerStore } = await import('@/stores/player')
    usePlayerStore().setPlayState('playing')
    key('Space')
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'pause' })
    expect(engine.stub.pause).not.toHaveBeenCalled()
  })
})

describe('a keyboard-focused library row', () => {
  it('keeps row navigation and Enter loads, without the deck acting', async () => {
    await mountBoth()
    row('Alpha').focus()
    await flushPromises()
    key('ArrowDown')
    await flushPromises()
    expect(document.activeElement).toBe(row('Beta'))
    key('Home')
    await flushPromises()
    expect(document.activeElement).toBe(row('Alpha'))
    key('ArrowLeft')
    key('Enter')
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(engine.stub.seek).not.toHaveBeenCalled()
    expect(engine.stub.stop).not.toHaveBeenCalled()

    // Space is still the deck's, even here.
    key('Space')
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })
})
