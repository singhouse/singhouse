// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract test for ScreenStage's 'stage-overlays' mount. The projector
// is core; what a queue system draws on top of it — announcements, join QR,
// an upcoming-singers marquee — is not.
//
// The core-build half matters most: a core stage must render the canvas and
// nothing else, and must not TOUCH an API. Before the extraction this
// component fetched join info and built QR URLs against endpoints a core
// backend does not mount.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/stage/frame.mjs', () => ({ describeFrame: vi.fn(() => ({ pages: [] })) }))
vi.mock('@/stage/draw.mjs', () => ({ drawFrame: vi.fn() }))

const client = vi.hoisted(() => ({
  get: vi.fn(async () => ({ data: {} })),
  post: vi.fn(async () => ({ data: {} })),
}))
vi.mock('@/api/client', () => ({
  default: client,
  songApi: { list: client.get },
  featuresApi: { get: client.get },
}))

const slots = vi.hoisted(() => ({ overlays: null }))
vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'stage-overlays' ? slots.overlays : null),
  slotHasContent: (name) => name === 'stage-overlays' && !!slots.overlays,
  registerSlot: vi.fn(),
}))

import ScreenStage from '@/components/ScreenStage.vue'

const OverlayStub = {
  name: 'OverlayStub',
  props: { showQr: { type: Boolean, default: false } },
  template: '<div class="overlay-stub">qr:{{ showQr }}</div>',
}

const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realRaf = window.requestAnimationFrame
const realCancelRaf = window.cancelAnimationFrame

let wrapper = null

beforeEach(() => {
  setActivePinia(createPinia())
  slots.overlays = null
  client.get.mockClear()
  client.post.mockClear()

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
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

afterAll(() => {
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
})

describe('a core stage (no overlays registered)', () => {
  it('renders the canvas and no overlay layer', () => {
    wrapper = mount(ScreenStage, { props: { showQr: true } })
    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(wrapper.find('.overlay-stub').exists()).toBe(false)
  })

  it('makes no API calls, even with show-qr asked for', async () => {
    wrapper = mount(ScreenStage, { props: { showQr: true } })
    await wrapper.vm.$nextTick()
    expect(client.get).not.toHaveBeenCalled()
    expect(client.post).not.toHaveBeenCalled()
  })
})

describe('with overlays registered', () => {
  beforeEach(() => { slots.overlays = OverlayStub })

  it('mounts them inside the lyrics grid, alongside the canvas', () => {
    wrapper = mount(ScreenStage)
    const overlay = wrapper.find('.overlay-stub')
    expect(overlay.exists()).toBe(true)
    expect(wrapper.find('.screen-stage__lyrics').element.contains(overlay.element)).toBe(true)
  })

  it('passes the projector tell through', () => {
    wrapper = mount(ScreenStage, { props: { showQr: true } })
    expect(wrapper.find('.overlay-stub').text()).toBe('qr:true')

    wrapper.unmount()
    wrapper = mount(ScreenStage)
    expect(wrapper.find('.overlay-stub').text()).toBe('qr:false')
  })
})
