// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The `ended` event is the whole contract between the deck and whatever is
// managing a queue — it replaced a direct rotation call inside the player.
// Three things have to hold or a consumer gets nonsense: the payload
// must describe the performance that just finished, not the zeroed deck it
// leaves behind; it must say WHY it ended, because "the song finished" and
// "the host hit Stop" mean opposite things to a queue; and it must not fire
// for a performance that never happened.
//
// The engine is faked wholesale, so what is pinned here is the EVENT — the
// payload the component builds and when it emits. The engine's own
// onEnded-before-stop() ordering is NOT covered by this file (the fake would
// keep it green either way); that lives in
// tests/composables/useAudioEngine.ended.test.js against the real composable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const engine = vi.hoisted(() => {
  const currentTime = { value: 0 }
  const duration = { value: 0 }
  return {
    currentTime,
    duration,
    // Captured when the component starts its loop, so the test can fire the
    // natural end exactly as the engine does.
    onEnded: null,
    stub: {
      currentTime,
      duration,
      playerState: { value: 'stopped' },
      keyOffset: { value: 0 },
      keyShiftSupported: { value: true },
      loadStems: vi.fn(async () => ({ durations: [215] })),
      startAnimationLoop: vi.fn(),
      // The real stop() zeroes currentTime and flips the state; a payload
      // built after this point has lost the performance.
      stop: vi.fn(() => {
        currentTime.value = 0
        engine.stub.playerState.value = 'stopped'
      }),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setKey: vi.fn(),
      setVolume: vi.fn(),
      cleanup: vi.fn(),
    },
  }
})

vi.mock('@/composables/useAudioEngine', () => ({
  useAudioEngine: () => engine.stub,
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(), get: vi.fn() },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
}))

vi.mock('@/stores/songs', () => ({
  useSongsStore: () => ({ fetchLyrics: vi.fn(async () => null) }),
}))
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ load: vi.fn(async () => {}), lyricsLookupEnabled: false }),
}))

import AudioPlayer from '@/components/AudioPlayer.vue'

const SONG = {
  id: 42,
  title: 'Heroes',
  artist: 'Bowie',
  stems: { vocals: '/v.mp3', instrumental: '/i.mp3' },
}

let wrapper = null

async function mountPlayer() {
  const w = mount(AudioPlayer, {
    props: { song: SONG },
    global: { stubs: { ProgressBar: true, LyricsEditor: true, MixerPopover: true } },
  })
  // Let loadSong() settle so the transport (and the engine loop) exist.
  await new Promise(r => setTimeout(r))
  await w.vm.$nextTick()
  return w
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  engine.stub.playerState.value = 'stopped'
  engine.stub.currentTime.value = 0
  engine.stub.duration.value = 0
  engine.stub.startAnimationLoop.mockImplementation((onTick, onEnded) => {
    engine.onEnded = onEnded
  })
  wrapper = await mountPlayer()
  // Mid-performance state, as it would be at the last frame of the track.
  engine.stub.currentTime.value = 214.5
  engine.stub.duration.value = 215
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('AudioPlayer ended', () => {
  it('reports a natural end with the position the track ended on', () => {
    engine.onEnded()

    const events = wrapper.emitted('ended')
    expect(events).toHaveLength(1)
    expect(events[0][0]).toEqual({
      songId: 42,
      reason: 'natural',
      positionSec: 214.5,
      durationSec: 215,
    })
  })

  it('builds the natural-end payload without stopping anything itself', () => {
    // The component's half of the ordering: the natural-end handler emits and
    // nothing else — stopping is the engine's job, immediately after. (That
    // the engine really does call in that order is the composable spec's
    // subject, not this one's.)
    engine.onEnded()
    expect(engine.stub.stop).not.toHaveBeenCalled()
    expect(engine.stub.currentTime.value).toBe(214.5)
  })

  it('reports a manual Stop as stopped, with the pre-stop position', async () => {
    engine.stub.playerState.value = 'playing'
    await wrapper.find('button[aria-label="Stop"]').trigger('click')

    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
    const events = wrapper.emitted('ended')
    expect(events).toHaveLength(1)
    expect(events[0][0]).toEqual({
      songId: 42,
      reason: 'stopped',
      positionSec: 214.5,
      durationSec: 215,
    })
    // ...captured before stop() ran, which zeroed the deck.
    expect(engine.stub.currentTime.value).toBe(0)
  })

  it('reports the Home-key stop the same way as the button', () => {
    engine.stub.playerState.value = 'playing'
    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Home' }))

    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('ended')[0][0]).toMatchObject({ reason: 'stopped' })
  })

  it('says nothing when Stop hits a deck that was never playing', () => {
    // Loaded but never started: Stop resets a deck that is already reset, so
    // no performance ended. `ended` is the play-history hook and an
    // unconditional emit here writes a phantom row at position 0.
    expect(engine.stub.playerState.value).toBe('stopped')
    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Home' }))

    // The reset still runs — stop() is idempotent and stays unconditional.
    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('ended')).toBeUndefined()
  })

  it('emits once for a double Stop, not twice', async () => {
    engine.stub.playerState.value = 'playing'
    const btn = wrapper.find('button[aria-label="Stop"]')
    await btn.trigger('click')
    // The real engine.stop() flipped the state to 'stopped' (the fake does the
    // same), so the second click has nothing left to end.
    await btn.trigger('click')

    expect(engine.stub.stop).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('ended')).toHaveLength(1)
  })

  it('still ends a PAUSED performance on Stop', () => {
    // Paused is banter or a mic fix, not the end — the turn is still live, so
    // Stop from here is a real ending and must report the paused position.
    engine.stub.playerState.value = 'paused'
    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Home' }))

    expect(wrapper.emitted('ended')).toHaveLength(1)
    expect(wrapper.emitted('ended')[0][0]).toMatchObject({
      reason: 'stopped',
      positionSec: 214.5,
    })
  })

  it('says nothing when the deck is torn down for a new song', async () => {
    await wrapper.setProps({ song: { ...SONG, id: 43 } })
    await new Promise(r => setTimeout(r))

    // A song change is not a performance ending. (Recorded gap: a queue that
    // wants play history has to notice this some other way.)
    expect(wrapper.emitted('ended')).toBeUndefined()
  })

  it('says nothing on unmount', () => {
    wrapper.unmount()
    const emitted = wrapper.emitted('ended')
    wrapper = null
    expect(emitted).toBeUndefined()
  })
})
