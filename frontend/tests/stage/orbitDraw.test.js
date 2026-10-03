// SPDX-License-Identifier: AGPL-3.0-only
// Orbit draws its crisp layers straight onto the stage's device ctx, which the
// lyric renderer reuses right after. These pin that it leaves that ctx exactly
// as found, survives degenerate sizes, and bakes its lyric shade once per size.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import orbit from '@/stage/visualizers/particles.js'
import tidal from '@/stage/visualizers/tidal.js'
import ember from '@/stage/visualizers/ember.js'

// A recording 2D context: state is tracked for save/restore, every other
// method is a no-op (gradients return a stub with addColorStop).
function fakeCtx() {
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true }
  const stack = []
  const gradient = () => ({ addColorStop() {} })
  const target = {
    ...state,
    depth: 0,
    fills: 0,
    save() { stack.push({ ...pick(this) }); this.depth++ },
    restore() { if (stack.length) { Object.assign(this, stack.pop()); this.depth-- } },
    createRadialGradient: gradient,
    createLinearGradient: gradient,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    fillRect() { this.fills++ },
  }
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true },
  })
}
const pick = c => ({
  globalAlpha: c.globalAlpha,
  globalCompositeOperation: c.globalCompositeOperation,
  imageSmoothingEnabled: c.imageSmoothingEnabled,
})

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = { width: 0, height: 0 }
      canvas.getContext = () => fakeCtx()
      return canvas
    },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const frame = (buffers, viz, t = 12) => ({
  t, dt: 1 / 60, level: 0.5, bands: { bass: 0.5, mid: 0.4, treble: 0.2 },
  beat: 0, freq: null, waveform: null, animate: true, buffers, viz,
})

describe('Orbit draw', () => {
  it('leaves the device ctx as found at every size', () => {
    const buffers = new Map(), viz = {}
    for (const [w, h] of [[3840, 2160], [1920, 1080], [1, 1], [0, 0], [5, 3000]]) {
      const ctx = fakeCtx()
      expect(() => orbit.draw(ctx, w, h, frame(buffers, viz))).not.toThrow()
      expect(ctx.depth).toBe(0)
      expect(pick(ctx)).toEqual({ globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true })
    }
  })

  it('bakes the lyric shade once per size', () => {
    const buffers = new Map(), viz = {}
    const draw = (w, h, t) => orbit.draw(fakeCtx(), w, h, frame(buffers, viz, t))
    const fills = () => buffers.get('orbit-shade').ctx.fills
    draw(1920, 1080, 1)
    expect(fills()).toBe(1)
    draw(1920, 1080, 2)
    draw(1920, 1080, 3)
    expect(fills()).toBe(1) // repeat frames reuse the bake
    draw(3840, 2160, 4) // same downscaled buffer, new device size → rebake
    expect(fills()).toBe(2)
    buffers.delete('orbit-shade') // a replaced buffer always rebakes
    draw(3840, 2160, 5)
    expect(fills()).toBe(1)
  })
})


describe('song-time backdrops', () => {
  for (const visualizer of [orbit, tidal, ember]) {
    it(`${visualizer.name} retains audio luminance on pause with capped per-stage buffers`, () => {
      const buffers = new Map(), viz = {}
      const playing = frame(buffers, viz)
      visualizer.draw(fakeCtx(), 3840, 2160, playing)
      const saved = { ...viz[visualizer.id] }
      visualizer.draw(fakeCtx(), 3840, 2160, {
        ...playing, animate: false, level: 0, bands: { bass: 0, mid: 0, treble: 0 },
      })
      expect(viz[visualizer.id]).toEqual(saved)
      for (const buffer of buffers.values()) {
        expect(Math.max(buffer.w, buffer.h)).toBeLessThanOrEqual(720)
      }
      const otherViz = {}
      visualizer.draw(fakeCtx(), 800, 450, frame(new Map(), otherViz))
      expect(otherViz[visualizer.id]).not.toBe(viz[visualizer.id])
    })
  }
})
