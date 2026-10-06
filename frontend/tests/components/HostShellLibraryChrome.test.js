// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The library sidebar's shell-owned controls and the welcome pane: the
// Settings gear beside + Add opens the host's display settings; + Add lists
// Add files first; nothing visible says "upload"; and the welcome keeps the
// three first-time steps for an empty library, then switches to a
// library-aware line once a song exists, offering processing setup only
// while it is not set up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const library = vi.hoisted(() => ({ songs: [], gate: null, me: { id: 1, name: 'Host' } }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    list: vi.fn(async () => {
      if (library.gate) await library.gate
      return { data: { songs: library.songs, total: library.songs.length } }
    }),
  },
  queueApi: { list: vi.fn(async () => ({ data: { entries: [] } })) },
  sessionApi: {
    config: vi.fn(async () => ({ data: {} })),
    me: vi.fn(async () => ({ data: library.me })),
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

const SongListStub = {
  name: 'SongListStub',
  template: `<div class="song-list-stub">
    <slot name="lead" /><div class="stub-actions"><slot name="actions" /></div><slot name="trail" /><slot name="notice" />
  </div>`,
}

let wrapper = null

function mountShell() {
  wrapper = mount(HostShell, {
    attachTo: document.body,
    global: {
      stubs: {
        SongList: SongListStub,
        QueuePanel: true, AudioPlayer: true, ScreenStage: true,
        UploadZone: { template: '<div class="upload-zone-stub" />' },
        DesktopOnboarding: { name: 'DesktopOnboarding', props: ['open'], template: '<div class="desktop-setup-stub" />', emits: ['close', 'background', 'add-song'] },
        PlexImportModal: { template: '<div class="plex-stub" />' },
        BrandLogo: true, BrandMark: true,
        'router-link': { props: ['to'], template: '<a><slot /></a>' },
        teleport: true,
      },
    },
  })
  return wrapper
}

const SONG = { id: 1, title: 'Fixture Tune', artist: 'Fixture Band', status: 'ready', created_at: '2026-08-01T00:00:00' }

// Every name a user or assistive technology can perceive.
function perceivable() {
  const el = wrapper.element
  const attrs = [...el.querySelectorAll('[title], [aria-label]')]
    .flatMap(n => [n.getAttribute('title'), n.getAttribute('aria-label')])
  return [el.textContent, ...attrs].filter(Boolean).join(' ').toLowerCase()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  library.songs = []
  library.gate = null
  library.me = { id: 1, name: 'Host' }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.karaokeDesktop
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Settings gear', () => {
  it('sits in the sidebar header beside + Add and opens the display settings', async () => {
    mountShell()
    await flushPromises()
    const actions = wrapper.find('.stub-actions')
    const gear = actions.find('button[aria-label="Settings"]')
    expect(gear.exists()).toBe(true)
    expect(gear.attributes('title')).toBe('Settings')
    expect(gear.attributes('aria-expanded')).toBe('false')
    // Comes after + Add.
    const buttons = actions.findAll('button')
    expect(buttons.findIndex(b => b.classes('add-btn'))).toBeLessThan(buttons.findIndex(b => b.element === gear.element))

    gear.element.focus()
    await gear.trigger('click')
    await flushPromises()
    const panel = document.querySelector('.ui-pop[aria-label="Display settings"]')
    expect(panel).not.toBe(null)
    expect(panel.textContent).toContain('Backdrop')
    expect(gear.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.popout-btn--display').attributes('aria-expanded')).toBe('true')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.querySelector('.ui-pop[aria-label="Display settings"]')).toBe(null)
    expect(document.activeElement).toBe(gear.element)
  })

  it('leaves focus with the Display button when that opened the popover', async () => {
    mountShell()
    await flushPromises()
    const display = wrapper.find('.popout-btn--display')
    display.element.focus()
    await display.trigger('click')
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.activeElement).toBe(display.element)
  })
})

describe('+ Add', () => {
  it('lists Add files first, with a folder icon', async () => {
    mountShell()
    await flushPromises()
    await wrapper.find('.add-btn').trigger('click')
    const items = wrapper.findAll('[role="menuitem"]')
    expect(items[0].text()).toBe('Add files…')
    expect(items[0].find('.ui-menu__icon svg path').exists()).toBe(true)
    expect(items[1].text()).toContain('Import from Plex…')
  })

  it('never says upload, in any of the add surfaces', async () => {
    mountShell()
    await flushPromises()
    expect(perceivable()).not.toContain('upload')
    await wrapper.find('.add-btn').trigger('click')
    expect(perceivable()).not.toContain('upload')
    await wrapper.findAll('[role="menuitem"]')[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('.upload-zone-stub').exists()).toBe(true)
    expect(perceivable()).not.toContain('upload')
    await wrapper.find('[aria-label="Collapse sidebar"]').trigger('click')
    expect(wrapper.find('[aria-label="Add files"]').exists()).toBe(true)
    expect(perceivable()).not.toContain('upload')
  })
})

