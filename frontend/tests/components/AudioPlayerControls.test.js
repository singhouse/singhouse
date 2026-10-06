// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Space as play/pause, and the mixer's lyrics-offset row: when it is offered,
// what its buttons say, and that its value starts over with each song.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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

const WITH_VOCALS = {
  id: 1,
  title: 'Synthetic Song',
  artist: 'Test Artist',
  stems: { vocals: [{ id: 'lead', url: '/lead.mp3' }], instrumental: '/inst.mp3' },
}
// A prepared karaoke video: one instrumental bed, lyrics burned into the picture.
const VIDEO_ONLY = {
  id: 2,
  title: 'Prepared Video',
  artist: 'Test Artist',
  has_video: true,
  stems: { instrumental: '/inst.mp3' },
}
const LYRICS_ONLY = {
  id: 3,
  title: 'Lyrics Only',
  artist: 'Test Artist',
  stems: { instrumental: '/inst.mp3' },
  word_sync: { segments: [{ start: 1, end: 2, words: [{ word: 'la', start: 1, end: 2 }] }] },
}

let wrapper = null

async function settle(w) {
  await new Promise(r => setTimeout(r))
  await w.vm.$nextTick()
}

async function mountPlayer(song = WITH_VOCALS) {
  const w = mount(AudioPlayer, {
    props: { song },
    attachTo: document.body,
    global: { stubs: { ProgressBar: true } },
  })
  await settle(w)
  return w
}

async function openMixer(w) {
  await w.find('button[aria-label="Toggle mixer panel"]').trigger('click')
}

function pressSpace(target, init = {}) {
  const ev = new window.KeyboardEvent('keydown', {
    code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init,
  })
  target.dispatchEvent(ev)
  return ev
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  engine.stub.playerState.value = 'stopped'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('Space shortcut', () => {
  it('toggles playback when pressed on the page body', async () => {
    wrapper = await mountPlayer()
    document.activeElement?.blur?.()
    const ev = pressSpace(document.body)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('pauses when playing and pressed on the page body', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    pressSpace(document.body)
    expect(engine.stub.pause).toHaveBeenCalledTimes(1)
  })

  it('leaves a focused button to press itself', async () => {
    wrapper = await mountPlayer()
    const btn = wrapper.find('button[aria-label="Stop"]').element
    btn.focus()
    const ev = pressSpace(btn)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(engine.stub.pause).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does nothing inside a dialog', async () => {
    wrapper = await mountPlayer()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inner = document.createElement('div')
    inner.tabIndex = -1
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    inner.focus()
    const ev = pressSpace(inner)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does nothing inside a menu', async () => {
    wrapper = await mountPlayer()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.tabIndex = -1
    document.body.appendChild(menu)
    menu.focus()
    const ev = pressSpace(menu)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'])('does nothing with %s held', async (mod) => {
    wrapper = await mountPlayer()
    const ev = pressSpace(document.body, { [mod]: true })
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('Lyrics offset row', () => {
  it('is hidden for a song with no vocal track and no lyrics', async () => {
    wrapper = await mountPlayer(VIDEO_ONLY)
    await openMixer(wrapper)
    expect(wrapper.text()).not.toContain('Lyrics offset')
    expect(wrapper.find('button[aria-label="Lyrics earlier"]').exists()).toBe(false)
    // The rest of the mixer is still there.
    expect(wrapper.text()).toContain('Key')
  })

  it('is shown when the song has a vocal stem', async () => {
    wrapper = await mountPlayer(WITH_VOCALS)
    await openMixer(wrapper)
    expect(wrapper.text()).toContain('Lyrics offset')
  })

  it('is shown when the song has lyrics but no vocal stem', async () => {
    wrapper = await mountPlayer(LYRICS_ONLY)
    await openMixer(wrapper)
    expect(wrapper.text()).toContain('Lyrics offset')
  })

  it('labels both step buttons with the way the lyrics move', async () => {
    wrapper = await mountPlayer()
    await openMixer(wrapper)
    const earlier = wrapper.find('button[aria-label="Lyrics earlier"]')
    const later = wrapper.find('button[aria-label="Lyrics later"]')
    expect(earlier.attributes('title')).toBe('Lyrics earlier')
    expect(later.attributes('title')).toBe('Lyrics later')

    // The stage reads currentTime + offset, so earlier is the positive step.
    await earlier.trigger('click')
    expect(wrapper.emitted('lyrics-offset-change').at(-1)).toEqual([100])
    await later.trigger('click')
    await later.trigger('click')
    expect(wrapper.emitted('lyrics-offset-change').at(-1)).toEqual([-100])
  })

  it('starts over at zero when a new song loads', async () => {
    wrapper = await mountPlayer()
    await openMixer(wrapper)
    const earlier = wrapper.find('button[aria-label="Lyrics earlier"]')
    await earlier.trigger('click')
    await earlier.trigger('click')
    expect(wrapper.find('.offset-value').text()).toBe('+200ms')

    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 99 } })
    await settle(wrapper)
    expect(wrapper.emitted('lyrics-offset-change').at(-1)).toEqual([0])

    await openMixer(wrapper)
    expect(wrapper.find('.offset-value').text()).toBe('0ms')
  })
})
