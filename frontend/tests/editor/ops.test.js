// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { normalizeDoc } from '../../src/editor/model.js'
import {
  applyOp,
  applyOps,
  deleteWords,
  editWordText,
  insertWord,
  mergeLines,
  nudgeWord,
  shiftRange,
  splitLine,
} from '../../src/editor/ops.js'
import { validateDoc } from '../../src/editor/validate.js'
import { prng, rawProviderV2Doc, rawTranscriptionDoc } from './helpers.js'

const tDoc = () => normalizeDoc(rawTranscriptionDoc())
const kDoc = () => normalizeDoc(rawProviderV2Doc())

describe('splitLine', () => {
  it('splits a line into two at the word index', () => {
    const doc = splitLine(tDoc(), { lineIdx: 0, wordIdx: 2 })
    expect(doc.lines.length).toBe(4)
    expect(doc.lines[0].map((w) => w.text)).toEqual(['never', 'gonna'])
    expect(doc.lines[1].map((w) => w.text)).toEqual(['give', 'you', 'up'])
    // untouched lines shift down intact
    expect(doc.lines[2].map((w) => w.text)[0]).toBe('never')
  })

  it('does not mutate the input doc', () => {
    const before = tDoc()
    const snapshot = JSON.stringify(before)
    splitLine(before, { lineIdx: 1, wordIdx: 1 })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('keeps both halves in the original page and shifts later refs', () => {
    const doc = splitLine(kDoc(), { lineIdx: 0, wordIdx: 1 })
    expect(doc.pages[0].line_idx).toEqual([0, 1, 2])
    expect(doc.pages[1].line_idx).toEqual([3])
    // lead-in stays on the first half; later lead-in shifts
    expect(doc.lead_ins).toEqual([
      { line_idx: 0, start: 3.0 },
      { line_idx: 3, start: 10.5 },
    ])
  })

  it('rejects split points at line edges or out of range', () => {
    expect(() => splitLine(tDoc(), { lineIdx: 0, wordIdx: 0 })).toThrow(RangeError)
    expect(() => splitLine(tDoc(), { lineIdx: 0, wordIdx: 5 })).toThrow(RangeError)
    expect(() => splitLine(tDoc(), { lineIdx: 9, wordIdx: 1 })).toThrow(RangeError)
  })

  it('split then merge is identity', () => {
    const doc = tDoc()
    const roundTripped = mergeLines(splitLine(doc, { lineIdx: 1, wordIdx: 2 }), { lineIdx: 1 })
    expect(roundTripped).toEqual(doc)
  })

  it('split then merge is identity on v2 docs (pages, lead-ins)', () => {
    const doc = kDoc()
    for (let lineIdx = 0; lineIdx < doc.lines.length; lineIdx++) {
      for (let wordIdx = 1; wordIdx < doc.lines[lineIdx].length; wordIdx++) {
        const roundTripped = mergeLines(splitLine(doc, { lineIdx, wordIdx }), { lineIdx })
        expect(roundTripped).toEqual(doc)
      }
    }
  })
})

describe('mergeLines', () => {
  it('merges the next line into the given line', () => {
    const doc = mergeLines(tDoc(), { lineIdx: 0 })
    expect(doc.lines.length).toBe(2)
    expect(doc.lines[0].map((w) => w.text)).toEqual([
      'never', 'gonna', 'give', 'you', 'up', 'never', 'gonna', 'let', 'you', 'down',
    ])
  })

  it('merging across a page boundary moves the line into the first page and drops emptied pages', () => {
    const doc = mergeLines(kDoc(), { lineIdx: 1 })
    expect(doc.pages.length).toBe(1)
    expect(doc.pages[0].line_idx).toEqual([0, 1])
    // lead-in that pointed at the swallowed line disappears
    expect(doc.lead_ins).toEqual([{ line_idx: 0, start: 3.0 }])
  })

  it('rejects merging past the last line', () => {
    expect(() => mergeLines(tDoc(), { lineIdx: 2 })).toThrow(RangeError)
  })
})

describe('editWordText', () => {
  it('replaces text and keeps timing', () => {
    const doc = editWordText(tDoc(), { lineIdx: 0, wordIdx: 4, text: 'up!' })
    const w = doc.lines[0][4]
    expect(w.text).toBe('up!')
    expect(w.start).toBe(12)
    expect(w.end).toBe(12.5)
  })

  it('drops syllable detail (old boundaries described the old text)', () => {
    const doc = editWordText(kDoc(), { lineIdx: 0, wordIdx: 0, text: 'goodbye' })
    expect(doc.lines[0][0].syl).toBeUndefined()
  })

  it('rejects empty text', () => {
    expect(() => editWordText(tDoc(), { lineIdx: 0, wordIdx: 0, text: '  ' })).toThrow()
  })
})

describe('deleteWords', () => {
  it('deletes a range within a line', () => {
    const doc = deleteWords(tDoc(), { lineIdx: 2, fromWordIdx: 3, toWordIdx: 5 })
    expect(doc.lines[2].map((w) => w.text)).toEqual(['never', 'gonna', 'run', 'you'])
  })

  it('removes an emptied line and remaps page/lead-in refs', () => {
    const doc = deleteWords(kDoc(), { lineIdx: 1, fromWordIdx: 0, toWordIdx: 1 })
    expect(doc.lines.length).toBe(2)
    expect(doc.pages[0].line_idx).toEqual([0])
    expect(doc.pages[1].line_idx).toEqual([1])
    expect(doc.lead_ins).toEqual([
      { line_idx: 0, start: 3.0 },
      { line_idx: 1, start: 10.5 },
    ])
  })

  it('refuses to delete the entire doc', () => {
    let doc = tDoc()
    doc = deleteWords(doc, { lineIdx: 2, fromWordIdx: 0, toWordIdx: 6 })
    doc = deleteWords(doc, { lineIdx: 1, fromWordIdx: 0, toWordIdx: 4 })
    expect(() => deleteWords(doc, { lineIdx: 0, fromWordIdx: 0, toWordIdx: 4 })).toThrow()
  })
})

describe('insertWord', () => {
  it('interpolates timing into the gap between neighbours and flags the word', () => {
    const doc = insertWord(tDoc(), { lineIdx: 1, wordIdx: 0, text: 'oh' })
    const w = doc.lines[1][0]
    expect(w.text).toBe('oh')
    expect(w.interpolated).toBe(true)
    // between last word of line 0 (ends 12.5) and old first word of line 1 (starts 14)
    expect(w.start).toBe(12.5)
    expect(w.end).toBe(14)
  })

  it('appends after the final word with a fallback duration', () => {
    const base = tDoc()
    const lastLine = base.lines.length - 1
    const doc = insertWord(base, { lineIdx: lastLine, wordIdx: 7, text: 'yeah' })
    const w = doc.lines[lastLine][7]
    expect(w.start).toBeCloseTo(21.5)
    expect(w.end).toBeCloseTo(22.0)
  })

  it('uses explicit timing verbatim without the interpolated flag', () => {
    const doc = insertWord(tDoc(), { lineIdx: 1, wordIdx: 0, text: 'oh', start: 13.1, end: 13.7 })
    const w = doc.lines[1][0]
    expect(w.text).toBe('oh')
    expect(w.start).toBe(13.1)
    expect(w.end).toBe(13.7)
    expect(w.interpolated).toBeUndefined()
  })

  it('rejects half-specified or inverted explicit timing', () => {
    expect(() => insertWord(tDoc(), { lineIdx: 0, wordIdx: 0, text: 'x', start: 1 })).toThrow(/both start and end/)
    expect(() => insertWord(tDoc(), { lineIdx: 0, wordIdx: 0, text: 'x', end: 1 })).toThrow(/both start and end/)
    expect(() => insertWord(tDoc(), { lineIdx: 0, wordIdx: 0, text: 'x', start: 2, end: 1 })).toThrow(/start <= end/)
    expect(() => insertWord(tDoc(), { lineIdx: 0, wordIdx: 0, text: 'x', start: -1, end: 1 })).toThrow(/start <= end/)
  })
})

describe('nudgeWord', () => {
  it('shifts start/end and rescales syllables into the new interval', () => {
    const doc = nudgeWord(kDoc(), { lineIdx: 0, wordIdx: 0, startDelta: -0.2, endDelta: 0.2 })
    const w = doc.lines[0][0]
    expect(w.start).toBeCloseTo(4.8)
    expect(w.end).toBeCloseTo(5.8)
    // syllable boundary was at the 50% mark; still is
    expect(w.syl[0].start).toBeCloseTo(4.8)
    expect(w.syl[0].end).toBeCloseTo(5.3)
    expect(w.syl[1].end).toBeCloseTo(5.8)
  })

  it('clamps start at 0 and keeps the pair ordered', () => {
    const doc = nudgeWord(tDoc(), { lineIdx: 0, wordIdx: 0, startDelta: -99 })
    expect(doc.lines[0][0].start).toBe(0)
    const doc2 = nudgeWord(tDoc(), { lineIdx: 0, wordIdx: 0, endDelta: -99 })
    expect(doc2.lines[0][0].end).toBe(doc2.lines[0][0].start)
  })
})

describe('shiftRange', () => {
  it('shifts words, syllables and lead-ins in the range only', () => {
    const doc = shiftRange(kDoc(), { fromLine: 2, toLine: 2, delta: 1.5 })
    expect(doc.lines[2][0].start).toBeCloseTo(13.5)
    expect(doc.lines[1][0].start).toBeCloseTo(8.0) // untouched
    expect(doc.lead_ins).toEqual([
      { line_idx: 0, start: 3.0 },
      { line_idx: 2, start: 12.0 },
    ])
  })
})

describe('applyOp / applyOps', () => {
  it('dispatches serialized ops and rejects unknown types', () => {
    const doc = applyOp(tDoc(), { type: 'splitLine', lineIdx: 0, wordIdx: 2 })
    expect(doc.lines.length).toBe(4)
    expect(() => applyOp(tDoc(), { type: 'nope' })).toThrow(/unknown op/)
  })

  it('replays an op log deterministically', () => {
    const ops = [
      { type: 'splitLine', lineIdx: 0, wordIdx: 2 },
      { type: 'editWordText', lineIdx: 1, wordIdx: 0, text: 'GIVE' },
      { type: 'mergeLines', lineIdx: 2 },
    ]
    expect(applyOps(tDoc(), ops)).toEqual(applyOps(tDoc(), ops))
  })
})

describe('random op sequences keep docs valid', () => {
  function randomOp(doc, rand) {
    const lineIdx = Math.floor(rand() * doc.lines.length)
    const line = doc.lines[lineIdx]
    const choice = rand()
    if (choice < 0.3 && line.length > 1) {
      return { type: 'splitLine', lineIdx, wordIdx: 1 + Math.floor(rand() * (line.length - 1)) }
    }
    if (choice < 0.5 && lineIdx < doc.lines.length - 1) {
      return { type: 'mergeLines', lineIdx }
    }
    if (choice < 0.65) {
      const wordIdx = Math.floor(rand() * line.length)
      return { type: 'editWordText', lineIdx, wordIdx, text: `w${Math.floor(rand() * 1e4)}` }
    }
    if (choice < 0.8 && doc.lines.length > 1) {
      const wordIdx = Math.floor(rand() * line.length)
      return { type: 'deleteWords', lineIdx, fromWordIdx: wordIdx, toWordIdx: wordIdx }
    }
    if (choice < 0.9) {
      return { type: 'insertWord', lineIdx, wordIdx: Math.floor(rand() * (line.length + 1)), text: 'la' }
    }
    return {
      type: 'nudgeWord',
      lineIdx,
      wordIdx: Math.floor(rand() * line.length),
      startDelta: (rand() - 0.5) * 0.2,
      endDelta: (rand() - 0.5) * 0.2,
    }
  }

  it.each([
    ['transcription', 1, tDoc],
    ['transcription', 2, tDoc],
    ['provider-v2', 3, kDoc],
    ['provider-v2', 4, kDoc],
  ])('%s doc stays structurally valid (seed %i)', (_name, seed, mk) => {
    const rand = prng(seed * 1337)
    let doc = mk()
    for (let i = 0; i < 200; i++) {
      doc = applyOp(doc, randomOp(doc, rand))
      const { errors } = validateDoc(doc)
      // insert/nudge can legitimately create timing *warnings*; structural
      // errors must never appear.
      expect(errors).toEqual([])
    }
  })
})
