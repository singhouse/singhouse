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
import { songApi } from '@/api/client'
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

// Nothing loaded yet (a fresh page): the player is not mounted while the first
// song's details are fetched, so the shell takes Space for it.
describe('Space before any song has reached the deck', () => {
  function heldFetch() {
    let release
    songApi.get.mockImplementationOnce((id) => new Promise((r) => {
      release = () => r({ data: { ...SONGS[id] } })
    }))
    return () => release()
  }
  function heldStems() {
    let release
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((r) => { release = () => r({ durations: [180] }) }))
    return () => release()
  }
  async function freshShell() {
    wrapper = mountShell()
    await flushPromises()
    expect(document.querySelector('.player-bar')).toBe(null)
    vi.clearAllMocks()
  }

  it('the first library song plays once ready when Space comes before the player exists', async () => {
    await freshShell()
    const finishFetch = heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })          // what a row click does
    expect(pressSpace().defaultPrevented).toBe(true)
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: 2 })

    const finishStems = heldStems()
    finishFetch()
    await flushPromises()
    expect(document.querySelector('.player-bar')).not.toBe(null)
    expect(wrapper.vm.player.pendingPlay).toBe(null)   // adopted
    expect(pill()?.textContent).toContain('Plays when loaded')
    expect(engine.stub.play).not.toHaveBeenCalled()

    finishStems()
    await flushPromises()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.store.currentSong.id).toBe(2)
    expect(pill()).toBe(null)
  })

  it('a second Space before the player exists cancels it', async () => {
    await freshShell()
    const finishFetch = heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: 2 })
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toBe(null)
    finishFetch()
    await flushPromises()
    expect(pill()).toBe(null)
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('a different song on its way clears it', async () => {
    await freshShell()
    const finishFirst = heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: 2 })
    const finishSecond = heldFetch()
    wrapper.vm.store.loadSong({ id: 1 })
    await flushPromises()
    expect(wrapper.vm.player.pendingPlay).toBe(null)
    finishFirst()
    finishSecond()
    await flushPromises()
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('the first singer\'s advance plays their song once ready', async () => {
    await freshShell()
    advancing.value = true
    await flushPromises()
    expect(pressSpace().defaultPrevented).toBe(true)
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: null, advance: true })

    const finishFetch = heldFetch()
    pick.value = { key: 'e1', songId: 2 }
    advancing.value = false
    await flushPromises()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: 2 })
    const finishStems = heldStems()
    finishFetch()
    await flushPromises()
    expect(pill()).not.toBe(null)
    finishStems()
    await flushPromises()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.store.currentSong.id).toBe(2)
  })

  it('a songless first singer clears the first-singer request', async () => {
    await freshShell()
    advancing.value = true
    await flushPromises()
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: null, advance: true })
    pick.value = { key: 'e1', songId: null }
    advancing.value = false
    await flushPromises()
    expect(wrapper.vm.player.pendingPlay).toBe(null)
  })

  // An advance that leaves an empty queue empty changes nothing either, so it
  // reads the same as this one.
  it('a failed first advance clears it after the grace period', async () => {
    await freshShell()
    advancing.value = true
    await flushPromises()
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: null, advance: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    advancing.value = false
    await wrapper.vm.$nextTick()
    vi.advanceTimersByTime(2000)
    vi.useRealTimers()
    await flushPromises()
    expect(wrapper.vm.player.pendingPlay).toBe(null)
  })

  it('with nothing on its way still takes Space from a focused button, recording nothing', async () => {
    await freshShell()
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    const down = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    btn.dispatchEvent(down)
    const up = new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    btn.dispatchEvent(up)
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)        // the button is not pressed
    expect(wrapper.vm.player.pendingPlay).toBe(null)
  })

  it('leaves Space to a text field', async () => {
    await freshShell()
    wrapper.vm.store.loadSong({ id: 2 })
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    field.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(wrapper.vm.player.pendingPlay).toBe(null)
    await flushPromises()
  })

  it('swallows the keyup so a focused Advance button is not pressed again', async () => {
    await freshShell()
    advancing.value = true
    await flushPromises()
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    const down = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    btn.dispatchEvent(down)
    const up = new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    btn.dispatchEvent(up)
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
  })

  it('once the player is mounted, the shell leaves Space to it even with a song on its way', async () => {
    await outgoingSongEnded()
    const finishFetch = heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })      // incoming, with a deck mounted
    expect(pressSpace().defaultPrevented).toBe(true)
    await flushPromises()
    expect(wrapper.vm.player.pendingPlay).toBe(null)   // the shell recorded nothing
    expect(pill()).not.toBe(null)                      // the player armed
    pressSpace()                                       // handled once: cancels
    await flushPromises()
    expect(pill()).toBe(null)
    expect(wrapper.vm.player.pendingPlay).toBe(null)
    finishFetch()
    await flushPromises()
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('with song 1 in the deck: click song 2, click song 1 back, Space plays song 1 now', async () => {
    await outgoingSongEnded()
    pick.value = null
    await flushPromises()
    const late = heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })
    const back = heldFetch()
    wrapper.vm.store.loadSong({ id: 1 })
    await flushPromises()
    pressSpace()
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    back()
    await flushPromises()
    late()
    await flushPromises()
    expect(wrapper.vm.store.currentSong.id).toBe(1)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })

  it('clears a recorded request when the shell unmounts', async () => {
    await freshShell()
    heldFetch()
    wrapper.vm.store.loadSong({ id: 2 })
    pressSpace()
    const player = wrapper.vm.player
    expect(player.pendingPlay).toEqual({ songId: 2 })
    wrapper.unmount()
    wrapper = null
    expect(player.pendingPlay).toBe(null)
  })

  it.each([
    ['the earlier answer arrives first', ['first', 'second']],
    ['the earlier answer arrives last', ['second', 'first']],
  ])('click song 2, click song 1, Space: song 1 plays (%s)', async (_, order) => {
    await freshShell()
    const answers = { first: heldFetch() }
    wrapper.vm.store.loadSong({ id: 2 })
    answers.second = heldFetch()
    wrapper.vm.store.loadSong({ id: 1 })
    pressSpace()
    expect(wrapper.vm.player.pendingPlay).toEqual({ songId: 1 })
    const played = []
    engine.stub.play.mockImplementation(() => { played.push(wrapper.vm.store.currentSong?.id) })
    for (const k of order) { answers[k](); await flushPromises() }
    expect(wrapper.vm.store.currentSong.id).toBe(1)
    expect(played).toEqual([1])
  })

  it.each([
    ['the earlier answer arrives first', ['first', 'second']],
    ['the earlier answer arrives last', ['second', 'first']],
  ])('with a deck: click song 2, click song 3, Space: song 3 plays (%s)', async (_, order) => {
    await outgoingSongEnded()                   // song 1 is in the deck, stopped
    pick.value = null
    await flushPromises()
    const answers = { first: heldFetch() }
    wrapper.vm.store.loadSong({ id: 2 })
    answers.second = heldFetch()
    SONGS[3] = { id: 3, title: 'Third Tune', artist: 'C', status: 'ready', stems: { instrumental: '/3.mp3' } }
    wrapper.vm.store.loadSong({ id: 3 })
    pressSpace()
    await flushPromises()
    expect(pill()).not.toBe(null)
    const played = []
    engine.stub.play.mockImplementation(() => { played.push(wrapper.vm.store.currentSong?.id) })
    for (const k of order) { answers[k](); await flushPromises() }
    expect(wrapper.vm.store.currentSong.id).toBe(3)
    expect(played).toEqual([3])
    delete SONGS[3]
  })
})
