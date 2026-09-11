<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div ref="containerRef" class="karaoke-stage">
    <canvas ref="canvasRef" class="karaoke-stage__canvas" />
  </div>
</template>

<script setup>
// KaraokeStage — app-side display wrapper around the stage renderer core.
// Pure display: no audio, no fetching. The caller parses the model
// (normalizeWordSync) and drives `currentTime` from its own audio clock.
//
// Layering happens on one canvas per frame: the audio-reactive backdrop
// visualizer (or the core's flat fill) paints the full device canvas first,
// then the core's describeFrame/drawFrame letterboxes the 640x480 virtual
// stage on top in CSS pixels. With a visualizer active the core is handed a
// fully transparent background so its fill is a no-op over the backdrop.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { describeFrame } from './frame.mjs'
import { drawFrame } from './draw.mjs'
import { getVisualizer } from './visualizers/index.js'
import { sample } from '@/composables/audioReactive.js'

const props = defineProps({
  // Parsed model from normalizeWordSync(). null renders the backdrop only.
  model:       { type: Object, default: null },
  // Audio clock position in seconds.
  currentTime: { type: Number, default: 0 },
  // Backdrop visualizer id: 'none' or any id in visualizers/index.js.
  // 'none' = flat fill, zero cost; an unresolvable id falls back to it.
  visualizer:  { type: String, default: 'none' },
  // Which audio tap the visualizer reacts to ('mix' | 'inst' | 'vocals').
  audioSource: { type: String, default: 'mix' },
  // Playback state — when false the backdrop draws a resting/frozen frame.
  playing:     { type: Boolean, default: false },
})

const EMPTY_MODEL = { duration: 0, tracks: {}, pages: [], silences: [] }
const TRANSPARENT = 'rgba(0,0,0,0)'

const containerRef = ref(null)
const canvasRef = ref(null)
let ctx = null
let rafId = 0
let rafWin = null
let resizeObserver = null

// Set by the `contextlost` handler. `ctx.isContextLost()` is the authoritative
// test, but it is not implemented everywhere the EVENT is, so track the state
// ourselves too and treat either signal as "do not draw". The flag is a
// fallback, never an override: where the probe exists it also gets to CLEAR
// the flag (see drawFrameOnce).
let contextLost = false

// Set FIRST in onBeforeUnmount so a frame already in flight does not re-arm
// rAF on a component that is going away (and, after a popout close, on a
// window that may already be discarded).
let stopped = false

// Draw errors are logged at most once per interval. A throw inside the frame
// body used to kill the loop outright; now that it doesn't, an error that
// reproduces every frame would otherwise write 60 lines a second into the
// console of a machine that is running a show.
const ERROR_LOG_INTERVAL_MS = 5000
let lastErrorLogAt = 0

