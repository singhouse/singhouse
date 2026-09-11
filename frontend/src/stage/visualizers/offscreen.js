// SPDX-License-Identifier: AGPL-3.0-only
// offscreen.js — downscaled offscreen-buffer helper for visualizers.
//
// Full-canvas gradient / blur fills at device resolution (retina laptops, 4K
// projectors) are fill-rate bound; rendering into a small buffer and blitting
// it up keeps FPS high while the upscale blur hides the lost detail. Any
// visualizer that wants this asks for a buffer by a unique key.
//
// Buffers live in a PER-STAGE Map (owned by each KaraokeStage and threaded in
// as `frame.buffers`), NOT a module singleton: the host renders two stages at
// once (docked preview + hidden popout host, and both at once while popped
// out). A shared cache keyed only by visualizer id would see two different
// sizes and destroy+recreate the canvas every frame — the thing that tanked
// FPS. One Map per stage keeps each stage's buffer stable across frames.
//
// Crisp visualizers (waveform lines, particles) should draw straight onto the
// device ctx instead; this is only worth it for soft, blurry fills.

// Cached offscreen canvas + 2d ctx whose long edge is capped at `maxEdge`,
// sized proportionally to the target w/h. Recreated on resize. `store` is the
// caller-owned per-stage Map (frame.buffers). Returns { canvas, ctx, w, h }
// (w/h are the buffer's own pixel dimensions).
export function getBuffer(store, key, w, h, maxEdge = 720) {
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const bw = Math.max(1, Math.round(w * scale))
  const bh = Math.max(1, Math.round(h * scale))
  let b = store.get(key)
  if (!b || b.w !== bw || b.h !== bh) {
    const canvas = document.createElement('canvas')
    canvas.width = bw
    canvas.height = bh
    b = { canvas, ctx: canvas.getContext('2d'), w: bw, h: bh }
    store.set(key, b)
  }
  return b
}

// Blit a buffer up to fill the device canvas. `smooth` defaults to false
// (nearest-neighbor): for soft, low-frequency content (gradients, glows) the
// upscale is visually identical to bilinear but far cheaper on a software
// rasterizer — which is the difference between 60fps and single digits at 4K.
// Pass true only when the buffer holds fine detail worth interpolating.
export function blit(dstCtx, buf, dstW, dstH, smooth = false) {
  dstCtx.imageSmoothingEnabled = smooth
  dstCtx.drawImage(buf.canvas, 0, 0, buf.w, buf.h, 0, 0, dstW, dstH)
}
