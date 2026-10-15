// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The video export frame loop: every frame is painted (backdrop, then the
// lyric stage), encoded and sent in order, in batches, with progress; the
// backdrop receives the per-frame audio analysis; and an abort cancels the
// session without sending anything further.

import { describe, expect, it, vi } from 'vitest'
import { normalizeWordSync } from '@/stage/adapter.mjs'
import { lineFont } from '@/stage/layout.mjs'
import { BATCH_SIZE, renderVideo } from '@/export/videoRender.js'

const DOC = {
  lines: [
    [
      { text: 'Lorem', start: 0.1, end: 0.6 },
      { text: 'ipsum', start: 0.7, end: 1.2 },
    ],
    [
      { text: 'dolor', start: 1.5, end: 2.0 },
    ],
  ],
}

function fakeContext() {
  const texts = []
  const state = {}
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'measureText') return text => ({ width: String(text).length * 10 })
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (key === 'fillText') return text => texts.push(String(text))
      return () => {}
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  })
  return { ctx, texts }
}

function fakeCanvasFactory() {
  const made = []
  const factory = vi.fn((width, height) => {
    const { ctx, texts } = fakeContext()
    let encoded = 0
    const canvas = {
      width,
      height,
      texts,
      getContext: () => ctx,
      toBlob(callback, type, quality) {
        canvas.lastType = type
        canvas.lastQuality = quality
        callback(new Blob([`frame-${encoded++}`], { type }))
      },
    }
    made.push(canvas)
    return canvas
  })
  factory.made = made
  return factory
}

function fakeApi({ hold = false } = {}) {
  const puts = []
  const cancels = []
  const waiting = []
  return {
    puts,
    cancels,
    waiting,
    putFrames: vi.fn((session, index, frames) => {
      puts.push({ session, index, count: frames.length, frames })
      if (!hold) return Promise.resolve({ data: { received: index + frames.length } })
      return new Promise(resolve => waiting.push(resolve))
    }),
    cancel: vi.fn(async session => { cancels.push(session) }),
  }
}

// An OfflineAudioContext stand-in: rendering walks the scheduled suspends in
// time order and waits for resume() before moving on, as the real one does.
function fakeAudio({ bins = 200 } = {}) {
  const contexts = []
  return {
    contexts,
    fetchAudio: vi.fn(async () => new ArrayBuffer(8)),
    decode: vi.fn(async () => ({ length: 44100 * 2, sampleRate: 44100 })),
    createOfflineContext(channels, length, sampleRate) {
      let onResume = null
      const context = {
        channels,
        length,
        sampleRate,
        suspends: [],
        destination: {},
        createBufferSource: () => ({ connect() {}, start() {} }),
        createAnalyser: () => ({
          fftSize: 2048,
          smoothingTimeConstant: 0.8,
          get frequencyBinCount() { return this.fftSize / 2 },
          connect() {},
          getByteFrequencyData(array) { array.fill(bins) },
          getByteTimeDomainData(array) { array.fill(128) },
        }),
        suspend(t) {
          return new Promise(resolve => context.suspends.push({ t, resolve }))
        },
        resume() {
          onResume?.()
          return Promise.resolve()
        },
        async startRendering() {
          const done = new Set()
          for (;;) {
            const entry = context.suspends
              .filter(e => !done.has(e))
              .sort((a, b) => a.t - b.t)[0]
            if (!entry) return
            done.add(entry)
            const resumed = new Promise(resolve => { onResume = resolve })
            entry.resolve()
            await resumed
          }
        },
      }
      contexts.push(context)
      return context
    },
  }
}

function baseOptions(overrides = {}) {
  return {
    session: 'session-token-1234567890',
    model: normalizeWordSync(DOC),
    fps: 30,
    width: 1280,
    height: 720,
    createCanvas: fakeCanvasFactory(),
    audio: fakeAudio(),
    fonts: { ready: Promise.resolve(), load: vi.fn(async () => []) },
    yieldToHost: () => Promise.resolve(),
    ...overrides,
  }
}

