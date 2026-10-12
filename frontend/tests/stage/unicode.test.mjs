// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeWordSync } from '../../src/stage/adapter.mjs'
import { describeFrame } from '../../src/stage/frame.mjs'
import { drawFrame } from '../../src/stage/draw.mjs'

// Synthetic text only. Deliberately retain the fullwidth apostrophe, combining
// accent and supplementary-plane symbol: the stage must not rewrite source
// text to work around a transcription error or an unavailable system glyph.
const texts = ['한글', 'can＇t', '日本語', 'cafe\u0301', '𝄞']
const widths = new Map([[' ', 7], ['한글', 42], ['can＇t', 61], ['日本語', 63], ['cafe\u0301', 39], ['𝄞', 25]])
const tokens = texts.map((word, index) => ({ word, start: index + 1, end: index + 2 }))

function recordingContext() {
  const measured = []
  const fills = []
  const strokes = []
  const clips = []
  const noop = () => {}
  return {
    measured, fills, strokes, clips,
    save: noop, restore: noop, translate: noop, scale: noop,
    fillRect: noop, beginPath: noop, clip: noop,
    rect: (...args) => clips.push(args),
    measureText(text) {
      assert.ok(widths.has(text), `unexpected or altered text: ${text}`)
      measured.push(text)
      return { width: widths.get(text) }
    },
    fillText: (...args) => fills.push(args),
    strokeText: (...args) => strokes.push(args),
  }
}

const documents = {
  'v1 lines': { lines: [tokens] },
  'v1 segments': { segments: [{ words: tokens }] },
  'v2 syllables': {
    metadata: { format_version: 2 },
    lines: [tokens.map(({ word, start, end }) => ({
      word, start, end, syl: [{ text: word, start, end }],
    }))],
    pages: [{ line_idx: [0], fade_in_start: 0, fade_in_dur: 0, fade_out_start: 7, fade_out_dur: 1 }],
  },
}

for (const [format, document] of Object.entries(documents)) {
  test(`${format}: Unicode reaches both canvas layers intact with measured advances`, () => {
    const model = normalizeWordSync(document)
    assert.deepEqual(model.pages[0].lines[0].words.flat().map(s => s.text), texts)
    const ctx = recordingContext()
    const viewport = { width: 640, height: 480 }
    const frame = describeFrame(model, 2.5, viewport)
    drawFrame(ctx, model, frame, viewport)

    assert.deepEqual(ctx.measured, [' ', ...texts])
    // Native canvas measures complete strings; code-unit counts must never
    // determine their spacing. The active wipe is halfway through can＇t.
    const expected = texts.map((text, index) => [text, [0, 49, 117, 187, 233][index], 0])
    assert.deepEqual(ctx.fills, [...expected, ...expected])
    assert.deepEqual(ctx.strokes, [...expected, ...expected])
    assert.equal(ctx.clips.length, 1)
    const [clipX, , clipWidth] = ctx.clips[0]
    const line = model.pages[0].lines[0]
    const startX = (640 - 258) / 2
    assert.equal(clipX, startX - line.height * 2)
    assert.equal(clipX + clipWidth, startX + 49 + 61 / 2)
  })
}

// This recording context proves the text/layout contract, not font coverage.
// Missing-glyph boxes require visual checks on the target OS and its fonts.
