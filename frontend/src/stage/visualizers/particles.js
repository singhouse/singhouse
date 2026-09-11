// SPDX-License-Identifier: AGPL-3.0-only
// particles.js — audio-reactive 3D warp-starfield backdrop.
//
// A fixed pool of stars flies outward from center (classic hyperspace warp).
// Each star has a normalized direction (sx,sy in [-1,1]) and a depth (sz in
// (0,1]); projecting sx/sy by 1/sz pushes it toward the edges as it nears the
// viewer, growing brighter/larger. bass drives fly speed + thickness, beat
// fires an outward burst + brightness pop, treble twinkles the stars. Stars
// are drawn CRISP directly on the device ctx with additive 'lighter' streaks;
// only the faint depth wash uses the shared downscaled buffer. Vignette last.
//
// Normalized star coords are resolution-independent, so resize needs no reseed.
// Everything is DETERMINISTIC: directions come from a hash of (star index,
// respawn counter), never Math.random — so the field is reproducible and
// identical across the host canvas, the Document-PiP window and the projector.
// All motion is dt/t-driven: dt=0 (pause/seek) freezes the field cleanly while
// still fully repainting.
//
// The star pool + burst envelope live in PER-STAGE state (frame.viz), seeded
// lazily on first draw: the host renders two stages at once, and a shared pool
// would let each stage advance/recycle the other's stars.
import { getBuffer, blit } from './offscreen.js'

const N = 350
const Z_NEAR = 0.05

