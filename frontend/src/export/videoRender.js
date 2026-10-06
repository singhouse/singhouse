// SPDX-License-Identifier: AGPL-3.0-only
// videoRender.js — renders a song's lyric stage into video frames for export.
//
// The server opens an export session and encodes; this module paints each
// frame exactly as the live stage would at that song time (backdrop, then the
// letterboxed 640x480 lyric stage), encodes it as JPEG and sends the frames
// in order, in batches. The backdrop reacts to the chosen stem: the stem is
// decoded once and played through an OfflineAudioContext with an analyser,
// which is read at every frame time, so the backdrop sees what the live
// engine's analyser would have seen.
//
// Everything browser-specific (canvas, audio decoding, fonts, the HTTP calls)
// is injectable, so the frame loop runs under a test DOM with fakes.
import { describeFrame } from '@/stage/frame.mjs'
import { drawFrame } from '@/stage/draw.mjs'
import { lineFont } from '@/stage/layout.mjs'
import { getVisualizer } from '@/stage/visualizers/index.js'
import { ZERO_FRAME, analyseFrame, createAnalysisState } from '@/composables/audioReactive.js'

export const BATCH_SIZE = 30
export const MAX_BATCHES_IN_FLIGHT = 2
const JPEG_QUALITY = 0.92
// The live engine's analyser settings, so a backdrop moves the same way.
const FFT_SIZE = 1024
const SMOOTHING = 0.5
const TRANSPARENT = 'rgba(0,0,0,0)'
const EMPTY_MODEL = { duration: 0, tracks: {}, pages: [], silences: [] }

function abortError() {
  return new DOMException('Export cancelled', 'AbortError')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function defaultCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0))

