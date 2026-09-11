// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Projector canvas hardening. Two failure modes killed the projector mid-show and
// both were silent — the stage just stopped updating and there was nothing to
// do but reload the page:
//
//   1. The rAF loop re-armed itself as its LAST statement, so any throw out of
//      the frame body (bad model, visualizer bug, renderer regression) meant
//      the loop was never scheduled again.
//   2. The 2D context was acquired once at mount with no `contextlost` /
//      `contextrestored` handling. A lost context accepts every draw call and
//      paints nothing.
//
// These tests pin both behaviours. happy-dom has no real canvas, so
// getContext is stubbed and the renderer core is mocked out — what is under
// test is KaraokeStage's loop/lifecycle plumbing, not the drawing.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const describeFrame = vi.hoisted(() => vi.fn(() => ({ pages: [] })))
const drawFrame = vi.hoisted(() => vi.fn())

vi.mock('@/stage/frame.mjs', () => ({ describeFrame }))
vi.mock('@/stage/draw.mjs', () => ({ drawFrame }))

import KaraokeStage from '@/stage/KaraokeStage.vue'

let ctxStub
let getContext
let pendingFrames
let wrapper

// Originals of everything patched onto the environment below, so afterAll can
// put the environment back. Vitest gives each file its own environment today,
// but a suite that only works because nothing runs after it is a trap.
const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realOffsetParent = Object.getOwnPropertyDescriptor(
  window.HTMLElement.prototype, 'offsetParent',
)
const realRaf = window.requestAnimationFrame
const realCancelRaf = window.cancelAnimationFrame

/**
 * Minimal 2D-context stand-in — only what the frame body and the error path
 * touch. `reset` is present because the loop's throw handler prefers it for
 * rebalancing the save/restore stack; `restore` is the fallback drain.
 */
function makeCtx() {
  return {
    setTransform: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  }
}

/** Run every currently-queued rAF callback exactly once. */
function tickFrame() {
  const due = pendingFrames
  pendingFrames = []
  for (const cb of due) cb(0)
}

beforeEach(() => {
  ctxStub = makeCtx()
  getContext = vi.fn(() => ctxStub)
  window.HTMLCanvasElement.prototype.getContext = getContext

  // The frame body bails out when the stage is hidden (offsetParent null).
  // happy-dom does no layout, so declare the stage visible.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body },
  })

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  vi.stubGlobal('ResizeObserver', window.ResizeObserver)

  // Drive rAF by hand so "was the next frame scheduled?" is directly testable.
  pendingFrames = []
  window.requestAnimationFrame = vi.fn(cb => pendingFrames.push(cb))
  window.cancelAnimationFrame = vi.fn()

  // Reset, not clear: a test that installs a persistent mockImplementation
  // must not leak it into the next one. (mockReset restores the factory
  // implementation passed to vi.fn(), so describeFrame still returns a frame.)
  describeFrame.mockReset()
  drawFrame.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  if (realOffsetParent) {
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', realOffsetParent)
  } else {
    delete window.HTMLElement.prototype.offsetParent
  }
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
})

