// SPDX-License-Identifier: AGPL-3.0-only
// Orbit — a shadowed ringed world, deep nebula, and drifting starlight.
// Geometry depends on song time; per-stage state holds only the fixed star and
// dust layouts plus smoothed audio luminance.
//
// Two resolutions: the soft sky (base, glows, nebula, world halos) renders
// into a small buffer and is blitted up; everything with a hard edge (stars,
// world bodies, rings, dust) draws straight onto the device canvas, so it
// stays crisp on a 4K projector. The lyric shade is baked once per size.
import { getBuffer, blit } from './offscreen.js'

const TAU = Math.PI * 2
const unit = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const fract = value => value - Math.floor(value)
const rnd = (i, seed) => fract(Math.sin(i * 127.1 + seed * 311.7) * 43758.5453)

function initScene() {
  return {
    audio: 0,
    dust: Array.from({ length: 240 }, (_, i) => ({
      angle: rnd(i, 1) * TAU,
      orbit: rnd(i, 2),
      speed: 0.018 + rnd(i, 3) * 0.024,
      size: 0.3 + rnd(i, 4) * 1.1,
      tint: rnd(i, 5),
    })),
    stars: Array.from({ length: 270 }, (_, i) => ({
      x: rnd(i, 6), y: rnd(i, 7),
      depth: rnd(i, 8),
      size: 0.27 + rnd(i, 9) * 0.9,
      tint: rnd(i, 10),
      phase: rnd(i, 11) * TAU,
    })),
  }
}

function glow(c, x, y, radius, color, alpha) {
  const g = c.createRadialGradient(x, y, 0, x, y, radius)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.globalAlpha = unit(alpha)
  c.fillStyle = g
  c.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  c.globalAlpha = 1
}

function hash(x, y, seed) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let fx = x - ix, fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy, seed) * (1 - fx) + hash(ix + 1, iy, seed) * fx
  const b = hash(ix, iy + 1, seed) * (1 - fx) + hash(ix + 1, iy + 1, seed) * fx
  return a * (1 - fy) + b * fy
}

function makeNebula(texture) {
  // A small per-stage image is generated once per size, then translated during
  // playback. Multi-scale noise tears soft gas envelopes into natural wisps.
  const { w, h } = texture
  const pixels = texture.ctx.createImageData(w, h)
  const data = pixels.data
  for (let py = 0; py < h; py++) {
    const y = py / h * 1.16 - 0.08
    for (let px = 0; px < w; px++) {
      const x = px / w * 1.16 - 0.08
      const left = Math.exp(-(((x - 0.08) / 0.33) ** 2 + ((y - 0.14) / 0.34) ** 2))
      const upper = Math.exp(-(((x - 0.79) / 0.29) ** 2 + ((y - 0.05) / 0.29) ** 2))
      const lower = Math.exp(-(((x - 0.79) / 0.38) ** 2 + ((y - 0.99) / 0.32) ** 2))
      const envelope = Math.max(left, upper * 0.85, lower)
      const warp = (noise(x * 5, y * 5, 1) - 0.5) * 0.14
      const grain = noise((x + warp) * 8, (y - warp) * 8, 2) * 0.55
        + noise(x * 19, y * 19, 3) * 0.3
        + noise(x * 39, y * 39, 4) * 0.15
      const density = Math.max(0, grain - 0.32) * Math.pow(envelope, 1.15) * 2.6
      const total = left + upper + lower + 0.001
      const a = Math.min(205, density * 470)
      const p = (py * w + px) * 4
      data[p] = Math.round((55 * left + 114 * upper + 150 * lower) / total)
      data[p + 1] = Math.round((144 * left + 68 * upper + 55 * lower) / total)
      data[p + 2] = Math.round((207 * left + 190 * upper + 178 * lower) / total)
      data[p + 3] = Math.round(a)
    }
  }
  texture.ctx.putImageData(pixels, 0, 0)
  texture.ready = true
}

function nebula(c, w, h, t, audio, texture) {
  c.save()
  c.globalCompositeOperation = 'screen'
  c.globalAlpha = 0.77 + audio * 0.23
  c.drawImage(
    texture.canvas,
    w * (-0.075 + Math.sin(t * 0.18) * 0.038),
    h * (-0.075 + Math.cos(t * 0.13) * 0.025),
    w * 1.15, h * 1.15,
  )
  c.restore()
}

function drawRings(c, x, y, r, front) {
  c.save()
  c.translate(x, y)
  c.rotate(-0.29)
  c.scale(1, 0.28)
  for (let i = 0; i < 9; i++) {
    c.beginPath()
    c.arc(0, 0, r * (1.43 + i * 0.065), front ? 0 : Math.PI, front ? Math.PI : TAU)
    const alpha = (front ? 0.18 : 0.11) + (i % 3 === 1 ? 0.14 : 0)
    c.strokeStyle = i % 3 === 2
      ? `rgba(231,173,201,${alpha})`
      : `rgba(139,199,231,${alpha})`
    c.lineWidth = r * (i % 3 === 1 ? 0.026 : 0.012)
    c.stroke()
  }
  c.restore()
}

