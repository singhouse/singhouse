// SPDX-License-Identifier: AGPL-3.0-only
// waveform.js — retro oscilloscope backdrop.
//
// A glowing horizontal scope line traced from frame.waveform, drawn CRISP on
// the device ctx (never downscaled) with a two-pass additive glow: a wide,
// low-alpha halo stroke followed by a thin bright core. A faint mirrored trace
// below gives it symmetry. Behind the line sits a soft reactive wash rendered
// into the shared downscaled buffer (hue drifts slowly with frame.t, brightness
// tracks level/bass). Beats briefly flash the glow. Finishes with the house
// vignette + center scrim so centered lyrics stay legible.
import { getBuffer, blit } from './offscreen.js'

const KEY = 'waveform'

// Number of polyline samples across the width. Capped well below the 1024-byte
// waveform so the stroke count stays cheap even at 4K; we step through the data.
const SAMPLES = 384

// Per-frame scratch for drawTrace so it can be a hoisted module function (no
// closure allocated on the 60fps hot path). Populated at the top of draw().
const G = {}

// Two-pass additive polyline: wide low-alpha halo, then thin bright core.
// `sign` scales/flips the vertical deflection (1 = main, negative = mirror).
function drawTrace(sign, alphaScale) {
  const { ctx, w, cy, ampMax, idle, waveform, idlePulse, glowBoost, unit, haloColor, coreColor } = G
  ctx.beginPath()
  for (let i = 0; i < SAMPLES; i++) {
    const fx = i / (SAMPLES - 1)
    const x = fx * w
    let v
    if (idle) {
      v = 0
    } else {
      const idx = (fx * (waveform.length - 1)) | 0
      v = (waveform[idx] - 128) / 128 // -1..1
    }
    const y = cy + sign * (v * ampMax * idlePulse)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  // Pass A — halo
  ctx.strokeStyle = haloColor
  ctx.globalAlpha = Math.min(1, 0.18 * alphaScale * glowBoost)
  ctx.lineWidth = Math.max(3, unit * 0.012) * glowBoost
  ctx.stroke()
  // Pass B — bright core (reuse the same path)
  ctx.strokeStyle = coreColor
  ctx.globalAlpha = Math.min(1, 0.95 * alphaScale)
  ctx.lineWidth = Math.max(1.2, unit * 0.0022)
  ctx.stroke()
}

// Baked legibility overlay (vignette + center scrim). Size-invariant, so it's
// rendered once per resize into a downscaled buffer and blitted on top of the
// crisp trace — no device-resolution gradient fills on the per-frame path.
// `vs` is this stage's per-visualizer state (frame.viz); the size guard lives
// there so each stage rebuilds its own overlay only on its own resize.
function overlay(buffers, vs, w, h) {
  const buf = getBuffer(buffers, 'waveform-vg', w, h, 720)
  if (vs.vgW !== w || vs.vgH !== h) {
    vs.vgW = w; vs.vgH = h
    const c = buf.ctx
    const cx = buf.w / 2, cy = buf.h / 2
    const R = Math.hypot(buf.w, buf.h) / 2, unit = Math.min(buf.w, buf.h)
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalCompositeOperation = 'source-over'
    c.clearRect(0, 0, buf.w, buf.h)
    const vg = c.createRadialGradient(cx, cy, unit * 0.18, cx, cy, R)
    vg.addColorStop(0, 'rgba(3,2,8,0)')
    vg.addColorStop(0.7, 'rgba(3,2,8,0.35)')
    vg.addColorStop(1, 'rgba(3,2,8,0.8)')
    c.fillStyle = vg
    c.fillRect(0, 0, buf.w, buf.h)
    const scrim = c.createRadialGradient(cx, cy, 0, cx, cy, unit * 0.42)
    scrim.addColorStop(0, 'rgba(3,2,8,0.42)')
    scrim.addColorStop(1, 'rgba(3,2,8,0)')
    c.fillStyle = scrim
    c.fillRect(0, 0, buf.w, buf.h)
  }
  return buf
}

export default {
  id: 'waveform',
  name: 'Waveform (scope)',
  draw(ctx, w, h, frame) {
    const cy = h / 2
    const unit = Math.min(w, h)
    const { t, dt, level, bands, beat, waveform, animate } = frame
    const bass = bands ? bands.bass : 0

    // Per-stage animation state (beat-flash envelope, overlay size guard).
    const vs = (frame.viz[KEY] ||= { flash: 0, vgW: 0, vgH: 0 })

    // ---- beat flash envelope (decays; frozen when paused) ----------------
    if (animate) {
      const target = beat || 0
      if (target > vs.flash) vs.flash = target
      vs.flash *= Math.exp(-dt * 4.5) // ~0.2s decay
    }
    if (vs.flash < 0.0001) vs.flash = 0
    const flash = vs.flash

    // ---- slow hue drift --------------------------------------------------
    const hue = (t * 6) % 360 // ~1 full cycle per minute
    const glowHue = (hue + 20) % 360

    // ---- reactive background wash (downscaled buffer) --------------------
    const buf = getBuffer(frame.buffers, KEY, w, h, 640)
    const bw = buf.w
    const bh = buf.h
    const bctx = buf.ctx
    const pulse = Math.min(1, level * 0.9 + bass * 0.6)

    bctx.setTransform(1, 0, 0, 1, 0, 0)
    bctx.globalCompositeOperation = 'source-over'
    // opaque base so no prior frame bleeds through
    bctx.fillStyle = '#04030a'
    bctx.fillRect(0, 0, bw, bh)

    // vertical dark gradient + a soft central glow that breathes with loudness
    const g = bctx.createRadialGradient(bw / 2, bh / 2, bh * 0.02, bw / 2, bh / 2, Math.hypot(bw, bh) / 2)
    const bright = 6 + pulse * 22
    g.addColorStop(0, `hsl(${hue}, 60%, ${bright}%)`)
    g.addColorStop(0.5, `hsl(${(hue + 30) % 360}, 55%, ${bright * 0.5}%)`)
    g.addColorStop(1, '#03020a')
    bctx.fillStyle = g
    bctx.fillRect(0, 0, bw, bh)

    // faint scanline hint of the trace zone (a broad band across the middle)
    const band = bctx.createLinearGradient(0, bh * 0.32, 0, bh * 0.68)
    band.addColorStop(0, 'rgba(0,0,0,0)')
    band.addColorStop(0.5, `hsla(${glowHue}, 80%, 55%, ${0.05 + pulse * 0.12})`)
    band.addColorStop(1, 'rgba(0,0,0,0)')
    bctx.fillStyle = band
    bctx.fillRect(0, 0, bw, bh)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    blit(ctx, buf, w, h)

    // ---- scope amplitude scaling ----------------------------------------
    // Max deflection of the trace from center, in device px.
    const ampMax = unit * 0.22

    // Idle / resting: flat center line with a gentle level pulse (no scroll).
    const idle = !animate || !waveform || waveform.length < 2

    // Precompute a subtle idle breathing so a paused screen still feels alive
    // ONLY via level (no time term when !animate → truly still).
    const idlePulse = idle ? (0.25 + level * 0.75) : 1

    // ---- draw the trace (two-pass additive glow) ------------------------
    // Pass A: wide, low-alpha halo. Pass B: thin bright core. Optional mirror.
    const coreColor = `hsl(${glowHue}, 100%, 72%)`
    const haloColor = `hsl(${glowHue}, 100%, 60%)`

    const glowBoost = 1 + flash * 1.2
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    // Publish frame state for the hoisted drawTrace (no per-frame closure).
    G.ctx = ctx; G.w = w; G.cy = cy; G.ampMax = ampMax
    G.idle = idle; G.waveform = waveform; G.idlePulse = idlePulse
    G.glowBoost = glowBoost; G.unit = unit
    G.haloColor = haloColor; G.coreColor = coreColor

    // When idle the trace collapses to a flat line at center — right where the
    // lyrics sit — so draw it much dimmer (no bright core dominating the text)
    // and skip the center dot entirely. While playing it's full brightness and
    // the moving line reads clearly around the words.
    const idleTrace = idle ? 0.28 : 1
    drawTrace(1, idleTrace)
    // faint mirrored (reflected + damped) trace for symmetry
    drawTrace(-0.55, 0.4 * idleTrace)

    ctx.restore()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    // ---- legibility: baked vignette + scrim, one nearest blit (last) ------
    blit(ctx, overlay(frame.buffers, vs, w, h), w, h)
  },
}
