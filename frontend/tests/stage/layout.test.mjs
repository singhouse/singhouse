// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for text-measurement geometry the golden frames deliberately do
// not pin down: x-advance across spaces, alignment, horizontal fitting, and
// the reveal-edge position.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { layoutLine, revealEdgeX } from '../../src/stage/layout.mjs'
import { computeReveal, validSyllables, STAGE_WIDTH } from '../../src/stage/frame.mjs'

// Deterministic fake measurement: every character is 10 virtual px wide.
const measure = (text) => text.length * 10

function line(words, extra = {}) {
  return { x: 40, y: 200, width: 560, height: 48, words, ...extra }
}

test('x-advance across a space: second word starts after word + space width', () => {
  const l = line([
    [{ start: 0, end: 1, text: 'ab' }], // 20 wide
    [{ start: 2, end: 3, text: 'cde' }], // 30 wide
  ])
  const layout = layoutLine(l, measure)
  assert.equal(layout.runs.length, 2)
  assert.deepEqual([layout.runs[0].x0, layout.runs[0].x1], [0, 20])
  // 20 (first word) + 10 (space) = 30
  assert.deepEqual([layout.runs[1].x0, layout.runs[1].x1], [30, 60])
  assert.equal(layout.natural, 60)
  assert.equal(layout.spaceWidth, 10)
})

test('multi-syllable words advance with no intra-word space', () => {
  const l = line([[{ start: 0, end: 1, text: 'ab' }, { start: 1, end: 2, text: 'cd' }]])
  const layout = layoutLine(l, measure)
  assert.equal(layout.runs[1].x0, 20)
  assert.equal(layout.natural, 40)
})

test('invalid syllables and empty words contribute no advance and no space', () => {
  const l = line([
    [{ start: 0, end: 1, text: 'ab' }, { start: 1, end: 2, text: '' }],
    [], // empty word: ignored entirely
    [{ start: null, end: 3, text: 'xx' }], // fully invalid word: no space either
    [{ start: 2, end: 3, text: 'cd' }],
  ])
  const layout = layoutLine(l, measure)
  assert.equal(layout.runs.length, 2)
  // 'ab' (20) + one space (10) -> 'cd' at 30; the skipped words add nothing.
  assert.equal(layout.runs[1].x0, 30)
})

test('whitespace-only syllable is valid and advances measured width', () => {
  const l = line([[{ start: 0, end: 1, text: 'ab' }, { start: 1, end: 2, text: ' ' }, { start: 2, end: 3, text: 'cd' }]])
  const layout = layoutLine(l, measure)
  assert.equal(layout.runs.length, 3)
  assert.deepEqual([layout.runs[1].x0, layout.runs[1].x1], [20, 30])
  assert.equal(layout.runs[2].x0, 30)
})

test('center alignment centers the rendered run on the stage midpoint', () => {
  const l = line([[{ start: 0, end: 1, text: 'abcde' }]], { align: 'center' }) // 50 wide
  const layout = layoutLine(l, measure)
  assert.equal(layout.startX, (STAGE_WIDTH - 50) / 2)
  assert.equal(layout.startX + layout.rendered / 2, STAGE_WIDTH / 2)
})

test('left alignment preserves the provided x', () => {
  const l = line([[{ start: 0, end: 1, text: 'abcde' }]])
  const layout = layoutLine(l, measure)
  assert.equal(layout.startX, 40)
})

test('fit scale-x scales the run to exactly the line width', () => {
  const l = line([[{ start: 0, end: 1, text: 'abcdefghij' }]], { fit: 'scale-x', width: 200 }) // natural 100
  const layout = layoutLine(l, measure)
  assert.equal(layout.scaleX, 2)
  assert.equal(layout.rendered, 200)
})

test('fit none keeps natural width but clamps overlong runs inside the stage', () => {
  const short = layoutLine(line([[{ start: 0, end: 1, text: 'ab' }]], { fit: 'none' }), measure)
  assert.equal(short.scaleX, 1)

  const long = layoutLine(
    line([[{ start: 0, end: 1, text: 'x'.repeat(100) }]], { fit: 'none', align: 'center' }), // natural 1000
    measure
  )
  assert.ok(long.rendered <= STAGE_WIDTH)
  assert.ok(long.startX >= 0)
  assert.ok(long.startX + long.rendered <= STAGE_WIDTH)
})

test('reveal edge positions across the wipe states', () => {
  const l = line([
    [{ start: 0, end: 1, text: 'ab' }], // run 0: [0, 20]
    [{ start: 2, end: 3, text: 'cd' }], // run 1: [30, 50]
  ])
  const layout = layoutLine(l, measure)
  const x0 = layout.startX
  assert.equal(revealEdgeX(layout, { kind: 'none' }), x0)
  assert.equal(revealEdgeX(layout, { kind: 'partial', syllable: 0, fraction: 0.5 }), x0 + 10)
  assert.equal(revealEdgeX(layout, { kind: 'boundary', syllable: 0 }), x0 + 20)
  assert.equal(revealEdgeX(layout, { kind: 'partial', syllable: 1, fraction: 0 }), x0 + 30)
  // 'ab' (20) + space (10) + 'cd' (20) = 50 total
  assert.equal(revealEdgeX(layout, { kind: 'full' }), x0 + 50)
})

test('reveal edge honors horizontal scaling', () => {
  const l = line([[{ start: 0, end: 1, text: 'abcdefghij' }]], { fit: 'scale-x', width: 200 }) // scaleX 2
  const layout = layoutLine(l, measure)
  assert.equal(revealEdgeX(layout, { kind: 'partial', syllable: 0, fraction: 0.25 }), layout.startX + 50)
  assert.equal(revealEdgeX(layout, { kind: 'full' }), layout.startX + 200)
})

test('space activation: never earlier than the preceding syllable completes', () => {
  // Word one ends at t=1; word two starts at t=2. The space sits at [20, 30].
  const l = line([
    [{ start: 0, end: 1, text: 'ab' }],
    [{ start: 2, end: 3, text: 'cd' }],
  ])
  const layout = layoutLine(l, measure)
  const sylls = validSyllables(l)
  const spaceRight = layout.startX + layout.runs[1].x0 * layout.scaleX

  // While the reveal sits in the inter-word gap, the edge stops at the first
  // word's right edge: the space is not yet active.
  for (const t of [1.0, 1.5, 1.999]) {
    const edge = revealEdgeX(layout, computeReveal(sylls, t))
    assert.equal(edge, layout.startX + 20)
    assert.ok(edge < spaceRight)
  }
  // The instant the second word's first syllable starts, the edge jumps to
  // that syllable's left edge and the space becomes active — not before.
  const atStart = revealEdgeX(layout, computeReveal(sylls, 2.0))
  assert.equal(atStart, spaceRight)
})

test('layout run indices line up with the valid-syllable flattening', () => {
  const l = line([
    [{ start: 0, end: 1, text: 'ab' }, { start: 1, end: 2, text: '' }, { start: 2, end: 3, text: 'cd' }],
    [{ start: 4, end: 5, text: 'ef' }],
  ])
  const layout = layoutLine(l, measure)
  const sylls = validSyllables(l)
  assert.equal(layout.runs.length, sylls.length)
  sylls.forEach((s, i) => assert.equal(layout.runs[i].text, s.text))
})
