// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Popout re-key. Moving the lyrics DOM into (or back out of) the popup
// window reparents the canvas element between documents WITHOUT remounting any
// Vue component, so the canvas keeps the 2D context it acquired in the old
// document — the field symptom was a popped-out projector frozen on whatever
// was on screen at the moment of the move.
//
// The fix is a remount key: ScreenStage keys the inner KaraokeStage on its
// `stageEpoch` prop and the host bumps that prop whenever the popout opens or
// closes. This test pins the mechanism — bumping the epoch must produce a
// FRESH KaraokeStage (new canvas element, new getContext call), not a prop
// update on the old one. Deleting `:key="stageEpoch"` from ScreenStage fails
// it.
//
// happy-dom has no real canvas and the renderer core is mocked out; what is
// under test is the remount, not any drawing.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/stage/frame.mjs', () => ({ describeFrame: vi.fn(() => ({ pages: [] })) }))
vi.mock('@/stage/draw.mjs', () => ({ drawFrame: vi.fn() }))
// No api/client mock any more: the stage speaks to no API at all since the
// overlays moved out behind the 'stage-overlays' slot. See
// ScreenStageOverlaySlot.test.js, which asserts exactly that.

import ScreenStage from '@/components/ScreenStage.vue'
import KaraokeStage from '@/stage/KaraokeStage.vue'
import { usePlayerStore } from '@/stores/player'

const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realRaf = window.requestAnimationFrame
const realCancelRaf = window.cancelAnimationFrame

let getContext
let wrapper

beforeEach(() => {
  setActivePinia(createPinia())

  getContext = vi.fn(() => ({
    setTransform: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  }))
  window.HTMLCanvasElement.prototype.getContext = getContext

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  vi.stubGlobal('ResizeObserver', window.ResizeObserver)

  // Frames are never run here; swallowing them keeps the mounted stage from
  // drawing into a stub context during the test.
  window.requestAnimationFrame = vi.fn(() => 1)
  window.cancelAnimationFrame = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
})

function mountStage() {
  return mount(ScreenStage, {
    props: { stageEpoch: 0 },
    global: {
      stubs: { BrandLogo: true, Transition: false },
    },
  })
}

describe('ScreenStage popout re-key', () => {
  it('remounts the canvas stage when stageEpoch changes', async () => {
    wrapper = mountStage()
    expect(getContext).toHaveBeenCalledTimes(1)
    const first = wrapper.find('canvas').element

    await wrapper.setProps({ stageEpoch: 1 })
    await nextTick()

    // A fresh mount: new element, and the context was acquired again with the
    // canvas already living in its destination document.
    expect(getContext).toHaveBeenCalledTimes(2)
    expect(getContext).toHaveBeenLastCalledWith('2d')
    expect(wrapper.find('canvas').element).not.toBe(first)
  })

  it('leaves the stage alone when the clock advances', async () => {
    // The play clock comes from the player store (not a prop from HostShell);
    // it advancing must update the inner stage's prop, never remount it.
    wrapper = mountStage()
    const first = wrapper.find('canvas').element

    usePlayerStore().setTime(12.5)
    await nextTick()

    expect(getContext).toHaveBeenCalledTimes(1)
    expect(wrapper.find('canvas').element).toBe(first)
    expect(wrapper.findComponent(KaraokeStage).props('currentTime')).toBe(12.5)
  })

  it('folds the host lyrics offset into the canvas clock', async () => {
    wrapper = mountStage()
    const player = usePlayerStore()
    player.setTime(10)
    player.setOffset(500) // ms
    await nextTick()

    expect(wrapper.findComponent(KaraokeStage).props('currentTime')).toBe(10.5)
  })
})
