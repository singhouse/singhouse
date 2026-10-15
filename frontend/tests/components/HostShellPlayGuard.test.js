// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The confirmation HostShell shows before an action interrupts the song that
// is playing: its copy, focus on the primary button, Escape and Cancel
// leaving the song alone, and the confirm running the original action.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
  queueApi: { list: vi.fn(async () => ({ data: { entries: [] } })) },
  sessionApi: {
    config: vi.fn(async () => ({ data: {} })),
    me: vi.fn(async () => ({ data: {} })),
  },
}))

vi.mock('@/composables/useLyricsWindow', () => ({
  useLyricsWindow: () => ({ isOpen: ref(false), open: vi.fn(), close: vi.fn() }),
  getScreens: vi.fn(async () => ({ screens: [], primary: null })),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), hasRoute: () => false }),
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  slotHasContent: () => false,
  registerSlot: vi.fn(),
}))

import HostShell from '@/views/HostShell.vue'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'

let wrapper = null

async function mountShell() {
  wrapper = mount(HostShell, {
    attachTo: document.body,
    global: {
      stubs: {
        SongList: { template: '<div class="song-list-stub" />' },
        QueuePanel: true, AudioPlayer: true, ScreenStage: true,
        UploadZone: true, DesktopOnboarding: true, PlexImportModal: true,
        BrandLogo: true, BrandMark: true, 'router-link': true,
        teleport: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

const dialog = () => wrapper.find('[role="alertdialog"]')
const buttons = () => dialog().findAll('button')

function pressEscape() {
  window.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  usePlayGuard().cancel()
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('play guard confirmation', () => {
  it('runs the action without asking while nothing is playing', async () => {
    await mountShell()
    for (const state of ['stopped', 'paused']) {
      usePlayerStore().setPlayState(state)
      const action = vi.fn()
      await expect(usePlayGuard().guard(action, { kind: 'load', title: 'Synthetic Tune' })).resolves.toBe(true)
      expect(action).toHaveBeenCalledTimes(1)
      await flushPromises()
      expect(dialog().exists()).toBe(false)
    }
  })

  it('asks before loading over a playing song, with Load focused', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    usePlayGuard().guard(action, { kind: 'load', title: 'Synthetic Tune' })
    await flushPromises()

    expect(dialog().text()).toContain('Stop the current song and load “Synthetic Tune”?')
    expect(buttons().map(b => b.text())).toEqual(['Cancel', 'Load'])
    expect(document.activeElement).toBe(buttons()[1].element)
    expect(action).not.toHaveBeenCalled()
  })

  it('Escape cancels and the action never runs', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    const result = usePlayGuard().guard(action, { kind: 'load', title: 'Synthetic Tune' })
    await flushPromises()

    pressEscape()
    await expect(result).resolves.toBe(false)
    await flushPromises()
    expect(action).not.toHaveBeenCalled()
    expect(dialog().exists()).toBe(false)
  })

  it('Cancel leaves the song alone', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    const result = usePlayGuard().guard(action, { kind: 'load', title: 'Synthetic Tune' })
    await flushPromises()

    await buttons()[0].trigger('click')
    await expect(result).resolves.toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it('Load performs the original action', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    const result = usePlayGuard().guard(action, { kind: 'load', title: 'Synthetic Tune' })
    await flushPromises()

    await buttons()[1].trigger('click')
    await expect(result).resolves.toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(dialog().exists()).toBe(false)
  })

  it('asks before pausing, and Pause performs it', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    const result = usePlayGuard().guard(action, { kind: 'pause' })
    await flushPromises()

    expect(dialog().text()).toContain('Pause the current song?')
    expect(buttons().map(b => b.text())).toEqual(['Cancel', 'Pause'])
    expect(document.activeElement).toBe(buttons()[1].element)

    await buttons()[1].trigger('click')
    await expect(result).resolves.toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('waits for the opening key to be released before focusing the primary', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    const action = vi.fn()
    let result = null
    // Stands in for the player's Space shortcut, which opens the prompt from
    // its own keydown handler.
    const openOnSpace = (e) => {
      if (e.code === 'Space') result = usePlayGuard().guard(action, { kind: 'pause' })
    }
    window.addEventListener('keydown', openOnSpace)
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    }))
    window.removeEventListener('keydown', openOnSpace)
    await flushPromises()

    const primary = buttons()[1].element
    expect(dialog().exists()).toBe(true)
    expect(document.activeElement).not.toBe(primary)
    expect(document.activeElement).toBe(dialog().element)

    primary.dispatchEvent(new window.KeyboardEvent('keyup', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    }))
    await flushPromises()
    expect(document.activeElement).toBe(primary)
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'pause' })
    expect(action).not.toHaveBeenCalled()

    usePlayGuard().cancel()
    await expect(result).resolves.toBe(false)
  })

  it('keeps focus in the prompt when focus would fall to the page', async () => {
    await mountShell()
    usePlayerStore().setPlayState('playing')
    usePlayGuard().guard(vi.fn(), { kind: 'load', title: 'Synthetic Tune' })
    await flushPromises()

    expect(dialog().attributes('tabindex')).toBe('-1')
    buttons()[1].element.blur()
    await new Promise(r => setTimeout(r))
    expect(document.activeElement).toBe(dialog().element)
    expect(usePlayGuard().pending.value).toMatchObject({ kind: 'load' })
  })
})
