// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for adapter behavior beyond the harness's structural checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeWordSync } from '../../src/stage/adapter.mjs'
import { STAGE_WIDTH, STAGE_HEIGHT } from '../../src/stage/frame.mjs'

function allLines(model) {
  return model.pages.flatMap((p) => p.lines)
}

test('garbage input yields an empty, well-formed model', () => {
  for (const input of [null, undefined, 42, 'nope', {}, { lines: 'x' }]) {
    const model = normalizeWordSync(input)
    assert.deepEqual(model.pages, [])
    assert.deepEqual(model.silences, [])
    assert.equal(typeof model.duration, 'number')
    assert.ok(model.tracks && typeof model.tracks === 'object')
  }
})

test('v1 words accept `text` as well as `word`', () => {
  const model = normalizeWordSync({ lines: [[{ text: 'lantern', start: 1, end: 2 }]] })
  const words = allLines(model)[0].words
  assert.deepEqual(words, [[{ text: 'lantern', start: 1, end: 2 }]])
})

test('whitespace-only tokens are treated as fillers and dropped', () => {
  const model = normalizeWordSync({
    lines: [[
      { word: 'ash', start: 1, end: 2 },
      { word: '   ', start: 2, end: 2 },
      { word: 'ferns', start: 3, end: 4 },
    ]],
  })
  const words = allLines(model)[0].words
  assert.equal(words.length, 2)
  assert.deepEqual(words.map((w) => w[0].text), ['ash', 'ferns'])
})

test('synthesized fade windows bracket the page syllables', () => {
  const model = normalizeWordSync({ lines: [[{ word: 'dune', start: 10, end: 11 }]] })
  const page = model.pages[0]
  assert.ok(page.fadeInStart <= 10)
  assert.ok(page.fadeOutStart >= 11)
  assert.ok(page.fadeInDuration >= 0 && page.fadeOutDuration >= 0)
})

test('page pre-roll clamps at zero for early lyrics', () => {
  const model = normalizeWordSync({ lines: [[{ word: 'dawn', start: 0.5, end: 1 }]] })
  assert.ok(model.pages[0].fadeInStart >= 0)
})

test('long word streams split into lines and pages within stage bounds', () => {
  const words = []
  for (let i = 0; i < 30; i++) {
    words.push({ word: `tok${i}`, start: i, end: i + 0.5 })
  }
  const model = normalizeWordSync({ segments: [{ words }] })
  const lines = allLines(model)
  assert.ok(lines.length >= Math.ceil(30 / 8))
  for (const page of model.pages) {
    assert.ok(page.lines.length <= 4)
  }
  for (const line of lines) {
    assert.ok(line.x >= 0 && line.x + line.width <= STAGE_WIDTH)
    assert.ok(line.y >= 0 && line.y + line.height <= STAGE_HEIGHT)
  }
})

test('overlapping synthesized pages get distinct vertical regions', () => {
  // Two explicit pages whose fade windows overlap.
  const model = normalizeWordSync({
    metadata: { format_version: 2 },
    lines: [
      [{ word: 'moths', start: 4, end: 9 }],
      [{ word: 'glow', start: 8, end: 15 }],
    ],
    pages: [
      { line_idx: [0], fade_in_start: 2, fade_in_dur: 0.5, fade_out_start: 10, fade_out_dur: 1 },
      { line_idx: [1], fade_in_start: 8, fade_in_dur: 1, fade_out_start: 16, fade_out_dur: 1 },
    ],
  })
  const [a, b] = model.pages
  const aY = a.lines[0].y
  const bY = b.lines[0].y
  assert.notEqual(aY, bY)
  for (const line of allLines(model)) {
    assert.ok(line.y >= 0 && line.y + line.height <= STAGE_HEIGHT)
  }
})

// Build two back-to-back pages of the given line counts, fades overlapping.
function overlappingPagePair(countA, countB) {
  const lines = []
  const lineIdx = [[], []]
  for (const [page, count] of [countA, countB].entries()) {
    for (let i = 0; i < count; i++) {
      lineIdx[page].push(lines.length)
      lines.push([{ word: `w${page}${i}`, start: page * 6 + i, end: page * 6 + i + 0.5 }])
    }
  }
  return normalizeWordSync({
    metadata: { format_version: 2 },
    lines,
    pages: [
      { line_idx: lineIdx[0], fade_in_start: 0, fade_in_dur: 0.5, fade_out_start: 8, fade_out_dur: 1 },
      { line_idx: lineIdx[1], fade_in_start: 6, fade_in_dur: 0.5, fade_out_start: 14, fade_out_dur: 1 },
    ],
  })
}

function pageExtent(page) {
  return {
    top: Math.min(...page.lines.map((l) => l.y)),
    bottom: Math.max(...page.lines.map((l) => l.y + l.height)),
  }
}

// Regression: the test above uses one-line pages, which never touch whatever
// the region centers are, so it passed straight through the fixed-center bug
// (4+4 blocks are taller than the 168px between the old centers and overlapped
// by 22px). Every pairing of page sizes the paging worker can emit must clear.
// Mixed counts matter as much as matched ones: the clamp inside regionCenter
// only bites when one block is tall, so a tall+short pair exercises a path a
// same-count sweep never reaches. Swept to 5 — one past the worker's 4-line
// cap — because explicit v2 `line_idx` arrays are not capped.
for (let countA = 1; countA <= 5; countA++) {
  for (let countB = 1; countB <= 5; countB++) {
    test(`back-to-back ${countA}+${countB}-line pages do not overlap vertically`, () => {
      const model = overlappingPagePair(countA, countB)
      const [a, b] = model.pages
      assert.equal(a.lines.length, countA)
      assert.equal(b.lines.length, countB)

      const first = pageExtent(a)
      const second = pageExtent(b)
      const gap = Math.max(first.top, second.top) - Math.min(first.bottom, second.bottom)
      assert.ok(gap > 0, `${countA}+${countB}-line pages overlap by ${-gap}px`)

      for (const line of allLines(model)) {
        assert.ok(line.y >= 0 && line.y + line.height <= STAGE_HEIGHT)
      }
    })
  }
}

