// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Space as play/pause, and the mixer's lyrics-offset row: when it is offered,
// what its buttons say, and that its value starts over with each song.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
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

vi.mock('@/stores/songs', async () => {
  const { reactive } = await import('vue')
  // incomingSongId stands in for a song-detail fetch on its way to the deck.
  const stub = reactive({ fetchLyrics: async () => null, incomingSongId: null })
  return { useSongsStore: () => stub, __songsStub: stub }
})
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ load: vi.fn(async () => {}), lyricsLookupEnabled: false }),
}))

import AudioPlayer from '@/components/AudioPlayer.vue'
import PopoverMenu from '@/components/ui/PopoverMenu.vue'
import Modal from '@/components/ui/Modal.vue'
import { __songsStub as songsStub } from '@/stores/songs'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'

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
let menuWrapper = null

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
  engine.stub.currentTime.value = 0
  engine.stub.loadStems.mockImplementation(async () => ({ durations: [180] }))
  songsStub.incomingSongId = null
})

afterEach(() => {
  usePlayGuard().cancel()
  menuWrapper?.unmount()
  menuWrapper = null
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

  it('toggles playback instead of pressing a focused button', async () => {
    wrapper = await mountPlayer()
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    const ev = pressSpace(btn)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
    const up = new window.KeyboardEvent('keyup', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    })
    btn.dispatchEvent(up)
    // A prevented keyup is what stops the browser pressing the button.
    expect(up.defaultPrevented).toBe(true)
  })

  it('ignores auto-repeat while Space is held', async () => {
    wrapper = await mountPlayer()
    pressSpace(document.body)
    const ev = pressSpace(document.body, { repeat: true })
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it.each([
    ['a text field', () => document.createElement('input')],
    ['a search field', () => Object.assign(document.createElement('input'), { type: 'search' })],
    ['a text area', () => document.createElement('textarea')],
  ])('leaves %s to type the space', async (_, make) => {
    wrapper = await mountPlayer()
    const field = make()
    document.body.appendChild(field)
    field.focus()
    const ev = pressSpace(field)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('toggles playback inside a non-modal popover', async () => {
    wrapper = await mountPlayer()
    menuWrapper = mount(PopoverMenu, {
      attachTo: document.body,
      props: { label: 'Display' },
      slots: {
        trigger: ({ toggle, attrs }) => h('button', { ...attrs, onClick: toggle }, 'Display'),
        default: () => [h('button', { class: 'inside' }, 'Option')],
      },
    })
    await menuWrapper.find('button').trigger('click')
    const panel = document.querySelector('.ui-pop')
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(document.activeElement).toBe(panel)
    pressSpace(panel)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    const inside = panel.querySelector('.inside')
    inside.focus()
    const ev = pressSpace(inside)
    expect(engine.stub.play).toHaveBeenCalledTimes(2)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('still leaves a text field inside a non-modal popover to type', async () => {
    wrapper = await mountPlayer()
    const panel = document.createElement('div')
    panel.setAttribute('role', 'dialog')
    const field = document.createElement('input')
    panel.appendChild(field)
    document.body.appendChild(panel)
    field.focus()
    const ev = pressSpace(field)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does nothing inside a modal dialog', async () => {
    wrapper = await mountPlayer()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const inner = document.createElement('button')
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    inner.focus()
    const ev = pressSpace(inner)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('leaves every deck key to an open Modal, wherever focus is', async () => {
    wrapper = await mountPlayer()
    menuWrapper = mount(Modal, {
      attachTo: document.body,
      props: { visible: true, title: 'Delete song?', message: 'Sure?' },
    })
    await settle(menuWrapper)
    expect(document.querySelector('dialog[open][aria-modal="true"]')).not.toBe(null)
    document.activeElement?.blur?.()
    for (const code of ['Space', 'ArrowLeft', 'ArrowRight', 'Home']) {
      const ev = new window.KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true })
      document.body.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
    }
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(engine.stub.seek).not.toHaveBeenCalled()
    expect(engine.stub.stop).not.toHaveBeenCalled()
  })

  it('toggles playback inside an open menu', async () => {
    wrapper = await mountPlayer()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.tabIndex = -1
    document.body.appendChild(menu)
    menu.focus()
    const ev = pressSpace(menu)
    expect(engine.stub.play).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
    menu.remove()
  })

  it.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'])('does nothing with %s held', async (mod) => {
    wrapper = await mountPlayer()
    const ev = pressSpace(document.body, { [mod]: true })
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('Space while a song is playing', () => {
  async function mountPlaying() {
    const w = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    usePlayerStore().setPlayState('playing')
    return w
  }

  it('asks before pausing', async () => {
    wrapper = await mountPlaying()
    const ev = pressSpace(document.body)
    expect(ev.defaultPrevented).toBe(true)
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'pause' })
    expect(engine.stub.pause).not.toHaveBeenCalled()
  })

  it('keeps playing when the confirmation is cancelled', async () => {
    wrapper = await mountPlaying()
    pressSpace(document.body)
    usePlayGuard().cancel()
    await settle(wrapper)
    expect(engine.stub.pause).not.toHaveBeenCalled()
    expect(engine.stub.stop).not.toHaveBeenCalled()
  })

  it('pauses once confirmed', async () => {
    wrapper = await mountPlaying()
    pressSpace(document.body)
    usePlayGuard().confirm()
    await settle(wrapper)
    expect(engine.stub.pause).toHaveBeenCalledTimes(1)
  })

  it('resumes from pause without asking', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'paused'
    usePlayerStore().setPlayState('paused')
    pressSpace(document.body)
    expect(usePlayGuard().pending.value).toBe(null)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })

  it('leaves the play/pause button unguarded', async () => {
    wrapper = await mountPlaying()
    await wrapper.find('.ctrl-btn--play').trigger('click')
    expect(usePlayGuard().pending.value).toBe(null)
    expect(engine.stub.pause).toHaveBeenCalledTimes(1)
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


describe('Navigation shortcuts with the player mounted', () => {
  function pressKey(target, code, init = {}) {
    const event = new KeyboardEvent('keydown', {
      code, key: code, bubbles: true, cancelable: true, ...init,
    })
    target.dispatchEvent(event)
    return event
  }

  it('lets a real popover navigate Home without stopping the song and own arrow keys without seeking', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    usePlayerStore().setPlayState('playing')
    menuWrapper = mount(PopoverMenu, {
      attachTo: document.body,
      props: { role: 'menu', label: 'Library actions' },
      slots: {
        trigger: ({ toggle, attrs }) => h('button', { ...attrs, onClick: toggle }, 'Actions'),
        default: () => [
          h('button', { role: 'menuitem' }, 'Refresh'),
          h('button', { role: 'menuitem' }, 'Columns'),
        ],
      },
    })
    await menuWrapper.find('button').trigger('click')
    const [first, last] = document.querySelectorAll('[role="menuitem"]')
    last.focus()
    const home = pressKey(last, 'Home')
    expect(document.activeElement).toBe(first)
    expect(home.defaultPrevented).toBe(true)
    pressKey(first, 'ArrowLeft')
    pressKey(first, 'ArrowRight')
    expect(engine.stub.stop).not.toHaveBeenCalled()
    expect(engine.stub.seek).not.toHaveBeenCalled()
    expect(usePlayGuard().pending.value).toBeNull()
  })

  it('does not repeat a navigation key already handled by a library surface', async () => {
    wrapper = await mountPlayer()
    const row = document.createElement('div')
    row.tabIndex = 0
    row.addEventListener('keydown', event => event.preventDefault())
    document.body.appendChild(row)
    row.focus()
    for (const key of ['Home', 'ArrowLeft', 'ArrowRight']) pressKey(row, key)
    expect(engine.stub.stop).not.toHaveBeenCalled()
    expect(engine.stub.seek).not.toHaveBeenCalled()
  })

  it('preserves body seek, shifted seek, and stop shortcuts', async () => {
    wrapper = await mountPlayer()
    document.activeElement?.blur?.()
    engine.stub.currentTime.value = 60
    pressKey(document.body, 'ArrowLeft')
    pressKey(document.body, 'ArrowRight')
    pressKey(document.body, 'ArrowLeft', { shiftKey: true })
    pressKey(document.body, 'ArrowRight', { shiftKey: true })
    expect(engine.stub.seek.mock.calls).toEqual([[55], [65], [30], [90]])
    pressKey(document.body, 'Home')
    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['ctrlKey', 'altKey', 'metaKey'])('leaves modified navigation to the browser (%s)', async modifier => {
    wrapper = await mountPlayer()
    document.activeElement?.blur?.()
    for (const key of ['Home', 'ArrowLeft', 'ArrowRight']) pressKey(document.body, key, { [modifier]: true })
    expect(engine.stub.stop).not.toHaveBeenCalled()
    expect(engine.stub.seek).not.toHaveBeenCalled()
  })
})

function pressCode(target, code, init = {}) {
  const ev = new window.KeyboardEvent('keydown', {
    code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true, ...init,
  })
  target.dispatchEvent(ev)
  return ev
}

describe('Seek and stop with a control focused', () => {
  it.each([
    ['a button', () => document.createElement('button')],
    ['a link', () => Object.assign(document.createElement('a'), { href: '#x' })],
    ['a menu trigger', () => {
      const b = document.createElement('button')
      b.setAttribute('aria-haspopup', 'menu')
      return b
    }],
    ['a checkbox', () => Object.assign(document.createElement('input'), { type: 'checkbox' })],
  ])('seeks and stops with %s focused', async (_, make) => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    engine.stub.currentTime.value = 60
    const el = make()
    document.body.appendChild(el)
    el.focus()
    expect(pressCode(el, 'ArrowLeft').defaultPrevented).toBe(true)
    expect(pressCode(el, 'ArrowRight').defaultPrevented).toBe(true)
    expect(engine.stub.seek.mock.calls).toEqual([[55], [65]])
    expect(pressCode(el, 'Home').defaultPrevented).toBe(true)
    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a range input', () => Object.assign(document.createElement('input'), { type: 'range' })],
    ['a slider', () => {
      const d = document.createElement('div')
      d.setAttribute('role', 'slider')
      d.tabIndex = 0
      return d
    }],
    ['a text field', () => document.createElement('input')],
    ['a tab', () => {
      const d = document.createElement('button')
      d.setAttribute('role', 'tab')
      return d
    }],
    ['an option', () => {
      const d = document.createElement('div')
      d.setAttribute('role', 'option')
      d.tabIndex = 0
      return d
    }],
  ])('leaves ←/→ and Home to %s', async (_, make) => {
    wrapper = await mountPlayer()
    const el = make()
    document.body.appendChild(el)
    el.focus()
    for (const code of ['ArrowLeft', 'ArrowRight', 'Home']) {
      expect(pressCode(el, code).defaultPrevented).toBe(false)
    }
    expect(engine.stub.seek).not.toHaveBeenCalled()
    expect(engine.stub.stop).not.toHaveBeenCalled()
  })

  it('moves a focused range input with the arrows instead of seeking', async () => {
    wrapper = await mountPlayer()
    const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '10', value: '5' })
    // Stands in for the browser's own range keyboarding.
    range.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowRight') range.value = String(Number(range.value) + 1)
      if (e.code === 'ArrowLeft') range.value = String(Number(range.value) - 1)
    })
    document.body.appendChild(range)
    range.focus()
    pressCode(range, 'ArrowRight')
    pressCode(range, 'ArrowRight')
    expect(range.value).toBe('7')
    expect(engine.stub.seek).not.toHaveBeenCalled()
  })

  it('leaves Home but takes the arrows on a radio', async () => {
    wrapper = await mountPlayer()
    const radio = Object.assign(document.createElement('input'), { type: 'radio' })
    document.body.appendChild(radio)
    radio.focus()
    expect(pressCode(radio, 'ArrowRight').defaultPrevented).toBe(false)
    expect(pressCode(radio, 'Home').defaultPrevented).toBe(true)
    expect(engine.stub.seek).not.toHaveBeenCalled()
    expect(engine.stub.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps the arrows on its own position slider as seek', async () => {
    wrapper = mount(AudioPlayer, { props: { song: WITH_VOCALS }, attachTo: document.body })
    await settle(wrapper)
    engine.stub.currentTime.value = 60
    const slider = wrapper.find('[role="slider"]').element
    slider.focus()
    pressCode(slider, 'ArrowRight')
    expect(engine.stub.seek).toHaveBeenCalledWith(65)
  })

  it('seeks from inside a non-modal popover but not from a modal one', async () => {
    wrapper = await mountPlayer()
    const pop = document.createElement('div')
    pop.setAttribute('role', 'dialog')
    const btn = document.createElement('button')
    pop.appendChild(btn)
    const modal = document.createElement('div')
    modal.setAttribute('role', 'alertdialog')
    const modalBtn = document.createElement('button')
    modal.appendChild(modalBtn)
    document.body.append(pop)
    btn.focus()
    pressCode(btn, 'ArrowRight')
    expect(engine.stub.seek).toHaveBeenCalledTimes(1)
    document.body.append(modal)
    modalBtn.focus()
    pressCode(modalBtn, 'ArrowRight')
    pressCode(modalBtn, 'Home')
    expect(engine.stub.seek).toHaveBeenCalledTimes(1)
    expect(engine.stub.stop).not.toHaveBeenCalled()
  })

  it('leaves the arrows to a keyboard-walked grid row, not a clicked one', async () => {
    wrapper = await mountPlayer()
    const grid = document.createElement('div')
    grid.setAttribute('role', 'grid')
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    row.tabIndex = 0
    grid.appendChild(row)
    document.body.appendChild(grid)
    row.focus()
    expect(pressCode(row, 'ArrowLeft').defaultPrevented).toBe(false)
    expect(engine.stub.seek).not.toHaveBeenCalled()
    row.setAttribute('data-pointer-focus', '')
    expect(pressCode(row, 'ArrowLeft').defaultPrevented).toBe(true)
    expect(engine.stub.seek).toHaveBeenCalledTimes(1)
  })
})

describe('Space while the song is loading', () => {
  function deferredStems() {
    let resolve
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    return () => resolve({ durations: [180] })
  }

  it('arms playback and starts the song once it is ready', async () => {
    const finish = deferredStems()
    wrapper = await mountPlayer()
    const ev = pressSpace(document.body)
    expect(ev.defaultPrevented).toBe(true)
    expect(engine.stub.play).not.toHaveBeenCalled()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').text()).toContain('Plays when loaded')
    finish()
    await settle(wrapper)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    expect(usePlayGuard().pending.value).toBe(null)
  })

  it('a second press before ready cancels it', async () => {
    const finish = deferredStems()
    wrapper = await mountPlayer()
    pressSpace(document.body)
    pressSpace(document.body)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    finish()
    await settle(wrapper)
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('loading a different song clears it', async () => {
    deferredStems()
    wrapper = await mountPlayer()
    pressSpace(document.body)
    const finishNext = deferredStems()
    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 42 } })
    await settle(wrapper)
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    finishNext()
    await settle(wrapper)
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('Home clears it', async () => {
    const finish = deferredStems()
    wrapper = await mountPlayer()
    pressSpace(document.body)
    pressCode(document.body, 'Home')
    finish()
    await settle(wrapper)
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('a failed load clears it', async () => {
    let reject
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((_, r) => { reject = r }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    wrapper = await mountPlayer()
    pressSpace(document.body)
    reject(new Error('boom'))
    await settle(wrapper)
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    err.mockRestore()
  })

  it('covers a song still on its way to the deck (queue advance, library click)', async () => {
    wrapper = await mountPlayer()            // song 1 loaded and stopped
    songsStub.incomingSongId = 7             // the next singer's song is being fetched
    pressSpace(document.body)
    expect(engine.stub.play).not.toHaveBeenCalled()   // not the outgoing song
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(true)

    const finish = deferredStems()
    songsStub.incomingSongId = null
    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 7 } })
    await wrapper.vm.$nextTick()
    expect(engine.stub.play).not.toHaveBeenCalled()
    finish()
    await settle(wrapper)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })

  it('another incoming song clears it', async () => {
    wrapper = await mountPlayer()
    songsStub.incomingSongId = 7
    pressSpace(document.body)
    songsStub.incomingSongId = 8
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
  })

  it('does not ask before arming, even over a playing outgoing song', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    usePlayerStore().setPlayState('playing')
    songsStub.incomingSongId = 7
    pressSpace(document.body)
    expect(usePlayGuard().pending.value).toBe(null)
    expect(engine.stub.pause).not.toHaveBeenCalled()
  })
})

describe('the play guard prompt keeps its own Space and Enter', () => {
  it('a Space on the prompt\'s focused button is left to that button', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    usePlayerStore().setPlayState('playing')
    pressSpace(document.body)
    const up = new window.KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    document.body.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(true)          // the opening Space's keyup
    const pending = usePlayGuard().pending.value
    expect(pending).toMatchObject({ kind: 'pause' })

    // Mounted the way the shell mounts it: an alertdialog inside Modal.
    const confirm = vi.fn()
    menuWrapper = mount(Modal, {
      attachTo: document.body,
      props: { visible: true, closable: false },
      slots: {
        default: () => h('div', { role: 'alertdialog', 'aria-modal': 'true', class: 'play-guard' }, [
          h('button', { class: 'primary', onClick: confirm }, 'Pause'),
        ]),
      },
    })
    await settle(menuWrapper)
    const primary = document.querySelector('.play-guard .primary')
    primary.focus()
    const down = pressSpace(primary)
    expect(down.defaultPrevented).toBe(false)
    const up2 = new window.KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    primary.dispatchEvent(up2)
    expect(up2.defaultPrevented).toBe(false)        // the browser may press it
    const enter = pressCode(primary, 'Enter')
    expect(enter.defaultPrevented).toBe(false)
    expect(usePlayGuard().pending.value).toBe(pending)
    expect(engine.stub.pause).not.toHaveBeenCalled()
    expect(engine.stub.play).not.toHaveBeenCalled()
  })
})

describe('play-when-ready and overlapping loads', () => {
  function deferred() {
    let resolve
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    return () => resolve({ durations: [180] })
  }

  it('a late-finishing earlier load neither readies the deck nor plays the armed song', async () => {
    const finishFirst = deferred()
    wrapper = await mountPlayer()                       // song 1 loading
    const finishSecond = deferred()
    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 42 } })
    await settle(wrapper)
    pressSpace(document.body)                           // armed for song 42
    finishFirst()                                       // song 1's load lands late
    await settle(wrapper)
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(wrapper.find('.bar__status').exists()).toBe(true)   // still loading
    expect(wrapper.find('.bar__armed').exists()).toBe(true)
    // ...so a second Space still cancels rather than playing a half-loaded deck.
    finishSecond()
    await settle(wrapper)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })
})