describe('welcome pane', () => {
  it('shows neither panel until the first library load answers', async () => {
    let release
    library.gate = new Promise(r => { release = r })
    library.songs = [SONG]
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome').exists()).toBe(false)
    release()
    await flushPromises()
    expect(wrapper.find('.welcome__sub').text()).toBe('Add more songs, or pick one on the left.')
  })

  it('remembers a started library per host identity', async () => {
    library.songs = [SONG]
    mountShell()
    await flushPromises()
    expect(localStorage.getItem('karaoke:libraryStarted:1')).toBe('1')
    expect(localStorage.getItem('karaoke:libraryStarted')).toBe(null)
    wrapper.unmount()

    // Same host, library now empty: still the library-aware welcome.
    library.songs = []
    setActivePinia(createPinia())
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome__sub').text()).toBe('Add more songs, or pick one on the left.')
    wrapper.unmount()

    // Another identity has not started a library.
    library.me = { id: 2, name: 'Host' }
    setActivePinia(createPinia())
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome__steps').exists()).toBe(true)
  })

  it('keeps the three first-time steps for an empty library', async () => {
    mountShell()
    await flushPromises()
    const welcome = wrapper.find('.welcome')
    expect(welcome.find('.welcome__sub').text()).toBe('Add a song or select from your library to begin')
    expect(welcome.findAll('.welcome__step')).toHaveLength(3)
    expect(welcome.find('.welcome__step').text()).toContain('Add an audio file (MP3, FLAC, WAV) or a karaoke video')
    expect(welcome.find('.welcome__cta').text()).toBe('Add files')
    expect(welcome.find('.welcome__setup').exists()).toBe(false)
  })

  it('switches to the library line and Add files once a song exists', async () => {
    library.songs = [SONG]
    mountShell()
    await flushPromises()
    const welcome = wrapper.find('.welcome')
    expect(welcome.find('.welcome__sub').text()).toBe('Add more songs, or pick one on the left.')
    expect(welcome.find('.welcome__steps').exists()).toBe(false)
    const cta = welcome.find('.welcome__cta')
    expect(cta.text()).toBe('Add files')
    await cta.trigger('click')
    await flushPromises()
    expect(wrapper.find('.upload-zone-stub').exists()).toBe(true)
  })

  it('switches after the first import and stays switched', async () => {
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome__steps').exists()).toBe(true)
    const { useSongsStore } = await import('@/stores/songs')
    const store = useSongsStore()
    store.uploads.push({ id: 'u1', filename: 'fixture.wav', status: 'uploading' })
    await flushPromises()
    expect(wrapper.find('.welcome__sub').text()).toBe('Add more songs, or pick one on the left.')
    store.uploads.splice(0)
    store.songs = []
    await flushPromises()
    expect(wrapper.find('.welcome__steps').exists()).toBe(false)
  })

  it('offers processing setup only while it is not set up', async () => {
    library.songs = [SONG]
    window.karaokeDesktop = {
      managedSetup: true,
      getOnboardingState: vi.fn(async () => ({ step: 'choose', skipped: true })),
      onOpenSetup: vi.fn(() => () => {}),
    }
    mountShell()
    await flushPromises()
    const setup = wrapper.find('.welcome__setup')
    expect(setup.exists()).toBe(true)
    expect(setup.text()).toBe('⚙Set up song processing')
    await setup.trigger('click')
    expect(wrapper.findComponent({ name: 'DesktopOnboarding' }).props('open')).toBe(true)
    wrapper.unmount()

    window.karaokeDesktop.getOnboardingState = vi.fn(async () => ({ step: 'ready' }))
    setActivePinia(createPinia())
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome__sub').text()).toBe('Add more songs, or pick one on the left.')
    expect(wrapper.find('.welcome__setup').exists()).toBe(false)
  })

  for (const event of ['background', 'close']) {
    it(`re-reads the setup state when setup is sent to the ${event}`, async () => {
      library.songs = [SONG]
      const state = { step: 'progress', skipped: false }
      window.karaokeDesktop = {
        managedSetup: true,
        getOnboardingState: vi.fn(async () => ({ ...state })),
        onOpenSetup: vi.fn(() => () => {}),
      }
      mountShell()
      await flushPromises()
      const onboarding = wrapper.findComponent({ name: 'DesktopOnboarding' })
      expect(onboarding.props('open')).toBe(true)
      expect(wrapper.find('.welcome__setup').exists()).toBe(true)

      state.step = 'ready'
      onboarding.vm.$emit(event)
      await flushPromises()
      expect(onboarding.props('open')).toBe(false)
      expect(window.karaokeDesktop.getOnboardingState).toHaveBeenCalledTimes(2)
      expect(wrapper.find('.welcome__setup').exists()).toBe(false)
    })
  }

  it('has no setup action outside the desktop app', async () => {
    library.songs = [SONG]
    mountShell()
    await flushPromises()
    expect(wrapper.find('.welcome__cta').exists()).toBe(true)
    expect(wrapper.find('.welcome__setup').exists()).toBe(false)
  })
})