function logDrawError(err) {
  const now = Date.now()
  if (lastErrorLogAt && now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return
  lastErrorLogAt = now
  console.error('KaraokeStage: frame draw failed (loop continues):', err)
}

// Per-stage render state: offscreen-buffer cache + per-visualizer animation
// vars, owned here so two live stages (docked preview + popout host) never
// share — a shared buffer keyed only by visualizer id gets destroyed and
// recreated every frame when the two stages differ in size, which was tanking
// FPS and flashing the backdrop. Created once; persists across frames.
const renderState = { buffers: new Map(), viz: {}, lastBackdropT: 0 }

// The canvas can be reparented into the documentPictureInPicture window; rAF
// and devicePixelRatio must come from *its* window, or the browser throttles
// drawing whenever the main host window is hidden.
function winOf(el) {
  return (el && el.ownerDocument && el.ownerDocument.defaultView) || window
}

function fit() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  const rect = container.getBoundingClientRect()
  const dpr = winOf(canvas).devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

// One frame's worth of drawing. Reads the latest props, so model/currentTime/
// backdrop changes take effect on the next frame with no explicit watchers.
// Anything in here MAY throw — loop() is what guarantees the next frame.
function drawFrameOnce() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  // A lost 2D context accepts every draw call and paints nothing. Skip the
  // work until it comes back; the field symptom was a popout stuck on a
  // gradient with no lyrics on it.
  if (contextLost) {
    // The event told us it was lost. Where the user agent implements the
    // authoritative probe, trust IT to tell us the context came back — even if
    // `contextrestored` never fired (e.g. the restore happened while this stage
    // was display:none). Otherwise the flag is sticky and a stage that never
    // remounts — the docked one — stays dark for the rest of the show.
    if (ctx.isContextLost && !ctx.isContextLost()) {
      contextLost = false
      fit() // restored contexts come back cleared and at default size
    } else {
      return
    }
  } else if (ctx.isContextLost?.()) {
    // Lost without an event reaching us (or before it did).
    return
  }
  // Skip all drawing while this stage is hidden (display:none → offsetParent
  // null). The host keeps a second ScreenStage mounted as the popout host,
  // hidden until popped out; rAF fires for hidden elements too, so without this
  // it would render a full backdrop into a 0-size canvas every frame for
  // nothing. The rAF keeps ticking so we resume instantly when it's shown.
  if (canvas.offsetParent === null) return

  fit()
  const dpr = winOf(canvas).devicePixelRatio || 1
  const cw = canvas.width, ch = canvas.height

  // Backdrop (full device canvas, incl. letterbox area) — a registered
  // audio-reactive visualizer, or the core's flat fill when 'none'/unknown.
  // Hand every visualizer a clean compositing state, and never trust one to
  // leave it clean — a stray 'lighter'/alpha would make the lyrics render wrong.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  const viz = props.visualizer && props.visualizer !== 'none' ? getVisualizer(props.visualizer) : null
  if (viz) {
    let dt = props.currentTime - renderState.lastBackdropT
    if (!(dt >= 0) || dt > 0.5) dt = 0 // first frame / seek / pause gap → no step
    renderState.lastBackdropT = props.currentTime
    const a = sample(props.audioSource) || {}
    viz.draw(ctx, cw, ch, {
      t: props.currentTime,
      dt,
      level: a.level || 0,
      bands: a.bands || { bass: 0, mid: 0, treble: 0 },
      beat: a.beat || 0,
      freq: a.freq || null,
      waveform: a.waveform || null,
      animate: props.playing,
      buffers: renderState.buffers, // per-stage offscreen-buffer Map (getBuffer)
      viz: renderState.viz,         // per-stage per-visualizer animation state
    })
    // Re-assert clean state before lyrics, whatever the visualizer left behind.
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  // Lyrics: the core draws in CSS pixels on a DPR-scaled context.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const width = cw / dpr
  const height = ch / dpr
  const model = props.model || EMPTY_MODEL
  const frame = describeFrame(model, props.currentTime, { width, height })
  drawFrame(ctx, model, frame, {
    width,
    height,
    background: viz ? TRANSPARENT : undefined,
    time: props.currentTime,
  })
}

// The rAF re-arm is in `finally`, so it survives ANY throw out of the frame
// body — a bad model, a visualizer bug, a renderer regression. Before this,
// one exception permanently froze the stage for the rest of the show with no
// recovery short of reloading the page. The frame that threw is dropped; the
// next one is attempted normally. The one thing that stops the loop is
// unmount, via the `stopped` flag.
function loop() {
  try {
    drawFrameOnce()
  } catch (err) {
    logDrawError(err)
    // The visualizers and the renderer core use save()/restore() pairs with no
    // try/finally of their own, so a throw part-way through a frame orphans
    // whatever was pushed. Surviving the throw means a per-frame error would
    // leak stack entries (and a stale clip/transform) sixty times a second, so
    // rebalance here. reset() is the clean answer — it drops the whole drawing-
    // state stack, the current path, the styles and the bitmap, and the next
    // frame repaints everything anyway. Where it isn't implemented, drain with
    // a bounded pop instead; restore() on an empty stack is a no-op per spec,
    // so over-draining is harmless and the bound keeps this O(1).
    if (ctx) {
      try {
        if (typeof ctx.reset === 'function') ctx.reset()
        else for (let i = 0; i < 16; i++) ctx.restore()
      } catch { /* a dead context can throw here; the next frame re-checks */ }
    }
  } finally {
    if (!stopped) {
      rafWin = winOf(canvasRef.value)
      rafId = rafWin.requestAnimationFrame(loop)
    }
  }
}

// Canvas 2D contexts can be lost (GPU reset, backgrounded compositor, and —
// the case that bit us — a canvas reparented into a popup window).
function onContextLost() {
  // Deliberately NOT preventDefault(): for the 2D context the canceled flag
  // tells the user agent to skip automatic restoration, which is the opposite
  // of the WebGL convention. We want the browser to restore it for us.
  contextLost = true
  console.warn('KaraokeStage: 2D context lost; drawing paused until restore')
}

function onContextRestored() {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  contextLost = false
  // The restored context comes back with default state and a cleared bitmap;
  // re-apply the backing-store size before the next frame draws into it.
  fit()
}

onMounted(() => {
  const canvas = canvasRef.value
  ctx = canvas.getContext('2d')
  if (!ctx) {
    // The loop tolerates a null ctx (it just never draws), which reads as a
    // silently black stage. Say why once: getContext returning null means the
    // browser refused a new 2D context (canvas/GPU state wedged, or memory).
    console.error('KaraokeStage: getContext(\'2d\') returned null — stage will stay blank until the page (or browser) is restarted')
  }
  canvas.addEventListener('contextlost', onContextLost)
  canvas.addEventListener('contextrestored', onContextRestored)
  fit()
  resizeObserver = new ResizeObserver(fit)
  resizeObserver.observe(containerRef.value)
  rafWin = winOf(canvas)
  rafId = rafWin.requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  // First, so a frame already in flight cannot re-arm itself behind us.
  stopped = true
  try {
    if (rafWin) rafWin.cancelAnimationFrame(rafId)
  } catch {
    // rafWin may be the popup window, already discarded by the time this
    // component unmounts; whether that throws is engine-dependent. It must not
    // take the rest of the teardown (observer, listeners) down with it.
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  const canvas = canvasRef.value
  if (canvas) {
    canvas.removeEventListener('contextlost', onContextLost)
    canvas.removeEventListener('contextrestored', onContextRestored)
  }
  ctx = null
})
</script>

<style scoped>
.karaoke-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.karaoke-stage__canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
