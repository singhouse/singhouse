// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the stage transform and the letterboxing draw path: the
// background must fill the full viewport while all stage geometry is drawn
// through the centered, aspect-preserving virtual-stage transform.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeStageTransform, describeFrame } from '../../src/stage/frame.mjs'
import { drawFrame } from '../../src/stage/draw.mjs'

test('stage transform: 4:3 viewports scale with no offsets', () => {
  assert.deepEqual(computeStageTransform({ width: 640, height: 480 }), { scale: 1, offsetX: 0, offsetY: 0 })
  assert.deepEqual(computeStageTransform({ width: 1280, height: 960 }), { scale: 2, offsetX: 0, offsetY: 0 })
})

test('stage transform: wide viewport pillarboxes horizontally', () => {
  assert.deepEqual(computeStageTransform({ width: 1920, height: 1080 }), { scale: 2.25, offsetX: 240, offsetY: 0 })
  assert.deepEqual(computeStageTransform({ width: 800, height: 480 }), { scale: 1, offsetX: 80, offsetY: 0 })
})

test('stage transform: tall viewport letterboxes vertically', () => {
  assert.deepEqual(computeStageTransform({ width: 640, height: 600 }), { scale: 1, offsetX: 0, offsetY: 60 })
})

test('stage transform preserves 4:3 aspect at arbitrary sizes', () => {
  for (const viewport of [{ width: 317, height: 911 }, { width: 1024, height: 600 }, { width: 90, height: 120 }]) {
    const { scale, offsetX, offsetY } = computeStageTransform(viewport)
    const stageW = 640 * scale
    const stageH = 480 * scale
    assert.ok(Math.abs(stageW / stageH - 4 / 3) < 1e-9)
    // Centered inside the viewport, never overflowing it.
    assert.ok(Math.abs(offsetX * 2 + stageW - viewport.width) < 1e-9)
    assert.ok(Math.abs(offsetY * 2 + stageH - viewport.height) < 1e-9)
    assert.ok(offsetX >= 0 && offsetY >= 0)
  }
})

// Minimal recording 2D-context fake: enough surface for drawFrame, capturing
// the calls we assert on.
function recordingContext() {
  const calls = []
  const record = (name) => (...args) => calls.push({ name, args })
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    measureText: (text) => ({ width: text.length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }
}

const MODEL = {
  duration: 10,
  tracks: {},
  pages: [
    {
      activeColor: '#ffdd66',
      inactiveColor: '#ffffff',
      fadeInStart: 0,
      fadeInDuration: 0,
      fadeOutStart: 9,
      fadeOutDuration: 1,
      lines: [
        { x: 40, y: 200, width: 560, height: 48, words: [[{ start: 1, end: 2, text: 'glow' }]] },
      ],
    },
  ],
  silences: [],
}

test('letterboxing draw: background fills the viewport, stage is translated and scaled', () => {
  const ctx = recordingContext()
  const viewport = { width: 1920, height: 1080 }
  const frame = describeFrame(MODEL, 1.5, viewport)
  drawFrame(ctx, MODEL, frame, { width: viewport.width, height: viewport.height, background: '#000000' })

  // Background covers the whole canvas, including the pillarbox bands.
  const firstFill = ctx.calls.find((c) => c.name === 'fillRect')
  assert.deepEqual(firstFill.args, [0, 0, 1920, 1080])

  // The stage content goes through translate(240, 0) then scale(2.25, 2.25).
  const translateIdx = ctx.calls.findIndex((c) => c.name === 'translate' && c.args[0] === 240 && c.args[1] === 0)
  assert.ok(translateIdx >= 0, 'stage translate applied')
  const scaleCall = ctx.calls[translateIdx + 1]
  assert.equal(scaleCall.name, 'scale')
  assert.deepEqual(scaleCall.args, [2.25, 2.25])

  // Text was actually drawn (inactive layer + clipped active layer).
  const texts = ctx.calls.filter((c) => c.name === 'fillText')
  assert.ok(texts.length >= 2)
  assert.ok(ctx.calls.some((c) => c.name === 'clip'))
})

test('drawFrame with an empty model draws only the background', () => {
  const ctx = recordingContext()
  const model = { duration: 0, tracks: {}, pages: [], silences: [] }
  const frame = describeFrame(model, 0, { width: 800, height: 480 })
  drawFrame(ctx, model, frame, { width: 800, height: 480 })
  assert.equal(ctx.calls.filter((c) => c.name === 'fillText').length, 0)
  assert.equal(ctx.calls.filter((c) => c.name === 'fillRect').length, 1)
})

test('reduced motion suppresses the animated background gradient', () => {
  const ctx = recordingContext()
  let gradientUsed = false
  ctx.createLinearGradient = () => {
    gradientUsed = true
    return { addColorStop() {} }
  }
  const model = { duration: 0, tracks: {}, pages: [], silences: [] }
  const frame = describeFrame(model, 3, { width: 640, height: 480 })
  drawFrame(ctx, model, frame, {
    width: 640,
    height: 480,
    animatedBackground: true,
    reducedMotion: true,
    time: 3,
  })
  assert.equal(gradientUsed, false)
})