// Positions are pure functions of (w, h, t), so the sky buffer and the device
// canvas place each world's halo and body at the same spot.
function worldAt(w, h, t) {
  const s = Math.min(w, h)
  return {
    x: w * 0.91 + Math.sin(t * 0.055) * s * 0.025,
    y: h * 0.63 + Math.cos(t * 0.071) * s * 0.025,
    r: s * 0.29,
  }
}

function moonAt(w, h, t) {
  const s = Math.min(w, h)
  return {
    x: w * 0.13 + Math.cos(t * 0.13) * s * 0.044,
    y: h * 0.23 + Math.sin(t * 0.13) * s * 0.032,
    r: s * 0.08,
  }
}

function planet(c, w, h, t, audio) {
  const { x, y, r } = worldAt(w, h, t)
  drawRings(c, x, y, r, false)

  const disc = c.createRadialGradient(x - r * 0.69, y - r * 0.54, 0, x + r * 0.21, y + r * 0.12, r * 1.35)
  disc.addColorStop(0, '#436789')
  disc.addColorStop(0.22, '#1a3858')
  disc.addColorStop(0.66, '#0b1c32')
  disc.addColorStop(1, '#040c19')
  c.fillStyle = disc
  c.beginPath()
  c.arc(x, y, r, 0, TAU)
  c.fill()

  // Uneven, muted belts remain inside the terminator's shadow. Their offset
  // drifts with song time, but no same-width stripes divide the sphere.
  c.save()
  c.beginPath()
  c.arc(x, y, r, 0, TAU)
  c.clip()
  c.translate(Math.sin(t * 0.09) * r * 0.12, 0)
  for (let i = 0; i < 13; i++) {
    const yy = y + r * (-0.83 + i * 0.14 + (rnd(i, 41) - 0.5) * 0.1)
    c.beginPath()
    c.moveTo(x - r * 1.2, yy)
    c.bezierCurveTo(
      x - r * 0.54, yy - r * (0.05 + rnd(i, 42) * 0.11),
      x + r * 0.27, yy + r * (rnd(i, 43) - 0.5) * 0.22,
      x + r * 1.15, yy - r * 0.06,
    )
    c.strokeStyle = i % 3 === 0 ? 'rgba(96,159,181,0.095)' : 'rgba(3,10,25,0.18)'
    c.lineWidth = r * (0.025 + rnd(i, 44) * 0.075)
    c.stroke()
  }
  const night = c.createLinearGradient(x - r, y - r, x + r, y + r)
  night.addColorStop(0, 'rgba(0,0,0,0)')
  night.addColorStop(0.45, 'rgba(1,5,13,0.34)')
  night.addColorStop(1, 'rgba(1,4,12,0.83)')
  c.fillStyle = night
  c.fillRect(x - r, y - r, r * 2, r * 2)
  c.restore()
  drawRings(c, x, y, r, true)
  c.strokeStyle = `rgba(126,205,231,${0.42 + audio * 0.24})`
  c.lineWidth = Math.max(1, r * 0.025)
  c.beginPath()
  c.arc(x, y, r, 2.64, 5.36)
  c.stroke()
  return { x, y, r }
}

function moon(c, w, h, t) {
  const s = Math.min(w, h)
  const { x, y, r } = moonAt(w, h, t)
  const g = c.createRadialGradient(x - r * 0.39, y - r * 0.4, 0, x, y, r * 1.3)
  g.addColorStop(0, '#aac9d7')
  g.addColorStop(0.4, '#4b6b86')
  g.addColorStop(1, '#0a1c33')
  c.fillStyle = g
  c.beginPath()
  c.arc(x, y, r, 0, TAU)
  c.fill()
  c.strokeStyle = 'rgba(218,239,245,0.54)'
  c.lineWidth = Math.max(0.8, s * 0.002)
  c.beginPath()
  c.arc(x, y, r, 2.6, 5.25)
  c.stroke()
}

// Every layer yields to a dark lyric center. Size-invariant, so it is baked
// once per resize and blitted last — no device-resolution gradient fill on
// the per-frame path. Low-frequency alpha, so the nearest upscale is invisible.
// The guard lives on the buffer itself, so a replaced buffer always rebakes.
function shade(buffers, w, h) {
  const buf = getBuffer(buffers, 'orbit-shade', w, h, 720)
  if (buf.bakedW !== w || buf.bakedH !== h) {
    const c = buf.ctx
    const s = Math.min(buf.w, buf.h)
    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
    c.clearRect(0, 0, buf.w, buf.h)
    const g = c.createRadialGradient(buf.w * 0.5, buf.h * 0.51, s * 0.05, buf.w * 0.5, buf.h * 0.51, s * 0.67)
    g.addColorStop(0, 'rgba(1,4,13,0.82)')
    g.addColorStop(0.63, 'rgba(1,4,13,0.42)')
    g.addColorStop(1, 'rgba(1,4,13,0)')
    c.fillStyle = g
    c.fillRect(0, 0, buf.w, buf.h)
    buf.bakedW = w; buf.bakedH = h
  }
  return buf
}