describe('Space with a queue advance in flight (player.advancePending)', () => {
  it('arms instead of replaying the stopped outgoing song', async () => {
    wrapper = await mountPlayer()
    usePlayerStore().setAdvancePending(true)
    pressSpace(document.body)
    await wrapper.vm.$nextTick()
    expect(engine.stub.play).not.toHaveBeenCalled()
    expect(wrapper.find('.bar__armed').exists()).toBe(true)
  })

  it('drops the arm when the advance settles with no song on its way', async () => {
    wrapper = await mountPlayer()
    usePlayerStore().setAdvancePending(true)
    await wrapper.vm.$nextTick()
    pressSpace(document.body)
    await wrapper.vm.$nextTick()
    usePlayerStore().setAdvancePending(false)
    await settle(wrapper)
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('carries the arm to the song the advance fetches', async () => {
    wrapper = await mountPlayer()
    usePlayerStore().setAdvancePending(true)
    pressSpace(document.body)
    songsStub.incomingSongId = 7
    await wrapper.vm.$nextTick()
    usePlayerStore().setAdvancePending(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(true)
    songsStub.incomingSongId = null
    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 7 } })
    await settle(wrapper)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
  })

  it('keeps the pause guard when the outgoing song is still playing', async () => {
    wrapper = await mountPlayer()
    engine.stub.playerState.value = 'playing'
    usePlayerStore().setPlayState('playing')
    usePlayerStore().setAdvancePending(true)
    pressSpace(document.body)
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'pause' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
  })
})

