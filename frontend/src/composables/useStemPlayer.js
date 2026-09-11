// SPDX-License-Identifier: AGPL-3.0-only
// Decoded-buffer stem player for the editor lab.
//
// The lab needs sample-accurate seeking, gapless line-looping, and the raw
// PCM for the spectrogram — none of which a streaming <audio> element gives
// us cleanly. So: fetch the stem once, decodeAudioData, and play through
// one-shot AudioBufferSourceNodes. The decoded PCM doubles as the
// spectrogram's input (no second download).

import { ref, shallowRef } from 'vue'

export function useStemPlayer() {
  const buffer = shallowRef(null) // AudioBuffer | null
  const loading = ref(false)
  const error = ref('')
  const playing = ref(false)

  let ctx = null
  let source = null
  let startedAt = 0 // ctx.currentTime at source start, minus start offset
  let pausedAt = 0 // playhead position while paused
  let loopRange = null // [start, end] | null
  let mono = null // cached mono mixdown
  let loadSeq = 0 // guards against out-of-order loads

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
    return ctx
  }

  function stopSource() {
    if (!source) return
    source.onended = null
    try { source.stop() } catch { /* already stopped */ }
    source.disconnect()
    source = null
  }

  async function loadUrl(url) {
    const seq = ++loadSeq
    stopSource()
    playing.value = false
    buffer.value = null
    mono = null
    pausedAt = 0
    error.value = ''
    if (!url) return
    loading.value = true
    try {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      const decoded = await ensureCtx().decodeAudioData(bytes)
      if (seq !== loadSeq) return // a newer load superseded this one
      buffer.value = decoded
    } catch (e) {
      if (seq === loadSeq) error.value = e.message || String(e)
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  function unload() {
    loadSeq++
    stopSource()
    playing.value = false
    buffer.value = null
    mono = null
    pausedAt = 0
    loading.value = false
    error.value = ''
  }

  /** Mono mixdown of the decoded buffer (cached) — spectrogram input. */
  function monoSamples() {
    if (!buffer.value) return null
    if (mono) return mono
    const b = buffer.value
    if (b.numberOfChannels === 1) {
      mono = b.getChannelData(0)
      return mono
    }
    mono = new Float32Array(b.length)
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const d = b.getChannelData(ch)
      for (let i = 0; i < d.length; i++) mono[i] += d[i]
    }
    const scale = 1 / b.numberOfChannels
    for (let i = 0; i < mono.length; i++) mono[i] *= scale
    return mono
  }

  function play(from = pausedAt) {
    if (!buffer.value) return
    const c = ensureCtx()
    if (c.state === 'suspended') c.resume()
    stopSource()
    const dur = buffer.value.duration
    let offset = Math.min(Math.max(from, 0), Math.max(0, dur - 0.01))
    if (loopRange && (offset < loopRange[0] - 0.5 || offset >= loopRange[1])) {
      offset = loopRange[0] // don't start a "loop" from outside the loop
    }
    source = c.createBufferSource()
    source.buffer = buffer.value
    if (loopRange) {
      source.loop = true
      source.loopStart = loopRange[0]
      source.loopEnd = Math.min(loopRange[1], dur)
    }
    source.connect(c.destination)
    source.start(0, offset)
    startedAt = c.currentTime - offset
    playing.value = true
    source.onended = () => {
      // Natural end-of-buffer (loops never end on their own).
      pausedAt = dur
      playing.value = false
      source = null
    }
  }

  /** Current playhead position in seconds. */
  function now() {
    if (!playing.value || !ctx) return pausedAt
    let t = ctx.currentTime - startedAt
    if (loopRange && t > loopRange[1]) {
      const len = Math.max(loopRange[1] - loopRange[0], 1e-3)
      t = loopRange[0] + ((t - loopRange[0]) % len)
    }
    const dur = buffer.value?.duration
    return dur ? Math.min(t, dur) : t
  }

  function pause() {
    if (playing.value) pausedAt = now()
    stopSource()
    playing.value = false
  }

  function seek(t) {
    const clamped = Math.max(0, t)
    if (playing.value) play(clamped)
    else pausedAt = clamped
  }

  /** Set (or clear, with null) the loop range. Takes effect immediately. */
  function setLoop(range) {
    const changed = JSON.stringify(range) !== JSON.stringify(loopRange)
    loopRange = range
    if (changed && playing.value) play(now())
  }

  function dispose() {
    unload()
    if (ctx) {
      ctx.close().catch(() => {})
      ctx = null
    }
  }

  return {
    buffer, loading, error, playing,
    loadUrl, unload, monoSamples,
    play, pause, seek, now, setLoop, dispose,
  }
}
