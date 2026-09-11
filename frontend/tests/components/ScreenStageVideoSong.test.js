// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Which display a song gets. A song imported with its own karaoke video has
// its lyrics burned into the picture, so the video replaces the canvas rather
// than sitting behind it — drawing a stage model on top would double the
// words. Every other song keeps the canvas, which is the only lyric renderer
// there is.
//
// Also pins the popout-safe form of the video src. The projector window's
// document is `about:blank`; a root-relative src there resolves only through
// about-blank base-url inheritance, which nothing else in this app depends on.
// The computed hands the element an absolute url instead.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/stage/frame.mjs', () => ({ describeFrame: vi.fn(() => ({ pages: [] })) }))
vi.mock('@/stage/draw.mjs', () => ({ drawFrame: vi.fn() }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
  lyricsSetsApi: {},
}))

import ScreenStage from '@/components/ScreenStage.vue'
import VideoStage from '@/components/VideoStage.vue'
import { useSongsStore } from '@/stores/songs'
import { usePlayerStore } from '@/stores/player'

const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realRaf = window.requestAnimationFrame
const realCancelRaf = window.cancelAnimationFrame
const MediaProto = window.HTMLMediaElement.prototype
const realPlay = MediaProto.play
const realPause = MediaProto.pause
const realLoad = MediaProto.load

let wrapper = null

beforeEach(() => {
  setActivePinia(createPinia())

  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  }))
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  vi.stubGlobal('ResizeObserver', window.ResizeObserver)
  window.requestAnimationFrame = vi.fn(() => 1)
  window.cancelAnimationFrame = vi.fn()

  // No decoder in happy-dom; the video element's transport calls are inert.
  MediaProto.play = vi.fn(() => Promise.resolve())
  MediaProto.pause = vi.fn()
  MediaProto.load = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  MediaProto.play = realPlay
  MediaProto.pause = realPause
  MediaProto.load = realLoad
})

afterAll(() => {
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
})

function loadSong(song) {
  useSongsStore().currentSong = song
}

describe('a song that came in with its own karaoke video', () => {
  beforeEach(() => {
    loadSong({ id: 7, has_video: true, video_url: '/api/songs/7/video' })
  })

  it('shows the video INSTEAD of the canvas', () => {
    wrapper = mount(ScreenStage)
    expect(wrapper.findComponent(VideoStage).exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(false)
  })

  it('gives the element an absolute url, for the about:blank popout', () => {
    wrapper = mount(ScreenStage)
    expect(wrapper.find('video').attributes('src'))
      .toBe(`${window.location.origin}/api/songs/7/video`)
  })

  it('feeds it the RAW clock, not the lyrics-offset one', () => {
    // The video's audio was extracted from this very file, so picture and
    // sound are aligned by construction; folding in the offset knob would drag
    // the picture out of sync to fix a problem it does not have.
    //
    // The clock comes from the player STORE, not props: ScreenStage reads it
    // itself so HostShell's template never has to (a template read there
    // re-rendered the whole shell at rAF rate — see HostShellClockIsolation).
    const player = usePlayerStore()
    player.setTime(20)
    player.setOffset(500)
    wrapper = mount(ScreenStage)
    expect(wrapper.findComponent(VideoStage).props('currentTime')).toBe(20)
  })
})

describe('every other song', () => {
  it('keeps the canvas when the song has no video', () => {
    loadSong({ id: 8, has_video: false })
    wrapper = mount(ScreenStage)
    expect(wrapper.findComponent(VideoStage).exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('keeps the canvas while a video import is still running', () => {
    // has_video says what the row IS; video_url appears only once the file is
    // on disk. Rendering a <video src=""> in between would be a broken stage.
    loadSong({ id: 9, has_video: true, video_url: null })
    wrapper = mount(ScreenStage)
    expect(wrapper.findComponent(VideoStage).exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('keeps the canvas with no song loaded at all', () => {
    // The welcome state and the popped-out projector before the first pick.
    wrapper = mount(ScreenStage)
    expect(wrapper.findComponent(VideoStage).exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})
