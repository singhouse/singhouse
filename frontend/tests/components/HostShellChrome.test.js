// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// HostShell's consolidated chrome: no sidebar footer; backend health
// as a dot on the brand mark plus an offline banner; the brand mark opens the
// account/status popover (identity + exit); `+ Add` holds Add files and Plex;
// the Display popover in the stage tools holds Backdrop / Reacts-to and, only
// when the route exists, the projector link.

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

const routes = vi.hoisted(() => ({ screen: false }))
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), hasRoute: (n) => n === 'screen' && routes.screen }),
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  slotHasContent: () => false,
  registerSlot: vi.fn(),
}))

import HostShell from '@/views/HostShell.vue'
import { useHostSettings } from '@/stores/hostSettings'

// Renders every header slot HostShell fills.
const SongListStub = {
  name: 'SongListStub',
  template: `<div class="song-list-stub">
    <slot name="lead" /><slot name="actions" /><slot name="trail" /><slot name="notice" />
  </div>`,
}

let wrapper = null

function mountShell() {
  wrapper = mount(HostShell, {
    global: {
      stubs: {
        SongList: SongListStub,
        QueuePanel: true, AudioPlayer: true, ScreenStage: true,
        UploadZone: { template: '<div class="upload-zone-stub" />' },
        DesktopOnboarding: { name: 'DesktopOnboarding', props: ['open'], template: '<div class="desktop-setup-stub" />', emits: ['close', 'add-song'] },
        PlexImportModal: { template: '<div class="plex-stub" />' },
        BrandLogo: true, BrandMark: true,
        'router-link': { props: ['to'], template: '<a class="router-link-stub" :data-to="to"><slot /></a>' },
        teleport: true,
      },
    },
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  routes.screen = false
  localStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.karaokeDesktop
  vi.unstubAllGlobals()
})

describe('HostShell chrome', () => {
  it('has no sidebar footer and no full-width upload CTA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    expect(wrapper.find('.sidebar__footer').exists()).toBe(false)
    expect(wrapper.find('.upload-cta').exists()).toBe(false)
  })

  it('shows backend health on the mark, and a banner only while offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    expect(wrapper.find('.brand-dot--online').exists()).toBe(true)
    expect(wrapper.find('.offline-banner').exists()).toBe(false)
    wrapper.unmount()

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    mountShell()
    await flushPromises()
    expect(wrapper.find('.brand-dot--offline').exists()).toBe(true)
    expect(wrapper.find('.offline-banner').text()).toContain('Backend offline')
  })

  it('opens the account popover with identity and status from the mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    await wrapper.find('.brand-btn').trigger('click')
    expect(wrapper.find('.acct-row--user').text()).toBe('Host')
    expect(wrapper.text()).toContain('Backend online')
  })

  it('+ Add opens the add-files and Plex modals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    await wrapper.find('.add-btn').trigger('click')
    const items = () => wrapper.findAll('[role="menuitem"]')
    expect(items().map(b => b.text())).toEqual(['Add files…', '🎞Import from Plex…'])
    expect(items()[0].find('.ui-menu__icon svg').exists()).toBe(true)

    await items()[0].trigger('click')
    expect(wrapper.find('.upload-zone-stub').exists()).toBe(true)

    await wrapper.find('.add-btn').trigger('click')
    await items()[1].trigger('click')
    expect(wrapper.find('.plex-stub').exists()).toBe(true)
  })

  it('the add-files dialog is named Add files and Escape closes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    await wrapper.find('.add-btn').trigger('click')
    await wrapper.findAll('[role="menuitem"]')[0].trigger('click')
    await flushPromises()

    const dialog = wrapper.find('dialog.modal-overlay')
    expect(dialog.attributes('role')).toBe('dialog')
    expect(wrapper.find(`#${dialog.attributes('aria-labelledby')}`).text()).toBe('Add files')

    await dialog.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('dialog.modal-overlay').exists()).toBe(false)
    expect(wrapper.find('.upload-zone-stub').exists()).toBe(false)
  })

  it('preserves desktop setup in the account menu and collapsed rail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    const stopListener = vi.fn()
    window.karaokeDesktop = {
      managedSetup: true,
      getOnboardingState: vi.fn(async () => ({ step: 'ready' })),
      onOpenSetup: vi.fn(() => stopListener),
    }
    mountShell()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'DesktopOnboarding' }).props('open')).toBe(false)
    await wrapper.find('.brand-btn').trigger('click')
    const setupButton = wrapper.findAll('.ui-menu__item').find(b => b.text().includes('Set up song processing'))
    await setupButton.trigger('click')
    expect(wrapper.findComponent({ name: 'DesktopOnboarding' }).props('open')).toBe(true)
    expect(wrapper.find('.brand-btn').attributes('aria-expanded')).toBe('false')
    wrapper.findComponent({ name: 'DesktopOnboarding' }).vm.$emit('add-song')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'DesktopOnboarding' }).props('open')).toBe(false)
    expect(wrapper.find('.upload-zone-stub').exists()).toBe(true)
    await wrapper.find('[aria-label="Collapse sidebar"]').trigger('click')
    await wrapper.find('[aria-label="Set up song processing"]').trigger('click')
    expect(wrapper.findComponent({ name: 'DesktopOnboarding' }).props('open')).toBe(true)
    wrapper.unmount()
    wrapper = null
    expect(stopListener).toHaveBeenCalledOnce()
  })

  it('updates backdrop settings through the Display controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    await wrapper.find('.popout-btn--display').trigger('click')
    const settings = useHostSettings()
    await wrapper.find('select').setValue('aurora')
    expect(settings.backdrop).toBe('aurora')
    await wrapper.findAll('select')[1].setValue('vocals')
    expect(settings.audioSource).toBe('vocals')
  })

  it('Display holds the backdrop controls; Reacts-to hides for no backdrop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    const settings = useHostSettings()
    settings.backdrop = 'none'
    await wrapper.find('.popout-btn--display').trigger('click')
    expect(wrapper.text()).toContain('Backdrop')
    expect(wrapper.text()).not.toContain('Reacts to')
    // No /screen route in a core build → no projector link.
    expect(wrapper.find('.router-link-stub').exists()).toBe(false)
  })

  it('Display offers the projector view only when the route exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    routes.screen = true
    mountShell()
    await flushPromises()
    await wrapper.find('.popout-btn--display').trigger('click')
    const link = wrapper.find('.router-link-stub')
    expect(link.exists()).toBe(true)
    expect(link.attributes('data-to')).toBe('/screen')
    expect(link.text()).toContain('Open projector view')

    // Following it (into a new tab) leaves no stale popover behind.
    await link.trigger('click')
    expect(wrapper.find('.router-link-stub').exists()).toBe(false)
    expect(wrapper.find('.popout-btn--display').attributes('aria-expanded')).toBe('false')
  })
})

describe('HostShell sidebar width', () => {
  const handle = () => wrapper.find('.sidebar__resize')

  it('opens at 400px by default and keeps the 300px minimum', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    mountShell()
    await flushPromises()
    expect(handle().attributes('aria-valuenow')).toBe('400')
    expect(handle().attributes('aria-valuemin')).toBe('300')
    expect(wrapper.find('.sidebar').attributes('style')).toContain('width: 400px')

    await handle().trigger('keydown', { key: 'Home' })
    expect(handle().attributes('aria-valuenow')).toBe('300')
  })

  it('keeps a saved width, and double-click resets to the new default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    localStorage.setItem('karaoke:sidebarWidth', '320')
    mountShell()
    await flushPromises()
    expect(handle().attributes('aria-valuenow')).toBe('320')

    await handle().trigger('dblclick')
    expect(handle().attributes('aria-valuenow')).toBe('400')
    expect(localStorage.getItem('karaoke:sidebarWidth')).toBe('400')
  })
})