export const browserAudio = {
  async fetchAudio(url, signal) {
    const response = await fetch(url, { credentials: 'same-origin', signal })
    if (!response.ok) throw new Error(`Audio request failed (${response.status})`)
    return response.arrayBuffer()
  },
  async decode(data) {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext
    const context = new Context()
    try {
      return await context.decodeAudioData(data)
    } finally {
      Promise.resolve(context.close?.()).catch(() => {})
    }
  },
  createOfflineContext(channels, length, sampleRate) {
    return new OfflineAudioContext(channels, length, sampleRate)
  },
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not encode a video frame'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

// Every font the stage will draw with must be loaded before the first frame,
// or early frames fall back to another face.
export async function loadStageFonts(model, fonts = globalThis.document?.fonts) {
  if (!fonts) return
  const specs = new Set()
  for (const page of model?.pages || []) {
    for (const line of page?.lines || []) specs.add(lineFont(line))
  }
  try { await fonts.ready } catch { /* fonts.ready never rejects in practice */ }
  await Promise.all([...specs].map(spec => Promise.resolve().then(() => fonts.load(spec)).catch(() => {})))
}

async function decodeStem(audio, url, signal) {
  if (!url) return null
  try {
    return await audio.decode(await audio.fetchAudio(url, signal))
  } catch {
    throwIfAborted(signal)
    return null // The backdrop rests for the whole video.
  }
}

// Calls `visit(index, audioFrame)` once per frame, in order, awaiting each.
// Without a decoded buffer every frame gets the zero frame.
export async function forEachAudioFrame({ buffer, count, fps, audio, visit }) {
  let next = 0
  const emit = async (limit, frame) => {
    while (next < limit && next < count) {
      await visit(next, frame)
      next++
    }
  }
  if (!buffer) {
    await emit(count, ZERO_FRAME)
    return
  }

  let context
  try {
    context = audio.createOfflineContext(1, buffer.length, buffer.sampleRate)
  } catch {
    await emit(count, ZERO_FRAME)
    return
  }
  const source = context.createBufferSource()
  source.buffer = buffer
  const analyser = context.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = SMOOTHING
  source.connect(analyser)
  analyser.connect(context.destination)
  source.start(0)

  const state = createAnalysisState()
  const freq = new Uint8Array(analyser.frequencyBinCount)
  const wave = new Uint8Array(analyser.fftSize)
  let failure = null
  let stop
  const stopped = new Promise(resolve => { stop = resolve })

  // Suspend points are scheduled one frame ahead, from inside the previous
  // one, so a failure or abort stops the walk at once: nothing further is
  // scheduled and the context is released to finish on its own.
  const schedule = (from) => {
    for (let i = from; i < count; i++) {
      const t = i / fps
      if (Math.floor(t * buffer.sampleRate) >= buffer.length) return
      let suspended
      try { suspended = context.suspend(t) } catch { continue }
      suspended.then(() => onFrame(i), () => {})
      return
    }
  }
  const onFrame = async (i) => {
    try {
      analyser.getByteFrequencyData(freq)
      analyser.getByteTimeDomainData(wave)
      const frame = analyseFrame(state, freq, wave)
      // A frame whose suspend was refused reuses the next reading.
      await emit(i + 1, frame)
      schedule(i + 1)
    } catch (error) {
      failure = error
      stop()
    } finally {
      Promise.resolve(context.resume()).catch(() => {})
    }
  }

  // Nothing has played at time zero.
  await emit(1, ZERO_FRAME)
  schedule(1)
  try {
    await Promise.race([context.startRendering(), stopped])
  } catch {
    // A failed analysis leaves the remaining frames resting, like no audio.
  }
  if (failure) throw failure
  // Past the end of the audio the backdrop rests.
  await emit(count, ZERO_FRAME)
}

// Sends frames in order: one batch uploading, at most one more waiting
// behind it. A push blocks while both slots are taken. Batches are chained
// rather than sent in parallel because the server refuses out-of-order frames.
function createSender({ session, api, total, onProgress, signal }) {
  let batch = []
  let start = 0
  let sent = 0
  let tail = Promise.resolve()
  const pending = []

  function dispatch() {
    if (batch.length === 0) return
    const frames = batch
    const index = start
    start += frames.length
    batch = []
    const request = tail.then(async () => {
      throwIfAborted(signal)
      await api.putFrames(session, index, frames, { signal })
      sent += frames.length
      onProgress(Math.min(1, sent / total))
    })
    request.catch(() => {}) // Surfaced through `pending`, never unhandled.
    tail = request
    pending.push(request)
  }

  return {
    async push(blob) {
      batch.push(blob)
      if (batch.length < BATCH_SIZE) return
      while (pending.length >= MAX_BATCHES_IN_FLIGHT) await pending.shift()
      dispatch()
    },
    async flush() {
      dispatch()
      while (pending.length) await pending.shift()
    },
  }
}

/**
 * Render `frameCount` frames for an open export session and send them.
 *
 * Resolves once every frame has been accepted; the caller then finishes the
 * session. On abort the session is cancelled (DELETE) and an AbortError is
 * thrown; no frame is sent after the abort.
 */
export async function renderVideo({
  session,
  frameCount,
  model,
  backdrop = 'none',
  audioUrl = null,
  fps = 30,
  width = 1280,
  height = 720,
  api,
  onProgress = () => {},
  signal,
  createCanvas = defaultCanvas,
  resolveVisualizer = getVisualizer,
  audio = browserAudio,
  fonts = globalThis.document?.fonts,
  yieldToHost = defaultYield,
}) {
  const total = Math.max(1, frameCount | 0)
  try {
    throwIfAborted(signal)
    const stageModel = model || EMPTY_MODEL
    await loadStageFonts(stageModel, fonts)
    throwIfAborted(signal)

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    const viz = backdrop && backdrop !== 'none' ? resolveVisualizer(backdrop) : null
    const renderState = { buffers: new Map(), viz: {} }
    const sender = createSender({ session, api, total, onProgress, signal })

    const paint = async (index, audioFrame) => {
      throwIfAborted(signal)
      const t = index / fps
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      if (viz) {
        viz.draw(ctx, width, height, {
          ...audioFrame,
          t,
          dt: 1 / fps,
          animate: true,
          buffers: renderState.buffers,
          viz: renderState.viz,
        })
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const frame = describeFrame(stageModel, t, { width, height })
      drawFrame(ctx, stageModel, frame, {
        width,
        height,
        background: viz ? TRANSPARENT : undefined,
        time: t,
      })
      const blob = await toJpeg(canvas)
      throwIfAborted(signal)
      await sender.push(blob)
      await yieldToHost()
    }

    const buffer = await decodeStem(audio, audioUrl, signal)
    await forEachAudioFrame({ buffer, count: total, fps, audio, visit: paint })
    throwIfAborted(signal)
    await sender.flush()
  } catch (error) {
    if (signal?.aborted) {
      try { await api.cancel(session) } catch { /* the server reaps it */ }
      throw abortError()
    }
    throw error
  }
}
