// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { normalizeDoc } from '../../src/editor/model.js'
import { validateDoc } from '../../src/editor/validate.js'
import { rawProviderV2Doc, rawTranscriptionDoc } from './helpers.js'

const codes = (issues) => issues.map((i) => i.code)

describe('validateDoc', () => {
  it('passes clean docs', () => {
    for (const raw of [rawTranscriptionDoc(), rawProviderV2Doc()]) {
      const { errors, warnings, ok } = validateDoc(normalizeDoc(raw))
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
      expect(ok).toBe(true)
    }
  })

  it('flags empty docs and empty lines', () => {
    expect(validateDoc({ lines: [] }).ok).toBe(false)
    const doc = normalizeDoc(rawTranscriptionDoc())
    doc.lines[1] = []
    expect(codes(validateDoc(doc).errors)).toContain('empty-line')
  })

  it('flags word-level structural errors', () => {
    const doc = normalizeDoc(rawTranscriptionDoc())
    doc.lines[0][1].text = '  '
    doc.lines[0][2].start = NaN
    doc.lines[0][3].start = -1
    doc.lines[1][1].end = doc.lines[1][1].start - 0.5
    const errs = codes(validateDoc(doc).errors)
    expect(errs).toContain('empty-word')
    expect(errs).toContain('bad-time')
    expect(errs).toContain('negative-time')
    expect(errs).toContain('negative-duration')
  })

  it('warns on out-of-order words (within a line and across lines)', () => {
    const doc = normalizeDoc(rawTranscriptionDoc())
    // swap two words' timing within line 0
    const [a, b] = [doc.lines[0][1], doc.lines[0][2]]
    ;[a.start, a.end, b.start, b.end] = [b.start, b.end, a.start, a.end]
    const res1 = validateDoc(doc)
    expect(codes(res1.errors)).toEqual([])
    expect(codes(res1.warnings)).toContain('out-of-order')

    const doc2 = normalizeDoc(rawTranscriptionDoc())
    // shift line 2 to start before line 1 (duet-style overlap)
    for (const w of doc2.lines[2]) {
      w.start -= 6
      w.end -= 6
    }
    const res2 = validateDoc(doc2)
    expect(codes(res2.errors)).toEqual([])
    expect(codes(res2.warnings)).toContain('line-overlap')
  })

  it('warns on zero-duration and overlapping words', () => {
    const doc = normalizeDoc(rawTranscriptionDoc())
    doc.lines[0][0].end = doc.lines[0][0].start
    doc.lines[0][2].start -= 0.2 // overlaps word 1
    const { errors, warnings } = validateDoc(doc)
    expect(errors).toEqual([])
    expect(codes(warnings)).toContain('zero-duration')
    expect(codes(warnings)).toContain('word-overlap')
  })

  it('flags syllable issues', () => {
    const doc = normalizeDoc(rawProviderV2Doc())
    doc.lines[0][0].syl[1].end = 99 // outside word
    doc.lines[0][0].syl[0].text = 'xxx' // concat mismatch
    const { warnings } = validateDoc(doc)
    expect(codes(warnings)).toContain('syl-outside-word')
    expect(codes(warnings)).toContain('syl-text-mismatch')

    const doc2 = normalizeDoc(rawProviderV2Doc())
    ;[doc2.lines[0][0].syl[0], doc2.lines[0][0].syl[1]] = [
      doc2.lines[0][0].syl[1],
      doc2.lines[0][0].syl[0],
    ]
    expect(codes(validateDoc(doc2).errors)).toContain('syl-out-of-order')
  })

  it('flags page reference errors and unpaged lines', () => {
    const doc = normalizeDoc(rawProviderV2Doc())
    doc.pages[1].line_idx = [0, 99]
    const { errors, warnings } = validateDoc(doc)
    expect(codes(errors)).toContain('dangling-page-ref')
    expect(codes(errors)).toContain('duplicate-page-ref')
    expect(codes(warnings)).toContain('unpaged-line')
  })

  it('flags dangling lead-ins', () => {
    const doc = normalizeDoc(rawProviderV2Doc())
    doc.lead_ins[0].line_idx = 42
    expect(codes(validateDoc(doc).errors)).toContain('dangling-lead-in')
  })
})
