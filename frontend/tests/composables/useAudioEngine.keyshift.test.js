// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The key-shift lifecycle the Signalsmith swap introduced: a StretchNode is
// created and start()'d per stem EAGERLY at load while DISCONNECTED, then
// spliced into the live graph only when a key is engaged (bypass-at-0). The
// shipped audio never runs through the test, so everything Web Audio is faked:
// a stub AudioContext hands out recording gain/analyser/source nodes, and the
// vendored Signalsmith factory is mocked through the signalsmithLoader seam
// (its real `/vendor/...` dynamic import can't resolve under jsdom).
//
// What this pins that static review can't: start() MUST precede any schedule()
// — in the real module an un-started node's segment is active:false and emits
// silence, so a future edit that drops or reorders start() would mute every
// transposed stem. That ordering is asserted explicitly below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Shared recording state between the mocked factory and the assertions.
const h = vi.hoisted(() => {
  const nodes = []
  const factory = vi.fn(async () => {
    const node = {
      start: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      latency: vi.fn().mockResolvedValue(0.05),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    nodes.push(node)
    return node
  })
  return { nodes, factory }
})

vi.mock('@/composables/signalsmithLoader.js', () => ({
  loadStretchFactory: vi.fn().mockResolvedValue(h.factory),
}))

import { useAudioEngine } from '@/composables/useAudioEngine.js'

// ── Web Audio + media stubs ────────────────────────────────────────────────
let sources // MediaElementSource stubs, in stem-creation order
let gains    // every GainNode handed out, in creation order

function makeGain() {
  return {
    gain: {
      value: 1,
      setTargetAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

class FakeAudioContext {
  constructor() {
    this.destination = { id: 'dest' }
    this.audioWorklet = {} // truthy → key shift "supported"
    this.currentTime = 0
    this.sampleRate = 44100
    this.state = 'running'
  }
  createGain() { const g = makeGain(); gains.push(g); return g }
  createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), disconnect: vi.fn() } }
  createMediaElementSource(el) { const s = { el, connect: vi.fn(), disconnect: vi.fn() }; sources.push(s); return s }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

class FakeAudio {
  constructor() { this._h = {}; this.currentTime = 0; this.duration = 180 }
  addEventListener(type, cb) { this._h[type] = cb }
  removeEventListener() {}
  load() { this._h.loadedmetadata && this._h.loadedmetadata() } // resolves loadStems' wait
  play() { return Promise.resolve() }
  pause() {}
}

beforeEach(() => {
  h.nodes.length = 0
  h.factory.mockClear()
  sources = []
  gains = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('isSecureContext', true)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// One stem with a url (inst) + a null stem, so we also assert a url-less
// stem gets no node.
async function loadOneStem() {
  const engine = useAudioEngine()
  await engine.loadStems([
    { key: 'vocals', url: null, kind: 'vocal', volume: 1 },
    { key: 'inst', url: 'blob:inst', kind: 'instrumental', volume: 1 },
  ])
  return engine
}

describe('useAudioEngine key-shift lifecycle (Signalsmith)', () => {
  it('eagerly creates + start()s exactly one node for the one available stem', async () => {
    const engine = await loadOneStem()
    expect(engine.keyShiftSupported.value).toBe(true)
    expect(h.factory).toHaveBeenCalledTimes(1)      // url-less stems make no node
    expect(h.nodes).toHaveLength(1)
    expect(h.nodes[0].start).toHaveBeenCalledTimes(1)
    expect(h.nodes[0].latency).toHaveBeenCalledTimes(1) // latency cached for lyric sync
    // At key 0 the node exists but is never spliced in.
    expect(h.nodes[0].schedule).not.toHaveBeenCalled()
    expect(h.nodes[0].connect).not.toHaveBeenCalled()
    expect(sources[0].connect).toHaveBeenCalledTimes(1) // bypass: src -> gain only
  })

  it('splices the node in on key!=0, and start() precedes any schedule()', async () => {
    const engine = await loadOneStem()
    const node = h.nodes[0]
    const src = sources[0]
    src.connect.mockClear()

    expect(engine.setKey(3)).toBe(true)
    expect(engine.keyOffset.value).toBe(3)
    vi.advanceTimersByTime(30)          // let the zero-crossing dip timer fire
    await Promise.resolve()             // settle the fire-and-forget schedule()

    // Transpose reached the node, formant comp explicitly OFF by design.
    expect(node.schedule).toHaveBeenCalledWith({ semitones: 3, formantCompensation: false })
    // The invariant that only shows up as silence in production:
    expect(node.start.mock.invocationCallOrder[0])
      .toBeLessThan(node.schedule.mock.invocationCallOrder[0])
    // Chain is now src -> node -> gain.
    expect(src.connect).toHaveBeenCalledWith(node)
    expect(node.connect).toHaveBeenCalledWith(gains[0]) // gains[0] = inst volume gain
  })

  it('returns to pure bypass on key 0 (node disconnected, src -> gain)', async () => {
    const engine = await loadOneStem()
    const node = h.nodes[0]
    const src = sources[0]

    engine.setKey(4)
    vi.advanceTimersByTime(30)
    await Promise.resolve()
    node.disconnect.mockClear()
    src.connect.mockClear()

    engine.setKey(0)
    expect(engine.keyOffset.value).toBe(0)
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(node.disconnect).toHaveBeenCalled()          // pulled out of the graph
    expect(src.connect).toHaveBeenCalledWith(gains[0])  // src -> gain bypass restored
  })

  it('retunes a non-zero -> non-zero change in place without a reroute', async () => {
    const engine = await loadOneStem()
    const node = h.nodes[0]

    engine.setKey(2)
    vi.advanceTimersByTime(30)
    await Promise.resolve()
    node.connect.mockClear()
    node.schedule.mockClear()

    engine.setKey(5)                    // no zero-crossing: schedule only, no timer
    await Promise.resolve()
    expect(node.schedule).toHaveBeenCalledWith({ semitones: 5, formantCompensation: false })
    expect(node.connect).not.toHaveBeenCalled() // no re-splice
  })
})