export default {
  id: 'particles', // Saved preferences retain their visualizer.
  name: 'Orbit',
  draw(ctx, w, h, frame) {
    const t = Number.isFinite(frame.t) ? frame.t : 0
    const scene = (frame.viz.particles ||= initScene())
    if (frame.animate) {
      scene.audio = unit(frame.level) * 0.45 + unit(frame.bands?.bass) * 0.35 + unit(frame.bands?.mid) * 0.2
    }
    const audio = scene.audio
    // ---- soft sky: small buffer, nearest upscale ------------------------
    const buf = getBuffer(frame.buffers, 'particles', w, h, 720)
    const sky = buf.ctx
    const bw = buf.w, bh = buf.h
    sky.globalAlpha = 1
    sky.globalCompositeOperation = 'source-over'
    sky.fillStyle = '#020611'
    sky.fillRect(0, 0, bw, bh)
    glow(sky, bw * 0.1, bh * 0.14, bw * 0.58, 'rgba(20,66,121,0.68)', 0.72 + audio * 0.3)
    glow(sky, bw * 0.93, bh * 0.94, bw * 0.58, 'rgba(74,29,107,0.68)', 0.64 + audio * 0.28)
    const texture = getBuffer(frame.buffers, 'orbit-nebula', w, h, 420)
    if (!texture.ready) makeNebula(texture)
    nebula(sky, bw, bh, t, audio, texture)
    const halo = worldAt(bw, bh, t)
    glow(sky, halo.x, halo.y, halo.r * 2.1, 'rgba(31,71,119,0.28)', 0.52 + audio * 0.32)
    const moonHalo = moonAt(bw, bh, t)
    glow(sky, moonHalo.x, moonHalo.y, moonHalo.r * 4.5, 'rgba(80,139,201,0.34)', 0.45 + audio * 0.32)

    ctx.save()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    blit(ctx, buf, w, h)

    // ---- crisp layers: device resolution --------------------------------
    const c = ctx
    const s = Math.min(w, h)
    for (let i = 0; i < scene.stars.length; i++) {
      const star = scene.stars[i]
      const x = fract(star.x + t * (0.00005 + star.depth * 0.00022))
      const y = fract(star.y - t * (0.000025 + star.depth * 0.00007))
      const edge = Math.min(1, Math.min(x, 1 - x, y, 1 - y) * 35)
      const distance = Math.hypot(x - 0.5, y - 0.5)
      const glint = i < 12
      c.globalAlpha = unit(edge * Math.min(0.76, distance * (0.42 + star.depth * 0.37 + audio * 0.3)
        * (0.84 + 0.16 * Math.sin(t * 0.31 + star.phase))))
      c.fillStyle = star.tint < 0.68 ? '#d6e9f5' : '#f1d4df'
      c.beginPath()
      c.arc(x * w, y * h, star.size * (glint ? 1.3 : 1) * s / 480, 0, TAU)
      c.fill()
      if (glint) {
        c.lineWidth = Math.max(0.35, s / 950)
        c.strokeStyle = c.fillStyle
        c.beginPath()
        c.moveTo(x * w - s * 0.007, y * h)
        c.lineTo(x * w + s * 0.007, y * h)
        c.moveTo(x * w, y * h - s * 0.007)
        c.lineTo(x * w, y * h + s * 0.007)
        c.stroke()
      }
    }
    c.globalAlpha = 1
    const world = planet(c, w, h, t, audio)
    moon(c, w, h, t)

    // Grain travels on ellipses around the planet; no particle integrates dt.
    for (const grain of scene.dust) {
      const a = grain.angle + t * grain.speed * (grain.orbit < 0.5 ? 1 : -1)
      const radius = world.r * (1.43 + grain.orbit * 0.58)
      const x = world.x + Math.cos(a) * radius
      const y = world.y + Math.sin(a) * radius * 0.28 - Math.cos(a) * radius * 0.08
      if (x < 0 || x > w || y < 0 || y > h) continue
      if (Math.sin(a) < 0 && Math.hypot(x - world.x, y - world.y) < world.r) continue
      const center = Math.min(1, Math.hypot((x / w - 0.5) * 2, (y / h - 0.5) * 2))
      c.globalAlpha = unit((0.14 + center * 0.43) * (0.78 + audio * 0.7))
      c.fillStyle = grain.tint < 0.5 ? '#b7ddea' : '#e6bfd2'
      c.beginPath()
      c.arc(x, y, grain.size * s / 480, 0, TAU)
      c.fill()
    }
    c.globalAlpha = 1
    blit(ctx, shade(frame.buffers, w, h), w, h)
    ctx.restore()
  },
}
