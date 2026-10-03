// SPDX-License-Identifier: AGPL-3.0-only
// Slow refracted light beneath deep water. Geometry depends only on song time;
// audio adds bounded luminance and bloom, never changes the flow speed.
import { getBuffer, blit } from './offscreen.js'

const RIBBONS = Array.from({ length: 9 }, (_, i) => ({
  x: (i - 1) / 6,
  phase: i * 2.399963,
  rate: 0.11 + (i % 3) * 0.025,
  width: 0.035 + (i % 4) * 0.012,
  hue: i % 3 === 0 ? 224 : 177 + i * 3,
}))
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

export default {
  id: 'tidal',
  name: 'Tidal',
  draw(ctx, w, h, frame) {
    const buf = getBuffer(frame.buffers, 'tidal', w, h, 720)
    const c = buf.ctx, bw = buf.w, bh = buf.h
    const unit = Math.min(bw, bh)
    const t = Number.isFinite(frame.t) ? frame.t : 0
    const state = (frame.viz.tidal ||= { audio: 0, bass: 0 })
    // Keep the last playing brightness as the analyser decays during pause.
    if (frame.animate) {
      state.audio = clamp(frame.level)
      state.bass = clamp(frame.bands?.bass)
    }
    const level = state.audio
    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
    const depth = c.createLinearGradient(0, 0, bw * 0.4, bh)
    depth.addColorStop(0, '#09232e')
    depth.addColorStop(0.5, '#05121f')
    depth.addColorStop(1, '#070a1b')
    c.fillStyle = depth
    c.fillRect(0, 0, bw, bh)

    // Rolling S-curves fold through one another like refracted light.
    // Layered wide strokes make a soft shoulder and narrow caustic ridge,
    // without expensive canvas shadows or full-resolution gradient fills.
    c.globalCompositeOperation = 'lighter'
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (const ribbon of RIBBONS) {
      const phase = t * ribbon.rate + ribbon.phase
      c.beginPath()
      for (let j = 0; j <= 80; j++) {
        const v = -0.15 + j / 80 * 1.3
        const bend = Math.sin(v * 8.4 + phase) * 0.16
          + Math.sin(v * 14.4 - phase * 0.7 + ribbon.phase) * 0.055
        const x = (ribbon.x + (v - 0.5) * 0.26 + bend) * bw
        const y = v * bh
        if (j === 0) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      const light = 1 + level * 0.65 + state.bass * 0.4
      for (const [width, alpha] of [[2.8, 0.018], [1.7, 0.026], [1, 0.035], [0.4, 0.043], [0.18, 0.035]]) {
        c.lineWidth = Math.max(0.5, unit * ribbon.width * width * (1 + state.bass * 0.16))
        c.strokeStyle = `hsla(${ribbon.hue}, 65%, 57%, ${alpha * light})`
        c.stroke()
      }
    }

    c.globalCompositeOperation = 'source-over'
    // Broad elliptical scrim keeps the lyric column quiet in every aspect ratio.
    c.save()
    c.scale(bw, bh)
    const scrim = c.createRadialGradient(0.5, 0.53, 0.04, 0.5, 0.53, 0.58)
    scrim.addColorStop(0, 'rgba(3,8,17,0.72)')
    scrim.addColorStop(0.5, 'rgba(3,8,17,0.48)')
    scrim.addColorStop(1, 'rgba(3,8,17,0)')
    c.fillStyle = scrim
    c.fillRect(0, 0, 1, 1)
    c.restore()

    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    // Soft, low-contrast ridges tolerate nearest upscaling, avoiding a costly
    // full-resolution bilinear pass on software-rendered 4K projectors.
    blit(ctx, buf, w, h)
  },
}