describe('KaraokeStage rAF loop', () => {
  it('schedules a frame on mount', () => {
    wrapper = mount(KaraokeStage)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  it('keeps scheduling frames after a draw-path exception', () => {
    drawFrame.mockImplementationOnce(() => { throw new Error('renderer blew up') })
    wrapper = mount(KaraokeStage)

    tickFrame() // frame 1 — throws
    expect(drawFrame).toHaveBeenCalledTimes(1)
    // The re-arm is in `finally`, so the throw must not have skipped it.
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)
    expect(pendingFrames).toHaveLength(1)

    tickFrame() // frame 2 — the loop is alive and drawing again
    expect(drawFrame).toHaveBeenCalledTimes(2)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(3)
  })

  it('reports the error once, not once per frame', () => {
    drawFrame.mockImplementation(() => { throw new Error('every single frame') })
    wrapper = mount(KaraokeStage)

    for (let i = 0; i < 30; i++) tickFrame()

    expect(drawFrame).toHaveBeenCalledTimes(30)
    // First occurrence logs immediately; the rest fall inside the throttle
    // window (5s) and are dropped. 30 frames is well under a second of wall
    // clock in a test run.
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('rebalances the 2D drawing-state stack after a throw', () => {
    drawFrame.mockImplementationOnce(() => { throw new Error('threw mid-clip') })
    wrapper = mount(KaraokeStage)

    tickFrame()
    // The visualizers and the renderer core save()/restore() without a
    // try/finally, so a throw leaves entries on the stack. reset() drops the
    // whole stack (plus path/styles/bitmap) in one call.
    expect(ctxStub.reset).toHaveBeenCalledTimes(1)
    expect(ctxStub.restore).not.toHaveBeenCalled()
  })

  it('drains the stack with restore() when reset() is unavailable', () => {
    delete ctxStub.reset
    drawFrame.mockImplementationOnce(() => { throw new Error('threw mid-clip') })
    wrapper = mount(KaraokeStage)

    tickFrame()
    // Bounded drain; restore() on an empty stack is a no-op per spec.
    expect(ctxStub.restore.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(ctxStub.restore.mock.calls.length).toBeLessThanOrEqual(16)
  })

  it('cancels the pending frame on unmount', () => {
    wrapper = mount(KaraokeStage)
    wrapper.unmount()
    wrapper = null
    expect(window.cancelAnimationFrame).toHaveBeenCalled()
  })

  it('does not re-arm rAF for a frame that lands after unmount', () => {
    wrapper = mount(KaraokeStage)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    wrapper = null

    // The cancel already went out, but a frame can still be in flight (and the
    // popout's window may not honour a cancel at all). Running it must not
    // schedule another one.
    tickFrame()
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pendingFrames).toHaveLength(0)
  })

  it('completes teardown even if cancelAnimationFrame throws', () => {
    wrapper = mount(KaraokeStage)
    const canvas = wrapper.find('canvas').element
    const remove = vi.spyOn(canvas, 'removeEventListener')
    // A popout that has already been closed: the window rAF was scheduled on
    // is discarded, and whether touching it throws is engine-dependent.
    window.cancelAnimationFrame = vi.fn(() => { throw new Error('dead window') })

    wrapper.unmount()
    wrapper = null

    const events = remove.mock.calls.map(c => c[0])
    expect(events).toContain('contextlost')
    expect(events).toContain('contextrestored')
  })
})

describe('KaraokeStage 2D context loss', () => {
  it('re-acquires the context on contextrestored', async () => {
    wrapper = mount(KaraokeStage)
    expect(getContext).toHaveBeenCalledTimes(1)

    const canvas = wrapper.find('canvas').element
    canvas.dispatchEvent(new window.Event('contextrestored'))

    expect(getContext).toHaveBeenCalledTimes(2)
    expect(getContext).toHaveBeenLastCalledWith('2d')
  })

  it('stops drawing while the context is lost but keeps the loop armed', () => {
    wrapper = mount(KaraokeStage)
    const canvas = wrapper.find('canvas').element

    tickFrame()
    expect(drawFrame).toHaveBeenCalledTimes(1)

    canvas.dispatchEvent(new window.Event('contextlost'))
    tickFrame()
    tickFrame()
    // No draws into a dead context...
    expect(drawFrame).toHaveBeenCalledTimes(1)
    // ...but the loop is still ticking, so restore resumes instantly.
    expect(pendingFrames).toHaveLength(1)

    canvas.dispatchEvent(new window.Event('contextrestored'))
    tickFrame()
    expect(drawFrame).toHaveBeenCalledTimes(2)
  })

  it('resumes when the probe says the context is back, with no restore event', () => {
    // A user agent can restore the context without the element ever seeing a
    // `contextrestored` — e.g. the restore happens while the stage is
    // display:none. The docked stage never remounts, so if the event flag
    // outranked the probe it would stay dark for the rest of the show.
    ctxStub.isContextLost = vi.fn(() => false)
    wrapper = mount(KaraokeStage)
    const canvas = wrapper.find('canvas').element

    tickFrame()
    expect(drawFrame).toHaveBeenCalledTimes(1)

    ctxStub.isContextLost.mockReturnValue(true)
    canvas.dispatchEvent(new window.Event('contextlost'))
    tickFrame()
    expect(drawFrame).toHaveBeenCalledTimes(1)

    // Silent restore: probe flips, no event fires.
    ctxStub.isContextLost.mockReturnValue(false)
    tickFrame()
    expect(drawFrame).toHaveBeenCalledTimes(2)
  })

  it('does not draw when the probe reports loss with no contextlost event', () => {
    ctxStub.isContextLost = vi.fn(() => true)
    wrapper = mount(KaraokeStage)

    tickFrame()
    expect(drawFrame).not.toHaveBeenCalled()
    // Loop stays armed so the recovery is instant.
    expect(pendingFrames).toHaveLength(1)
  })

  it('drops the context listeners on unmount', () => {
    wrapper = mount(KaraokeStage)
    const canvas = wrapper.find('canvas').element
    const remove = vi.spyOn(canvas, 'removeEventListener')

    wrapper.unmount()
    wrapper = null

    const events = remove.mock.calls.map(c => c[0])
    expect(events).toContain('contextlost')
    expect(events).toContain('contextrestored')
  })
})