describe('review follow-ups', () => {
  function keyup(target) {
    const up = new window.KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    target.dispatchEvent(up)
    return up
  }

  it('an in-flight load landing after unmount neither starts the loop nor plays', async () => {
    let finish
    engine.stub.loadStems.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    wrapper = await mountPlayer()
    pressSpace(document.body)
    wrapper.unmount()
    wrapper = null
    finish({ durations: [180] })
    await new Promise(r => setTimeout(r))
    await new Promise(r => setTimeout(r))
    expect(engine.stub.startAnimationLoop).not.toHaveBeenCalled()
    expect(engine.stub.play).not.toHaveBeenCalled()
  })

  it('a window blur drops a pending keyup swallow', async () => {
    wrapper = await mountPlayer()
    pressSpace(document.body)
    window.dispatchEvent(new Event('blur'))
    expect(keyup(document.body).defaultPrevented).toBe(false)
  })

  it('a fresh Space press starts with no leftover swallow', async () => {
    wrapper = await mountPlayer()
    pressSpace(document.body)          // its keyup never reaches the window
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    pressSpace(field)                  // types a space
    expect(keyup(field).defaultPrevented).toBe(false)
  })

  it('a closed Modal dialog still in the DOM owns no keys', async () => {
    wrapper = await mountPlayer()
    const closing = document.createElement('dialog')
    closing.setAttribute('role', 'alertdialog')
    closing.setAttribute('aria-modal', 'true')
    document.body.appendChild(closing)  // not open: leaving
    document.activeElement?.blur?.()
    expect(pressSpace(document.body).defaultPrevented).toBe(true)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    engine.stub.currentTime.value = 60
    pressCode(document.body, 'ArrowRight')
    expect(engine.stub.seek).toHaveBeenCalledWith(65)
  })

  it('the Play button replaces a pending play-when-ready', async () => {
    wrapper = await mountPlayer()
    songsStub.incomingSongId = 7
    pressSpace(document.body)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar__armed').exists()).toBe(true)
    await wrapper.find('.ctrl-btn--play').trigger('click')
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)
    songsStub.incomingSongId = null
    await wrapper.setProps({ song: { ...WITH_VOCALS, id: 7 } })
    await settle(wrapper)
    expect(engine.stub.play).toHaveBeenCalledTimes(1)   // nothing armed to fire
  })

  it('keeps the armed-state live region mounted', async () => {
    wrapper = await mountPlayer()
    expect(wrapper.find('.bar__armed-live[role="status"]').exists()).toBe(true)
    expect(wrapper.find('.bar__armed').exists()).toBe(false)
  })
})