test('overlapping pages that fit hold the full region gutter', () => {
  // Four lines a page is the paging worker's maximum, so this is the tallest
  // pair the LLM can produce: it must clear the gutter, not merely miss.
  const model = overlappingPagePair(4, 4)
  const [a, b] = model.pages
  const first = pageExtent(a)
  const second = pageExtent(b)
  // Pinned to the literal gutter, not just `> 0`: this is a tuned value and
  // the point of the assertion is to catch it drifting. If REGION_GUTTER is
  // deliberately retuned, change the number here — do not loosen the test.
  assert.equal(second.top - first.bottom, 20)
  // ...and the pair sits symmetric about the stage midline.
  assert.equal(first.top, STAGE_HEIGHT - second.bottom)
})

test('a page too tall for the stage centers instead of flushing to an edge', () => {
  // Not reachable from the paging worker (it caps pages at MAX_LINES_PER_PAGE)
  // but explicit v2 `line_idx` arrays are uncapped, so the degenerate input is
  // reachable from a hand-authored document. It must not invert the clamp.
  const model = overlappingPagePair(12, 12)
  for (const page of model.pages) {
    const { top, bottom } = pageExtent(page)
    assert.ok(top < 0 && bottom > STAGE_HEIGHT, 'overflows the stage, unavoidably')
    assert.equal(top, STAGE_HEIGHT - bottom, 'but overflows symmetrically')
  }
})

test('invalid count_in intervals are not emitted as countdown bars', () => {
  for (const countIn of [
    { start: 5, end: 5, step: 1, count: 4 },
    { start: 2, end: 9, step: 0, count: 4 },
    { start: 2, end: 9, step: 1, count: 0 },
    null,
  ]) {
    const model = normalizeWordSync({
      metadata: { format_version: 2 },
      lines: [[{ word: 'hum', start: 0.5, end: 1 }]],
      count_in: countIn,
    })
    assert.deepEqual(model.silences, [])
  }
})

test('duration covers everything the model renders', () => {
  const model = normalizeWordSync({
    metadata: { format_version: 2 },
    lines: [[{ word: 'hum', start: 10, end: 11 }]],
    count_in: { start: 2, end: 30, step: 1, count: 4 },
  })
  assert.ok(model.duration >= 30)
  assert.ok(model.duration >= model.pages[0].fadeOutStart + model.pages[0].fadeOutDuration)
})

test('a long silent intro gets a synthesized count-in bar', () => {
  const model = normalizeWordSync({ lines: [[{ word: 'rise', start: 6, end: 7 }]] })
  assert.equal(model.silences.length, 1)
  const bar = model.silences[0]
  assert.equal(bar.start, 0)
  assert.equal(bar.end, 6)
  assert.equal(bar.count, 4)
  assert.ok(bar.step > 0)
})

test('a short intro gets no synthesized bar', () => {
  const model = normalizeWordSync({ lines: [[{ word: 'rise', start: 1, end: 2 }]] })
  assert.deepEqual(model.silences, [])
})

test('a long instrumental gap between pages gets a synthesized bar', () => {
  const model = normalizeWordSync({
    lines: [
      [{ word: 'verse', start: 1, end: 2 }],
      [{ word: 'chorus', start: 10, end: 11 }],
    ],
  })
  assert.equal(model.silences.length, 1)
  const bar = model.silences[0]
  assert.ok(bar.start >= 2) // appears no earlier than the last sung word
  assert.equal(bar.end, 10) // counts down to the next page's first word
  assert.equal(bar.count, 4)
  assert.ok(bar.step > 0)
})

test('a short gap between pages gets no synthesized bar', () => {
  const model = normalizeWordSync({
    lines: [
      [{ word: 'verse', start: 1, end: 2 }],
      [{ word: 'chorus', start: 6, end: 7 }], // 4s: splits pages but under the bar threshold
    ],
  })
  assert.deepEqual(model.silences, [])
})

test('authored silences are honored and suppress overlapping synthesized bars', () => {
  const model = normalizeWordSync({
    metadata: { format_version: 2 },
    lines: [
      [{ word: 'verse', start: 1, end: 2 }],
      [{ word: 'chorus', start: 10, end: 11 }],
    ],
    silences: [{ start: 3, end: 10, step: 0.5, count: 14 }],
  })
  assert.equal(model.silences.length, 1)
  const bar = model.silences[0]
  assert.equal(bar.start, 3)
  assert.equal(bar.end, 10)
  assert.equal(bar.step, 0.5)
  assert.equal(bar.count, 14)
})

test('invalid authored silences are dropped', () => {
  const model = normalizeWordSync({
    metadata: { format_version: 2 },
    lines: [[{ word: 'hum', start: 0.5, end: 1 }]],
    silences: [
      { start: 5, end: 5, step: 1, count: 4 },
      { start: 2, end: 9, step: 0, count: 4 },
      { start: 2, end: 9, step: 1, count: 0 },
      null,
    ],
  })
  assert.deepEqual(model.silences, [])
})
