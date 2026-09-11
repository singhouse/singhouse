// SPDX-License-Identifier: AGPL-3.0-only
// The natural-end ordering inside the REAL engine: onEnded() runs while the
// deck is still live, stop() runs after (the queue provider that
// consumes this is a package core knows nothing about, so the guarantee has to
// hold here rather than in whoever happens to be listening).
//
// AudioPlayer's spec (tests/components/AudioPlayerEnded.test.js) stubs the
// engine wholesale, so it pins the EVENT payload and can say nothing about
// this ordering — flipping the two lines below leaves it green. These cases
// are the ones that fail.
//
// No AudioContext anywhere: the natural-end path in startAnimationLoop only
// reads the media elements and the transport refs, and the composable exposes
// `audioElements` by reference, so a fake element in the `inst` slot drives it
// exactly as a loaded stem would. Only initContext()/loadStems() need Web
// Audio, and neither is called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioEngine } from '@/composables/useAudioEngine.js'

// Minimal stand-in for the HTMLMediaElement the engine drives: a settable
// currentTime (stop() zeroes it) and a pause() it calls on the way down.
function fakeStem(atTime) {
  return { currentTime: atTime, pause: vi.fn() }
}

let frames = []

function runNextFrame() {
  const cb = frames.shift()
  if (!cb) throw new Error('no animation frame was scheduled')
  cb()
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', cb => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// A deck one frame away from the end of a 215s track: past the
// `duration - 0.1` threshold the tick treats as "finished".
function engineAtEndOfTrack() {
  const engine = useAudioEngine()
  engine.audioElements.inst = fakeStem(214.95)
  engine.duration.value = 215
  engine.playerState.value = 'playing'
  return engine
}

describe('useAudioEngine natural end', () => {
  it('calls onEnded while the deck is still playing and still positioned', () => {
    const engine = engineAtEndOfTrack()
    const seen = []

    engine.startAnimationLoop(null, () => {
      // This is the whole contract: a listener building a play-history row, or
      // deciding whether to advance a queue, reads the performance that just
      // finished — not the zeroed deck stop() is about to leave behind.
      seen.push({
        playerState: engine.playerState.value,
        currentTime: engine.currentTime.value,
      })
    })
    runNextFrame()

    expect(seen).toHaveLength(1)
    expect(seen[0].playerState).toBe('playing')
    expect(seen[0].currentTime).toBeGreaterThan(0)
    expect(seen[0].currentTime).toBeCloseTo(214.95, 2)
  })

  it('stops the deck after the listener has run', () => {
    const engine = engineAtEndOfTrack()
    const stem = engine.audioElements.inst

    engine.startAnimationLoop(null, vi.fn())
    runNextFrame()

    expect(engine.playerState.value).toBe('stopped')
    expect(engine.currentTime.value).toBe(0)
    expect(stem.pause).toHaveBeenCalledTimes(1)
    expect(stem.currentTime).toBe(0)
  })

  it('ends exactly once and schedules no further frame', () => {
    const engine = engineAtEndOfTrack()
    const onEnded = vi.fn()

    engine.startAnimationLoop(null, onEnded)
    runNextFrame()

    expect(onEnded).toHaveBeenCalledTimes(1)
    // The tick returns without re-arming, so the end cannot fire twice and the
    // loop does not spin on a stopped deck.
    expect(frames).toHaveLength(0)
  })

  it('stops the deck even when the listener throws', () => {
    const engine = engineAtEndOfTrack()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    engine.startAnimationLoop(null, () => { throw new Error('listener blew up') })

    // A throwing listener must not wedge the transport: without the catch the
    // throw escapes the tick, stop() never runs, and the deck reports
    // 'playing' forever with no frame scheduled to fix it.
    expect(() => runNextFrame()).not.toThrow()
    expect(engine.playerState.value).toBe('stopped')
  })

  it('does not end a deck that has not reached the threshold', () => {
    const engine = useAudioEngine()
    engine.audioElements.inst = fakeStem(100)
    engine.duration.value = 215
    engine.playerState.value = 'playing'
    const onEnded = vi.fn()

    engine.startAnimationLoop(null, onEnded)
    runNextFrame()

    expect(onEnded).not.toHaveBeenCalled()
    expect(engine.playerState.value).toBe('playing')
    expect(frames).toHaveLength(1)
  })

  // The natural-end branch tears the rAF loop down (see the test above:
  // no frame is scheduled once a deck ends). startAnimationLoop is otherwise
  // called only once, at song load, so without a re-arm the NEXT Play flips
  // state back to 'playing' but nothing advances the transport clock — the deck
  // freezes at 0:00 until a hard reload. In core-only / auto-advance-off there
  // is no queue advance (which would reload a song and re-arm the loop) to mask
  // it. play() must restart the loop itself.
  // Hardening — the play() re-arm trusts "animFrame == null iff the loop is
  // dead". A throwing onTick (the time-update listener) must not escape tick()
  // before the reschedule, or the loop would die mid-play with animFrame still
  // holding a fired id — an undetectable frozen deck. The catch keeps the loop
  // alive and the invariant total; mirrors the onEnded contract.
  it('keeps the loop alive when the onTick listener throws mid-play', () => {
    const engine = useAudioEngine()
    engine.audioElements.inst = fakeStem(100)
    engine.duration.value = 215
    engine.playerState.value = 'playing'
    vi.spyOn(console, 'error').mockImplementation(() => {})

    engine.startAnimationLoop(() => { throw new Error('time-update blew up') }, vi.fn())

    // Mid-play (well short of the end), a throwing onTick must not wedge the
    // transport: the tick swallows it and still schedules the next frame.
    expect(() => runNextFrame()).not.toThrow()
    expect(engine.playerState.value).toBe('playing')
    expect(frames).toHaveLength(1)
  })

  it('re-arms the loop on the next play() after a natural end', async () => {
    const engine = engineAtEndOfTrack()
    const stem = engine.audioElements.inst
    stem.play = vi.fn(() => Promise.resolve())
    const onTick = vi.fn()

    engine.startAnimationLoop(onTick, vi.fn())
    runNextFrame()

    // Precondition: the end fired, the deck stopped, and the loop is dead.
    expect(engine.playerState.value).toBe('stopped')
    expect(frames).toHaveLength(0)

    // Press Play again from the top. The fix re-arms the torn-down loop.
    onTick.mockClear()
    stem.currentTime = 0
    await engine.play(0)

    expect(engine.playerState.value).toBe('playing')
    expect(frames).toHaveLength(1)   // a frame is scheduled again — loop alive

    // And ticking now actually advances the transport clock instead of the
    // frozen-at-0:00 deck the bug left behind.
    stem.currentTime = 1.0
    runNextFrame()
    expect(onTick).toHaveBeenCalled()
    expect(engine.currentTime.value).toBeGreaterThan(0)
  })
})
