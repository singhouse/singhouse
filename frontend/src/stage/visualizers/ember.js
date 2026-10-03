// SPDX-License-Identifier: AGPL-3.0-only
// Defocused copper and amber stage lights. Fixed seeds and song-time paths
// make pause/seek stable, with no accumulated particles or beat impulses.
import { getBuffer, blit } from './offscreen.js'

function seed(i, salt) {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return n - Math.floor(n)
}

const LIGHTS = Array.from({ length: 24 }, (_, i) => ({
  // Distribute lights around the perimeter, leaving an open lyric column.
  angle: (i / 24) * Math.PI * 2 + seed(i, 1) * 0.14,
  radius: 0.37 + seed(i, 2) * 0.22,
  size: 0.045 + seed(i, 3) * 0.095,
  phase: seed(i, 4) * Math.PI * 2,
  rate: 0.08 + seed(i, 5) * 0.08,
  hue: 17 + seed(i, 6) * 23,
  light: 0.55 + seed(i, 7) * 0.45,
  driftX: 0.06 + seed(i, 8) * 0.06,
  driftY: 0.06 + seed(i, 9) * 0.06,
}))
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

export default {
  id: 'ember',
  name: 'Ember',
  draw(ctx, w, h, frame) {
    const buf = getBuffer(frame.buffers, 'ember', w, h, 720)
    const c = buf.ctx, bw = buf.w, bh = buf.h
    const unit = Math.min(bw, bh)
    const t = Number.isFinite(frame.t) ? frame.t : 0
    const state = (frame.viz.ember ||= { audio: 0, bass: 0 })
    // Keep the last playing brightness as the analyser decays during pause.
    if (frame.animate) {
      state.audio = clamp(frame.level)
      state.bass = clamp(frame.bands?.bass)
    }
    const level = state.audio
    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
    c.fillStyle = '#10090d'
    c.fillRect(0, 0, bw, bh)

    const wash = c.createLinearGradient(0, 0, bw, bh)
    wash.addColorStop(0, '#241213')
    wash.addColorStop(0.5, '#10090d')
    wash.addColorStop(1, '#20100c')
    c.fillStyle = wash
    c.fillRect(0, 0, bw, bh)

    c.globalCompositeOperation = 'lighter'
    for (const light of LIGHTS) {
      const phase = t * light.rate + light.phase
      const x = bw * (0.5 + Math.cos(light.angle) * light.radius + Math.sin(phase) * light.driftX)
      const y = bh * (0.5 + Math.sin(light.angle) * light.radius + Math.cos(phase * 0.8 + light.angle) * light.driftY)
      const breath = 1 + Math.sin(phase * 0.7) * 0.10
      const r = unit * light.size * breath * (1 + state.bass * 0.18)
      // Independent slow fades make lights pass through focus; the already
      // smoothed audio adds a gentle swell without beat-triggered flashes.
      const fade = 0.78 + 0.22 * Math.sin(phase * 0.63 + light.angle)
      const a = light.light * fade * (0.17 + level * 0.11 + state.bass * 0.04)
      const glow = c.createRadialGradient(x, y, 0, x, y, r)
      // A shallow bright rim gives the discs a defocused lens character.
      glow.addColorStop(0, `hsla(${light.hue}, 72%, 54%, ${a * 0.32})`)
      glow.addColorStop(0.52, `hsla(${light.hue}, 76%, 56%, ${a * 0.46})`)
      glow.addColorStop(0.72, `hsla(${light.hue}, 78%, 62%, ${a})`)
      glow.addColorStop(0.86, `hsla(${light.hue}, 72%, 49%, ${a * 0.38})`)
      glow.addColorStop(1, `hsla(${light.hue}, 70%, 42%, 0)`)
      c.fillStyle = glow
      c.fillRect(x - r, y - r, r * 2, r * 2)
    }

    c.globalCompositeOperation = 'source-over'
    c.save()
    c.scale(bw, bh)
    const scrim = c.createRadialGradient(0.5, 0.5, 0.08, 0.5, 0.5, 0.62)
    scrim.addColorStop(0, 'rgba(9,5,10,0.65)')
    scrim.addColorStop(0.5, 'rgba(9,5,10,0.3)')
    scrim.addColorStop(1, 'rgba(9,5,10,0)')
    c.fillStyle = scrim
    c.fillRect(0, 0, 1, 1)
    c.restore()

    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    blit(ctx, buf, w, h)
  },
}