// Cheap deterministic pseudo-random in [0,1) from two integer seeds.
function rnd(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// Mostly-white with a few cool/warm stars for a little chromatic life.
const PALETTE = ['rgb(255,255,255)', 'rgb(160,195,255)', 'rgb(255,224,178)']

// (Re)place star i using its current respawn counter as the seed. `deep` sends
// it to the far plane (z=1); otherwise it lands at a deterministic depth.
function place(f, i, deep) {
  const k = f.rc[i]
  // Direction on the projection plane; avoid a dead-center pile.
  let ax, ay, s = 0
  do {
    ax = rnd(i * 2 + 1, k + s) * 2 - 1
    ay = rnd(i * 2 + 2, k + s) * 2 - 1
    s++
  } while (ax * ax + ay * ay < 0.0009 && s < 8)
  f.sx[i] = ax
  f.sy[i] = ay
  f.sz[i] = deep ? 1 : Z_NEAR + rnd(i * 2 + 7, k) * (1 - Z_NEAR)
}

// Recycle star i to the far plane, advancing its seed so its next flight differs.
function respawn(f, i) {
  f.rc[i]++
  place(f, i, true)
}

// Build a fresh, fully-seeded field (per stage). Deterministic — no Math.random.
function initField() {
  const f = {
    sx: new Float32Array(N),
    sy: new Float32Array(N),
    sz: new Float32Array(N),
    rc: new Uint32Array(N),     // respawn counter → deterministic re-seed
    phase: new Float32Array(N), // twinkle phase seed
    tw: new Float32Array(N),    // twinkle rate
    col: new Uint8Array(N),     // palette index
    burst: 0,                   // beat-driven outward-burst envelope
    vgW: 0, vgH: 0,             // overlay size guard
  }
  for (let i = 0; i < N; i++) {
    place(f, i, false)
    f.phase[i] = rnd(i, 101) * Math.PI * 2
    f.tw[i] = 2 + rnd(i, 202) * 5
    const r = rnd(i, 303)
    f.col[i] = r < 0.82 ? 0 : r < 0.92 ? 1 : 2
  }
  return f
}

// Baked legibility overlay (scrim + vignette). Size-invariant, so it's rendered
// once per resize into a downscaled buffer and blitted — no device-res gradient
// fills on the per-frame path. Size guard lives in the per-stage state `f`.
function overlay(buffers, f, w, h) {
  const buf = getBuffer(buffers, 'particles-vg', w, h, 720)
  if (f.vgW !== w || f.vgH !== h) {
    f.vgW = w; f.vgH = h
    const c = buf.ctx
    const cx = buf.w / 2, cy = buf.h / 2
    const R = Math.hypot(buf.w, buf.h) / 2, unit = Math.min(buf.w, buf.h)
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalCompositeOperation = 'source-over'
    c.clearRect(0, 0, buf.w, buf.h)
    const scrim = c.createRadialGradient(cx, cy, 0, cx, cy, unit * 0.42)
    scrim.addColorStop(0, 'rgba(3,3,10,0.32)')
    scrim.addColorStop(1, 'rgba(3,3,10,0)')
    c.fillStyle = scrim
    c.fillRect(0, 0, buf.w, buf.h)
    const vg = c.createRadialGradient(cx, cy, unit * 0.18, cx, cy, R)
    vg.addColorStop(0, 'rgba(2,2,8,0)')
    vg.addColorStop(0.7, 'rgba(2,2,8,0.42)')
    vg.addColorStop(1, 'rgba(2,2,8,0.85)')
    c.fillStyle = vg
    c.fillRect(0, 0, buf.w, buf.h)
  }
  return buf
}

export default {
  id: 'particles',
  name: 'Starfield',
  draw(ctx, w, h, frame) {
    const { t, dt, level, bands, beat, animate } = frame
    const bass = bands ? bands.bass : 0
    const mid = bands ? bands.mid : 0
    const treble = bands ? bands.treble : 0

    // Per-stage star field + burst envelope, seeded on first draw.
    const f = (frame.viz.particles ||= initField())
    const { sx, sy, sz, rc, phase, tw, col } = f

    const cx = w * 0.5
    const cy = h * 0.5
    const minDim = Math.min(w, h)
    const spread = minDim * 0.16
    const margin = minDim * 0.08

    // --- opaque base: faint depth wash via the downscaled buffer ---
    const buf = getBuffer(frame.buffers, 'particles', w, h, 480)
    const bctx = buf.ctx
    const glow = animate ? level : Math.min(level, 0.4)
    const g = bctx.createRadialGradient(
      buf.w * 0.5, buf.h * 0.5, 0,
      buf.w * 0.5, buf.h * 0.5, Math.hypot(buf.w, buf.h) * 0.5,
    )
    const cr = 8 + glow * 18
    g.addColorStop(0, `rgb(${cr | 0},${(cr * 1.2) | 0},${(cr * 2.4 + 6) | 0})`)
    g.addColorStop(0.5, 'rgb(5,6,14)')
    g.addColorStop(1, 'rgb(1,1,4)')
    bctx.fillStyle = g
    bctx.fillRect(0, 0, buf.w, buf.h)
    blit(ctx, buf, w, h)

    // --- advance + draw stars (crisp, additive) ---
    if (dt > 0) {
      // Beat kicks an outward burst; decays exponentially (bounded).
      f.burst += beat * 1.6
      f.burst *= Math.exp(-dt * 3.5)
      if (f.burst > 3) f.burst = 3
    }
    const burst = f.burst
    const speed = 0.11 + bass * 0.5 + burst * 1.1
    const brightPop = 1 + burst * 0.35

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    const maxLW = minDim * 0.007
    let curCol = -1

    for (let i = 0; i < N; i++) {
      const oldInv = 1 / sz[i]
      let respawned = false
      if (dt > 0) {
        sz[i] -= dt * speed
        if (sz[i] <= Z_NEAR) {
          respawn(f, i)
          respawned = true
        }
      }
      const z = sz[i]
      const inv = 1 / z
      const X = cx + sx[i] * inv * spread
      const Y = cy + sy[i] * inv * spread

      // Off-canvas stars aren't drawn; recycle them to keep density up, but
      // only while playing — a paused frame must never mutate the pool.
      if (X < -margin || X > w + margin || Y < -margin || Y > h + margin) {
        if (dt > 0) respawn(f, i)
        continue
      }

      const depth = 1 - z // 0 far .. ~0.95 near
      // treble twinkle: bounded oscillation, more when trebly.
      const twk = 1 + treble * 0.6 * Math.sin(t * tw[i] + phase[i])
      let a = depth * depth * (0.5 + mid * 0.5) * brightPop * twk
      if (a > 1) a = 1
      else if (a < 0) a = 0
      if (a < 0.015) continue

      const c = col[i]
      if (c !== curCol) { ctx.strokeStyle = PALETTE[c]; curCol = c }
      ctx.globalAlpha = a

      const lw = 0.6 + depth * maxLW * (0.6 + bass * 0.9)
      ctx.lineWidth = lw

      if (respawned || dt === 0) {
        // no streak: draw a short dot-like segment
        ctx.beginPath()
        ctx.moveTo(X, Y)
        ctx.lineTo(X + 0.01, Y)
        ctx.stroke()
      } else {
        // warp streak from previous projected position
        const pX = cx + sx[i] * oldInv * spread
        const pY = cy + sy[i] * oldInv * spread
        ctx.beginPath()
        ctx.moveTo(pX, pY)
        ctx.lineTo(X, Y)
        ctx.stroke()
      }
    }
    ctx.restore()

    // --- legibility: baked scrim + edge vignette, one blit (last) ---
    blit(ctx, overlay(frame.buffers, f, w, h), w, h)
  },
}
