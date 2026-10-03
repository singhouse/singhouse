// SPDX-License-Identifier: AGPL-3.0-only
import { ACTIVE_COLOR, ACTIVE_BORDER } from './colors.mjs'
// Canvas drawing for the karaoke stage.
//
// Draws exclusively from a FrameDescriptor produced by describeFrame plus the
// model it was computed from, so what appears on screen is exactly the state
// the harness inspects. The context is expected to be pre-scaled for device
// pixel ratio; `options.width`/`options.height` are the CSS-pixel viewport.

import { validSyllables } from './frame.mjs'
import { layoutLine, revealEdgeX, lineFont, lineFontPx } from './layout.mjs'

const DEFAULT_BACKGROUND = '#101018'
const LEAD_IN_WIDTH = 64
const LEAD_IN_HEIGHT = 4
const LEAD_IN_GAP = 8

function drawBackground(ctx, options) {
  const { width, height } = options
  const base = options.background || DEFAULT_BACKGROUND
  if (options.animatedBackground && !options.reducedMotion) {
    // Deterministic slow drift keyed to playback time.
    const phase = (Math.sin((options.time || 0) * 0.25) + 1) / 2
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, base)
    gradient.addColorStop(1, `rgba(64,48,128,${(0.15 + 0.2 * phase).toFixed(3)})`)
    ctx.fillStyle = base
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  } else {
    ctx.fillStyle = base
    ctx.fillRect(0, 0, width, height)
  }
}

function drawSyllableRun(ctx, layout, line, fill, stroke) {
  const baselineY = line.y + line.height / 2
  ctx.save()
  ctx.translate(layout.startX, baselineY)
  ctx.scale(layout.scaleX, 1)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, lineFontPx(line) / 8)
  for (const run of layout.runs) {
    if (stroke) {
      ctx.strokeStyle = stroke
      ctx.strokeText(run.text, run.x0, 0)
    }
    ctx.fillStyle = fill
    ctx.fillText(run.text, run.x0, 0)
  }
  ctx.restore()
}

function drawLine(ctx, page, line, lineState) {
  ctx.font = lineFont(line)
  const measure = (text) => ctx.measureText(text).width
  const layout = layoutLine(line, measure)
  if (layout.runs.length === 0) return

  // Inactive layer: the whole line.
  drawSyllableRun(ctx, layout, line, page.inactiveColor || '#ffffff', page.inactiveBorder || '#000000')

  // Active layer, clipped to the reveal edge.
  const reveal = lineState.reveal
  if (reveal && reveal.kind !== 'none') {
    const edge = revealEdgeX(layout, reveal)
    ctx.save()
    ctx.beginPath()
    const pad = line.height * 2
    ctx.rect(layout.startX - pad, line.y - pad, edge - (layout.startX - pad), line.height + 2 * pad)
    ctx.clip()
    drawSyllableRun(ctx, layout, line, page.activeColor || ACTIVE_COLOR, page.activeBorder || ACTIVE_BORDER)
    ctx.restore()
  }

  // Lead-in indicator: a thin bar that fills with progress.
  if (lineState.leadIn) {
    const x = line.leadIn && Number.isFinite(line.leadIn.x) ? line.leadIn.x : line.x
    const y = line.y - LEAD_IN_GAP - LEAD_IN_HEIGHT
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(x, y, LEAD_IN_WIDTH, LEAD_IN_HEIGHT)
    ctx.fillStyle = page.activeColor || ACTIVE_COLOR
    ctx.fillRect(x, y, LEAD_IN_WIDTH * lineState.leadIn.progress, LEAD_IN_HEIGHT)
  }
}

function drawCountdown(ctx, bar, state) {
  ctx.save()
  ctx.globalAlpha *= state.opacity

  ctx.fillStyle = bar.inactiveColor || '#555555'
  ctx.fillRect(bar.x, bar.y, bar.width, bar.height)
  ctx.fillStyle = bar.activeColor || '#ffffff'
  ctx.fillRect(bar.x, bar.y, bar.width * state.fill, bar.height)

  // count - 1 interior ticks dividing the bar into `segments` equal parts.
  const segments = state.segments
  ctx.strokeStyle = bar.border || '#000000'
  ctx.lineWidth = bar.borderSize || 1
  for (let i = 1; i < segments; i++) {
    const x = bar.x + (bar.width * i) / segments
    ctx.beginPath()
    ctx.moveTo(x, bar.y)
    ctx.lineTo(x, bar.y + bar.height)
    ctx.stroke()
  }
  if (bar.border) {
    ctx.strokeRect(bar.x, bar.y, bar.width, bar.height)
  }

  if (state.numeral !== null && state.numeral !== undefined) {
    const size = Math.max(28, bar.height * 1.75)
    const above = bar.y - size - 6 >= 0
    ctx.font = `bold ${size}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = above ? 'bottom' : 'top'
    const y = above ? bar.y - 6 : bar.y + bar.height + 6
    ctx.lineWidth = Math.max(2, size / 10)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = bar.border || '#000000'
    ctx.strokeText(String(state.numeral), bar.x + bar.width / 2, y)
    ctx.fillStyle = bar.activeColor || '#ffffff'
    ctx.fillText(String(state.numeral), bar.x + bar.width / 2, y)
  }

  ctx.restore()
}

// Draw one frame: background over the full canvas, then pages and countdown
// bars inside the letterboxed/pillarboxed virtual stage.
export function drawFrame(ctx, model, frame, options) {
  ctx.save()
  drawBackground(ctx, options)

  const { scale, offsetX, offsetY } = frame.stageTransform
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  const modelPages = Array.isArray(model && model.pages) ? model.pages : []
  for (const pageState of frame.pages) {
    const page = modelPages[pageState.index]
    if (!page) continue
    ctx.save()
    ctx.globalAlpha = pageState.opacity
    for (const lineState of pageState.lines) {
      const line = page.lines[lineState.index]
      if (line && validSyllables(line).length > 0) drawLine(ctx, page, line, lineState)
    }
    ctx.restore()
  }

  const silences = Array.isArray(model && model.silences) ? model.silences : []
  for (const state of frame.countdowns) {
    const bar = silences[state.index]
    if (bar) drawCountdown(ctx, bar, state)
  }

  ctx.restore()
}