describe('renderVideo', () => {
  it('renders every frame at 1280x720 and sends them in ordered batches with progress', async () => {
    const api = fakeApi()
    const progress = []
    const options = baseOptions({
      api,
      frameCount: 75,
      onProgress: f => progress.push(f),
    })
    await renderVideo(options)

    const canvas = options.createCanvas.made[0]
    expect(options.createCanvas).toHaveBeenCalledWith(1280, 720)
    expect(canvas.lastType).toBe('image/jpeg')
    expect(canvas.lastQuality).toBe(0.92)
    expect(api.puts.map(p => [p.index, p.count])).toEqual([[0, BATCH_SIZE], [30, 30], [60, 15]])
    expect(api.puts.every(p => p.session === 'session-token-1234567890')).toBe(true)
    const sent = api.puts.flatMap(p => p.frames)
    expect(sent).toHaveLength(75)
    expect(await sent[0].text()).toBe('frame-0')
    expect(await sent[74].text()).toBe('frame-74')
    expect(progress).toEqual([30 / 75, 60 / 75, 1])
    // The lyric stage was drawn over the frames.
    expect(canvas.texts).toContain('Lorem')
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('loads the stage fonts before painting', async () => {
    const options = baseOptions({ api: fakeApi(), frameCount: 2 })
    await renderVideo(options)
    const fonts = new Set(options.model.pages.flatMap(p => p.lines.map(lineFont)))
    expect(fonts.size).toBeGreaterThan(0)
    for (const font of fonts) expect(options.fonts.load).toHaveBeenCalledWith(font)
  })

  it('hands the backdrop the analysed audio frame for each frame time', async () => {
    const draws = []
    const viz = { id: 'test', draw: vi.fn((ctx, w, h, frame) => draws.push({ w, h, ...frame, bands: { ...frame.bands } })) }
    const audio = fakeAudio({ bins: 200 })
    const options = baseOptions({
      api: fakeApi(),
      frameCount: 4,
      backdrop: 'test',
      audioUrl: '/api/songs/7/stems/karaoke.flac',
      audio,
      resolveVisualizer: id => (id === 'test' ? viz : null),
    })
    await renderVideo(options)

    expect(audio.fetchAudio).toHaveBeenCalledWith('/api/songs/7/stems/karaoke.flac', undefined)
    const context = audio.contexts[0]
    expect(context.suspends.map(s => s.t)).toEqual([1 / 30, 2 / 30, 3 / 30])
    expect(draws).toHaveLength(4)
    expect(draws.map(d => d.t)).toEqual([0, 1 / 30, 2 / 30, 3 / 30])
    for (const d of draws) {
      expect([d.w, d.h]).toEqual([1280, 720])
      expect(d.dt).toBeCloseTo(1 / 30)
      expect(d.animate).toBe(true)
      expect(d.buffers).toBeInstanceOf(Map)
    }
    // Nothing has played at time zero; afterwards the bands follow the audio.
    expect(draws[0].level).toBe(0)
    expect(draws[0].bands).toEqual({ bass: 0, mid: 0, treble: 0 })
    expect(draws[1].bands.bass).toBeCloseTo(200 / 255)
    expect(draws[1].freq).toBeInstanceOf(Uint8Array)
    expect(draws[1].freq).toHaveLength(512)
    expect(draws[1].waveform).toHaveLength(1024)
  })

  it('rests the backdrop on the zero frame when the audio cannot be decoded', async () => {
    const draws = []
    const viz = { id: 'test', draw: (ctx, w, h, frame) => draws.push(frame) }
    const audio = fakeAudio()
    audio.decode.mockRejectedValue(new Error('unsupported'))
    await renderVideo(baseOptions({
      api: fakeApi(),
      frameCount: 3,
      backdrop: 'test',
      audioUrl: '/x.flac',
      audio,
      resolveVisualizer: () => viz,
    }))
    expect(draws).toHaveLength(3)
    for (const frame of draws) {
      expect(frame.level).toBe(0)
      expect(frame.freq).toBeNull()
    }
  })

  it('uses the flat fill when the backdrop is none', async () => {
    const resolveVisualizer = vi.fn()
    await renderVideo(baseOptions({ api: fakeApi(), frameCount: 2, backdrop: 'none', resolveVisualizer }))
    expect(resolveVisualizer).not.toHaveBeenCalled()
  })

  it('keeps at most two batches outstanding', async () => {
    const api = fakeApi({ hold: true })
    const options = baseOptions({ api, frameCount: 120 })
    let painted = 0
    const canvasFactory = options.createCanvas
    options.createCanvas = (w, h) => {
      const canvas = canvasFactory(w, h)
      const toBlob = canvas.toBlob
      canvas.toBlob = (...args) => { painted++; toBlob(...args) }
      return canvas
    }
    const run = renderVideo(options)
    for (let i = 0; i < 50; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    // One batch uploading, one queued behind it, and the renderer waiting
    // with the third batch full.
    expect(api.puts).toHaveLength(1)
    expect(painted).toBe(90)

    while (api.waiting.length || api.puts.length < 4) {
      const next = api.waiting.shift()
      if (next) next({ data: {} })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await run
    expect(api.puts.map(p => p.index)).toEqual([0, 30, 60, 90])
  })

  it('cancels the session on abort and sends nothing further', async () => {
    const api = fakeApi()
    const controller = new AbortController()
    const options = baseOptions({
      api,
      frameCount: 300,
      signal: controller.signal,
      onProgress: () => { if (api.puts.length === 1) controller.abort() },
    })
    await expect(renderVideo(options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.puts).toHaveLength(1)
    expect(api.cancel).toHaveBeenCalledTimes(1)
    expect(api.cancel).toHaveBeenCalledWith('session-token-1234567890')
  })

  it('stops walking the audio as soon as the export is aborted', async () => {
    const api = fakeApi()
    const audio = fakeAudio()
    const controller = new AbortController()
    let painted = 0
    const viz = { id: 'test', draw: () => { if (++painted === 5) controller.abort() } }
    const options = baseOptions({
      api,
      frameCount: 60,
      backdrop: 'test',
      audioUrl: '/x.flac',
      audio,
      resolveVisualizer: () => viz,
      signal: controller.signal,
    })
    await expect(renderVideo(options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(audio.contexts[0].suspends.length).toBeLessThanOrEqual(6)
    expect(api.putFrames).not.toHaveBeenCalled()
    expect(api.cancel).toHaveBeenCalledWith('session-token-1234567890')
  })

  it('does not cancel or send for a non-abort failure beyond the failing request', async () => {
    const api = fakeApi()
    api.putFrames.mockRejectedValueOnce(Object.assign(new Error('Expected frame 0, got 30'), { status: 409 }))
    await expect(renderVideo(baseOptions({ api, frameCount: 90 }))).rejects.toThrow('Expected frame 0')
    expect(api.putFrames).toHaveBeenCalledTimes(1)
    expect(api.cancel).not.toHaveBeenCalled()
  })
})
