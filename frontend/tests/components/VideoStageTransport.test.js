// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// VideoStage is a follower, not a clock. The audio engine plays the track
// (extracted from this very file at import time) and this muted <video> is
// dragged along behind it: transport mirrors play/pause, and ONE drift rule
// covers seeks, a decoder that started late, and a popout remount alike.
//
// Both halves of that rule matter and they pull against each other. Too eager
// and every animation frame becomes a seek, which stalls the decoder; too lazy
// and the picture visibly lags the words. So the threshold is pinned in both
// directions here, along with the readyState-0 guard — an element with no
// metadata has no timeline, and a write to currentTime there is discarded.
//
// jsdom/happy-dom media elements do not decode anything: play/pause/load are
// stubbed and readyState/currentTime are instrumented on the instance.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import VideoStage from '@/components/VideoStage.vue'

const MediaProto = window.HTMLMediaElement.prototype
const realPlay = MediaProto.play
const realPause = MediaProto.pause
const realLoad = MediaProto.load

let play
let pause
let wrapper

// Replaces the element's clock with an observable one. `seeks` collects every
// time written to currentTime — i.e. the corrections the component performed;
// `ready()` promotes the element from "no metadata" to a real timeline.
function instrument(el, { readyState = 4, currentTime = 0 } = {}) {
  let t = currentTime
  let rs = readyState
  const seeks = []
  Object.defineProperty(el, 'readyState', { configurable: true, get: () => rs })
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => t,
    set: (v) => { t = v; seeks.push(v) },
  })
  return { seeks, ready: () => { rs = 4 } }
}

function mountStage(props = {}) {
  return mount(VideoStage, {
    props: { src: '/api/songs/1/video', currentTime: 0, playing: false, ...props },
  })
}

beforeEach(() => {
  play = vi.fn(() => Promise.resolve())
  pause = vi.fn()
  MediaProto.play = play
  MediaProto.pause = pause
  MediaProto.load = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  MediaProto.play = realPlay
  MediaProto.pause = realPause
  MediaProto.load = realLoad
})

describe('the drift rule', () => {
  it('seeks when the picture is further than the threshold behind the engine', async () => {
    wrapper = mountStage()
    const { seeks } = instrument(wrapper.find('video').element, { currentTime: 10 })

    await wrapper.setProps({ currentTime: 10.5 })

    expect(seeks).toEqual([10.5])
  })

  it('seeks when the picture has run AHEAD of the engine', async () => {
    // A seek backwards in the transport looks like this from here.
    wrapper = mountStage()
    const { seeks } = instrument(wrapper.find('video').element, { currentTime: 30 })

    await wrapper.setProps({ currentTime: 12 })

    expect(seeks).toEqual([12])
  })

  it('leaves the element alone inside the threshold', async () => {
    // 0.3s of ordinary decode jitter. Correcting this would mean seeking on
    // every animation frame, which stalls the decoder outright.
    wrapper = mountStage()
    const { seeks } = instrument(wrapper.find('video').element, { currentTime: 10 })

    await wrapper.setProps({ currentTime: 10.3 })

    expect(seeks).toEqual([])
  })

  it('does not seek an element with no metadata yet', async () => {
    // readyState 0: no timeline to seek into, the write would be discarded.
    // The loadedmetadata listener picks it up instead.
    wrapper = mountStage()
    const { seeks } = instrument(wrapper.find('video').element, { readyState: 0, currentTime: 0 })

    await wrapper.setProps({ currentTime: 42 })

    expect(seeks).toEqual([])
  })

  it('catches up on loadedmetadata once the timeline exists', async () => {
    wrapper = mountStage()
    const el = wrapper.find('video').element
    const { seeks, ready } = instrument(el, { readyState: 0, currentTime: 0 })

    // The prop moves on while the element is still loading, so the drift check
    // has nothing to write to and skips.
    await wrapper.setProps({ currentTime: 8 })
    expect(seeks).toEqual([])

    // Metadata lands: the listener is what closes the gap, with no further
    // prop change to trigger it.
    ready()
    el.dispatchEvent(new window.Event('loadedmetadata'))

    expect(seeks).toEqual([8])
  })
})

describe('the transport', () => {
  it('plays when the engine starts', async () => {
    wrapper = mountStage()
    instrument(wrapper.find('video').element)
    play.mockClear()

    await wrapper.setProps({ playing: true })

    expect(play).toHaveBeenCalledTimes(1)
  })

  it('pauses when the engine stops', async () => {
    wrapper = mountStage({ playing: true })
    instrument(wrapper.find('video').element)
    pause.mockClear()

    await wrapper.setProps({ playing: false })

    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('adopts a transport that is already running at mount', () => {
    // The projector popout remounts this component mid-song.
    wrapper = mountStage({ playing: true })
    expect(play).toHaveBeenCalled()
  })

  it('swallows a rejected play promise', async () => {
    // A src swap mid-call rejects it; an unhandled rejection during a show is
    // not acceptable.
    play.mockImplementation(() => Promise.reject(new Error('interrupted')))
    wrapper = mountStage()
    instrument(wrapper.find('video').element)

    await expect(wrapper.setProps({ playing: true })).resolves.toBeUndefined()
  })

  it('never contributes audio — the engine is already playing it', () => {
    wrapper = mountStage()
    expect(wrapper.find('video').element.muted).toBe(true)
  })
})
