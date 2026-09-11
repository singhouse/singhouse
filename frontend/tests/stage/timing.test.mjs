// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for timing edge cases beyond the golden samples.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeReveal,
  computeLeadIn,
  computePageOpacity,
  describeCountdowns,
  describeFrame,
  validSyllables,
} from '../../src/stage/frame.mjs'

const syl = (start, end, text) => ({ start, end, text })

test('reveal: line with zero valid syllables is always none', () => {
  const l = { words: [[syl(null, 2, 'a')], [syl(1, 2, '')], []] }
  for (const t of [-5, 0, 1.5, 100]) {
    assert.deepEqual(computeReveal(validSyllables(l), t), { kind: 'none' })
  }
})

test('reveal: instant final syllable completes to full at its start', () => {
  const sylls = [syl(1, 2, 'a'), syl(3, 3, 'b')]
  assert.deepEqual(computeReveal(sylls, 2.5), { kind: 'boundary', syllable: 0 })
  assert.deepEqual(computeReveal(sylls, 3), { kind: 'full' })
})

test('reveal: half-open boundaries at syllable start and end', () => {
  const sylls = [syl(1, 2, 'a'), syl(2, 3, 'b')]
  assert.deepEqual(computeReveal(sylls, 1), { kind: 'partial', syllable: 0, fraction: 0 })
  // t = end of a is also t = start of b: b's state supersedes.
  assert.deepEqual(computeReveal(sylls, 2), { kind: 'partial', syllable: 1, fraction: 0 })
  assert.deepEqual(computeReveal(sylls, 3), { kind: 'full' })
})

test('lead-in: never shown when it starts at or after the first syllable', () => {
  const line = { leadIn: { start: 5 }, words: [[syl(5, 6, 'a')]] }
  const sylls = validSyllables(line)
  for (const t of [4, 5, 5.5]) {
    assert.equal(computeLeadIn(line, sylls, t), null)
  }
})

test('lead-in: absent leadIn or no valid syllables reports null', () => {
  const bare = { words: [[syl(5, 6, 'a')]] }
  assert.equal(computeLeadIn(bare, validSyllables(bare), 4), null)
  const empty = { leadIn: { start: 1 }, words: [] }
  assert.equal(computeLeadIn(empty, validSyllables(empty), 2), null)
})

test('page: zero fade-out duration hides the page exactly at fadeOutStart', () => {
  const page = { fadeInStart: 0, fadeInDuration: 0, fadeOutStart: 5, fadeOutDuration: 0 }
  assert.equal(computePageOpacity(page, 4.999999), 1)
  assert.equal(computePageOpacity(page, 5), null)
})

test('page: present with opacity 0 at fadeInStart when fade-in has duration', () => {
  const page = { fadeInStart: 2, fadeInDuration: 1, fadeOutStart: 5, fadeOutDuration: 1 }
  assert.equal(computePageOpacity(page, 2), 0)
  assert.equal(computePageOpacity(page, 1.999999), null)
})

test('countdown: numeral holds k on [end - k*step, end - (k-1)*step)', () => {
  const bars = [{ start: 0, end: 10, step: 1, count: 4, x: 0, y: 0, width: 10, height: 2 }]
  const numeralAt = (t) => describeCountdowns(bars, t)[0].numeral
  assert.equal(numeralAt(5.999999), null)
  assert.equal(numeralAt(6), 4)
  assert.equal(numeralAt(6.999999), 4)
  assert.equal(numeralAt(7), 3)
  assert.equal(numeralAt(9.999999), 1)
  assert.deepEqual(describeCountdowns(bars, 10), [])
})

test('countdown: invalid bars keep their original indices out of the output', () => {
  const bars = [
    { start: 5, end: 4, step: 1, count: 2, x: 0, y: 0, width: 10, height: 2 }, // end <= start
    { start: 0, end: 10, step: 1, count: 4, x: 0, y: 0, width: 10, height: 2 },
    { start: 0, end: 10, step: 1, count: 0, x: 0, y: 0, width: 10, height: 2 }, // count <= 0
  ]
  const out = describeCountdowns(bars, 5)
  assert.equal(out.length, 1)
  assert.equal(out[0].index, 1)
})

test('advisory fields never change the frame descriptor', () => {
  const base = {
    duration: 20,
    tracks: {},
    pages: [
      {
        activeColor: '#fff',
        inactiveColor: '#aaa',
        fadeInStart: 1,
        fadeInDuration: 1,
        fadeOutStart: 8,
        fadeOutDuration: 1,
        lines: [{ x: 0, y: 0, width: 640, height: 40, words: [[syl(3, 5, 'hum')]] }],
      },
    ],
  }
  const decorated = JSON.parse(JSON.stringify(base))
  decorated.mode = 'echo'
  decorated.availableModes = [{ id: 'echo', label: 'Echo' }]
  decorated.pages[0].singStart = 0
  decorated.pages[0].singEnd = 100
  const viewport = { width: 800, height: 600 }
  for (let t = 0; t <= 10; t += 0.25) {
    assert.deepEqual(describeFrame(decorated, t, viewport), describeFrame(base, t, viewport))
  }
})

test('describeFrame tolerates missing optional arrays and junk input', () => {
  const frame = describeFrame({ duration: 1, tracks: {} }, 0, { width: 640, height: 480 })
  assert.deepEqual(frame.pages, [])
  assert.deepEqual(frame.countdowns, [])
})
