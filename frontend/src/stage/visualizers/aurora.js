// SPDX-License-Identifier: AGPL-3.0-only
// aurora.js — "northern lights / lava-lamp" gradient-blob backdrop.
//
// A handful of large soft radial-gradient blobs drift on smooth sinusoidal
// paths (positions purely a function of frame.t so pause freezes cleanly and
// seek is deterministic). They're painted additively into the shared DOWNSCALED
// offscreen buffer — one small blurry composite instead of many device-res
// gradient fills — then blitted up and vignetted at full res so centered lyrics
// stay legible. Deep near-black base reads the vignette as stage, not a hole.
//
// Audio mapping:
//   level   → overall brightness / saturation swell of the whole field
//   bands.bass / beat → gentle bloom + scale pulse on the blobs
//   bands.treble → faint high-hue shimmer added to blob radius
// All motion is bounded and smooth (no strobing). animate=false → a dim, still
// frame with the drift phase frozen and audio reactivity ignored.

import { getBuffer, blit } from './offscreen.js'

const KEY = 'aurora'

// Blob definitions seeded once at module load (static seeds — allowed).
// Each blob drifts on a Lissajous-ish path with its own frequencies/phases,
// its own base hue offset, and its own size. 5 blobs.
const N = 5
const BLOBS = []
for (let i = 0; i < N; i++) {
  const r = () => Math.random()
  BLOBS.push({
    // path center (fractions of w/h) and drift amplitudes
    ox: 0.30 + 0.40 * r(),
    oy: 0.30 + 0.40 * r(),
    ax: 0.16 + 0.14 * r(),
    ay: 0.14 + 0.12 * r(),
    // angular speeds (rad/sec) — slow, incommensurate for lava-lamp wander
    sx: 0.05 + 0.05 * r(),
    sy: 0.04 + 0.05 * r(),
    px: r() * Math.PI * 2,
    py: r() * Math.PI * 2,
    // radius as fraction of min(w,h), and hue offset in degrees
    rad: 0.42 + 0.22 * r(),
    hue: r() * 360,
    // pulse phase so blobs breathe out of sync
    bp: r() * Math.PI * 2,
  })
}

export default {
  id: 'aurora',
  name: 'Aurora',
  draw(ctx, w, h, frame) {
    const { t, level, bands, beat, animate } = frame
    const bass = bands ? bands.bass : 0
    const treble = bands ? bands.treble : 0

    const buf = getBuffer(frame.buffers, KEY, w, h, 720)
    const bx = buf.ctx
    const bw = buf.w
    const bh = buf.h
    const unit = Math.min(bw, bh)

    // Deep near-black base (opaque — no bleed from prior frame).
    bx.globalCompositeOperation = 'source-over'
    bx.globalAlpha = 1
    bx.fillStyle = '#04030a'
    bx.fillRect(0, 0, bw, bh)

    // Audio-driven envelopes, gently clamped. When paused, go calm/dim.
    const lv = animate ? level || 0 : 0
    const bs = animate ? bass || 0 : 0
    const tr = animate ? treble || 0 : 0
    const bt = animate ? beat || 0 : 0

    // Slow global hue drift; frozen contribution when paused still deterministic.
    const hueDrift = t * 6

    // Overall brightness swell from loudness (kept in a legible band).
    const bright = 0.55 + 0.35 * lv
    const sat = 62 + 20 * lv // percent
    // Bass bloom scales blob radius a touch; beat adds a short-lived kick.
    const bloom = 1 + 0.10 * bs + 0.14 * bt

    bx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < N; i++) {
      const b = BLOBS[i]
      const phase = animate ? t : 0
      const cx = (b.ox + b.ax * Math.sin(phase * b.sx + b.px)) * bw
      const cy = (b.oy + b.ay * Math.cos(phase * b.sy + b.py)) * bh

      // Per-blob breathing + treble shimmer, all bounded.
      const breath = 1 + 0.06 * Math.sin(phase * 0.25 + b.bp) + 0.05 * tr
      const R = b.rad * unit * bloom * breath

      const hue = (b.hue + hueDrift) % 360
      // Lightness kept mid so additive stacking doesn't blow out the center.
      const l = Math.round(38 * bright)
      const a = 0.55 * bright

      const g = bx.createRadialGradient(cx, cy, 0, cx, cy, R)
      g.addColorStop(0, `hsla(${hue}, ${sat}%, ${l}%, ${a})`)
      g.addColorStop(0.5, `hsla(${hue}, ${sat}%, ${l * 0.7}%, ${a * 0.45})`)
      g.addColorStop(1, `hsla(${hue}, ${sat}%, ${l * 0.5}%, 0)`)
      bx.fillStyle = g
      bx.fillRect(0, 0, bw, bh)
    }
    // ---- Legibility pass, IN THE BUFFER (cheap at buffer res) so the whole
    // backdrop reaches the device canvas in a single blit — no per-frame
    // device-resolution gradient fills, which murder software canvas at 4K. ----
    bx.globalCompositeOperation = 'source-over'
    const cxb = bw / 2, cyb = bh / 2
    const Rb = Math.hypot(bw, bh) / 2

    // Soft center scrim so lyrics never fight bright blob detail dead-center.
    const scrim = bx.createRadialGradient(cxb, cyb, 0, cxb, cyb, unit * 0.5)
    scrim.addColorStop(0, 'rgba(4,3,10,0.42)')
    scrim.addColorStop(1, 'rgba(4,3,10,0)')
    bx.fillStyle = scrim
    bx.fillRect(0, 0, bw, bh)

    // Radial vignette toward the edges.
    const vg = bx.createRadialGradient(cxb, cyb, unit * 0.18, cxb, cyb, Rb)
    vg.addColorStop(0, 'rgba(3,2,8,0)')
    vg.addColorStop(0.7, 'rgba(3,2,8,0.35)')
    vg.addColorStop(1, 'rgba(3,2,8,0.85)')
    bx.fillStyle = vg
    bx.fillRect(0, 0, bw, bh)

    // Single upscale blit (nearest — the field is soft, so it's imperceptible).
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    blit(ctx, buf, w, h)
  },
}
