// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Song ends, host clicks Advance, host presses Space. While the advance is in
// flight the deck still holds the OUTGOING song; Space must arm the incoming
// singer's song to play once loaded, and never replay the outgoing one. The
// shell (with a fake queue provider) and the real player are mounted
// together; only the audio engine is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'

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
vi.mock('@/composables/useAudioEngine', () => ({ useAudioEngine: () => engine.stub }))

const SONGS = {
  1: { id: 1, title: 'Outgoing Tune', artist: 'A', status: 'ready', stems: { instrumental: '/1.mp3' } },
  2: { id: 2, title: 'Incoming Tune', artist: 'B', status: 'ready', stems: { instrumental: '/2.mp3' } },
}
vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    list: vi.fn(async () => ({ data: { songs: [] } })),
    get: vi.fn(async (id) => ({ data: { ...SONGS[id] } })),
  },
  queueApi: { list: vi.fn(async () => ({ data: { entries: [] } })) },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  sessionApi: {
    config: vi.fn(async () => ({ data: {} })),
    me: vi.fn(async () => ({ data: {} })),
  },
}))
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ load: vi.fn(async () => {}), lyricsLookupEnabled: false }),
}))
vi.mock('@/composables/useLyricsWindow', () => ({
  useLyricsWindow: () => ({ isOpen: ref(false), open: vi.fn(), close: vi.fn() }),
  getScreens: vi.fn(async () => ({ screens: [], primary: null })),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), hasRoute: () => false }),
}))

const provider = vi.hoisted(() => ({ registered: null }))
vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'queue-provider' ? provider.registered : null),
  slotHasContent: (name) => name === 'queue-provider' && !!provider.registered,
  registerSlot: vi.fn(),
}))

import HostShell from '@/views/HostShell.vue'
import { usePlayGuard } from '@/composables/usePlayGuard'

const pick = ref(null)
const advancing = ref(false)
let wrapper = null

function mountShell() {
  return mount(HostShell, {
    attachTo: document.body,
    global: {
      stubs: {
        QueuePanel: true,
        ScreenStage: true,
        SongList: { template: '<div class="song-list-stub" />' },
        ProgressBar: true,
        teleport: true,
        UploadZone: true,
        Modal: true,
        BrandLogo: true,
        BrandMark: true,
        'router-link': true,
      },
    },
  })
}

function pressSpace() {
  const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
  document.body.dispatchEvent(ev)
  document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true }))
  return ev
}

const pill = () => document.querySelector('.bar__armed')

// The outgoing singer's song is loaded and has just finished.
async function outgoingSongEnded() {
  wrapper = mountShell()
  await flushPromises()
  pick.value = { key: 'e1', songId: 1 }
  await flushPromises()
  expect(wrapper.vm.store.currentSong?.id).toBe(1)
  engine.stub.playerState.value = 'stopped'
  wrapper.vm.player.setPlayState('stopped')
  await flushPromises()
  vi.clearAllMocks()
}

beforeEach(() => {
  setActivePinia(createPinia())
  pick.value = null
  advancing.value = false
  engine.stub.playerState.value = 'stopped'
  engine.stub.loadStems.mockImplementation(async () => ({ durations: [180] }))
  provider.registered = {
    panel: { template: '<div class="provider-panel" />' },
    useCurrent: () => computed(() => pick.value),
    useAdvancing: () => computed(() => advancing.value),
    onSongEnded: vi.fn(),
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  vi.useRealTimers()
  usePlayGuard().cancel()
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Space while a queue advance is in flight', () => {
  it('arms, then plays the incoming singer\'s song once it is ready', async () => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()

    expect(pressSpace().defaultPrevented).toBe(true)
    await flushPromises()
    expect(engine.stub.play).not.toHaveBeenCalled()      // not the outgoing song
    expect(pill()?.textContent).toContain('Plays when loaded')

    let finishStems
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((r) => { finishStems = r }))
    const playedSong = []
    engine.stub.play.mockImplementation(() => { playedSong.push(wrapper.vm.store.currentSong?.id) })

    // The advance lands: a new singer with a linked song.
    pick.value = { key: 'e2', songId: 2 }
    advancing.value = false
    await flushPromises()
    expect(wrapper.vm.store.currentSong.id).toBe(2)
    expect(engine.stub.play).not.toHaveBeenCalled()      // still loading
    expect(pill()).not.toBe(null)

    finishStems({ durations: [200] })
    await flushPromises()
    expect(playedSong).toEqual([2])
    expect(pill()).toBe(null)
  })

  it('also when the provider reports the new pick just after dropping its flag', async () => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()
    pressSpace()
    advancing.value = false
    await flushPromises()
    expect(pill()).not.toBe(null)                        // still waiting
    pick.value = { key: 'e2', songId: 2 }
    await flushPromises()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.store.currentSong.id).toBe(2)
  })

  it('releases the advance as soon as a late pick lands, so the next Space plays', async () => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()
    advancing.value = false              // flag drops first, pick not in yet
    await flushPromises()
    expect(wrapper.vm.player.advancePending).toBe(true)
    pick.value = { key: 'e2', songId: 2 }
    await flushPromises()                // well inside the 1.5 s grace
    expect(wrapper.vm.player.advancePending).toBe(false)
    expect(wrapper.vm.store.currentSong.id).toBe(2)
    pressSpace()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(pill()).toBe(null)
  })

  it('a failed advance clears the arm and never replays the outgoing song', async () => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()
    pressSpace()
    await flushPromises()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    advancing.value = false                              // nothing changed: it failed
    await wrapper.vm.$nextTick()
    vi.advanceTimersByTime(2000)
    vi.useRealTimers()
    await flushPromises()
    expect(pill()).toBe(null)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(wrapper.vm.store.currentSong.id).toBe(1)
  })

  it.each([
    ['a new singer with no linked song', { key: 'e2', songId: null, label: 'Sam' }],
    ['the queue running out', null],
  ])('%s clears the arm', async (_, landed) => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()
    pressSpace()
    pick.value = landed
    advancing.value = false
    await flushPromises()
    expect(pill()).toBe(null)
    expect(engine.stub.play).not.toHaveBeenCalled()
    // And a later Space is ordinary again (plays what is loaded, on purpose).
    pressSpace()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })

  it('a second Space before the advance lands cancels', async () => {
    await outgoingSongEnded()
    advancing.value = true
    await flushPromises()
    pressSpace()
    pressSpace()
    await flushPromises()
    expect(pill()).toBe(null)
    pick.value = { key: 'e2', songId: 2 }
    advancing.value = false
    await flushPromises()
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('does not resume a paused outgoing song', async () => {
    await outgoingSongEnded()
    engine.stub.playerState.value = 'paused'
    wrapper.vm.player.setPlayState('paused')
    advancing.value = true
    await flushPromises()
    pressSpace()
    expect(engine.stub.play).not.toHaveBeenCalled()
    pick.value = { key: 'e2', songId: 2 }
    advancing.value = false
    await flushPromises()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.store.currentSong.id).toBe(2)
  })

  it('still asks before pausing an outgoing song that is playing', async () => {
    await outgoingSongEnded()
    engine.stub.playerState.value = 'playing'
    wrapper.vm.player.setPlayState('playing')
    advancing.value = true
    await flushPromises()
    pressSpace()
    await flushPromises()
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'pause' })
    expect(pill()).toBe(null)
    expect(engine.stub.pause).not.toHaveBeenCalled()
  })
})
