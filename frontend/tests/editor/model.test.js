// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { docExtent, flatWords, normalizeDoc, serializeDoc } from '../../src/editor/model.js'
import { rawProviderV2Doc, rawTranscriptionDoc } from './helpers.js'

describe('normalizeDoc', () => {
  it('normalizes the `text` word key (transcription docs)', () => {
    const doc = normalizeDoc(rawTranscriptionDoc())
    expect(doc.wordKey).toBe('text')
    expect(doc.lines[0][0]).toEqual({ text: 'never', start: 10, end: 10.5 })
  })

  it('normalizes the `word` word key and keeps v2 fields (provider docs)', () => {
    const doc = normalizeDoc(rawProviderV2Doc())
    expect(doc.wordKey).toBe('word')
    expect(doc.lines[0][0].text).toBe('hello')
    expect(doc.lines[0][0].syl.length).toBe(2)
    expect(doc.pages.length).toBe(2)
    expect(doc.lead_ins.length).toBe(2)
    expect(doc.count_in.count).toBe(4)
    expect(doc.duration).toBe(20)
  })

  it('falls back to segments when lines are missing', () => {
    const raw = {
      segments: [
        { words: [{ text: 'la', start: 1, end: 1.5 }] },
        { words: [{ text: 'dee', start: 2, end: 2.5 }, { text: 'da', start: 2.5, end: 3 }] },
      ],
      metadata: {},
    }
    const doc = normalizeDoc(raw)
    expect(doc.lines.length).toBe(2)
    expect(doc.lines[1].map((w) => w.text)).toEqual(['dee', 'da'])
  })

  it('throws on docs with no words', () => {
    expect(() => normalizeDoc({})).toThrow()
    expect(() => normalizeDoc({ lines: [], segments: [] })).toThrow()
  })

  it('does not share structure with the raw input', () => {
    const raw = rawProviderV2Doc()
    const doc = normalizeDoc(raw)
    raw.pages[0].line_idx.push(99)
    raw.metadata.method = 'tampered'
    expect(doc.pages[0].line_idx).toEqual([0, 1])
    expect(doc.metadata.method).toBe('provider-xml')
  })
})

describe('serializeDoc', () => {
  it('round-trips with the original word key', () => {
    const kOut = serializeDoc(normalizeDoc(rawProviderV2Doc()))
    expect(kOut.lines[0][0].word).toBe('hello')
    expect(kOut.lines[0][0].text).toBeUndefined()

    const tOut = serializeDoc(normalizeDoc(rawTranscriptionDoc()))
    expect(tOut.lines[0][0].text).toBe('never')
    expect(tOut.lines[0][0].word).toBeUndefined()
  })

  it('is stable: normalize(serialize(normalize(raw))) == normalize(raw)', () => {
    for (const raw of [rawTranscriptionDoc(), rawProviderV2Doc()]) {
      const canon = normalizeDoc(raw)
      expect(normalizeDoc(serializeDoc(canon))).toEqual(canon)
    }
  })

  it('regenerates segments as a single flat segment', () => {
    const out = serializeDoc(normalizeDoc(rawProviderV2Doc()))
    expect(out.segments.length).toBe(1)
    expect(out.segments[0].words.length).toBe(7)
    expect(out.segments[0].words[0].word).toBe('hello')
  })

  it('preserves v2 fields', () => {
    const out = serializeDoc(normalizeDoc(rawProviderV2Doc()))
    expect(out.pages.length).toBe(2)
    expect(out.lead_ins.length).toBe(2)
    expect(out.count_in.count).toBe(4)
    expect(out.duration).toBe(20)
  })
})

describe('helpers', () => {
  it('flatWords addresses every word in doc order', () => {
    const flat = flatWords(normalizeDoc(rawTranscriptionDoc()))
    expect(flat.length).toBe(17)
    expect(flat[5]).toMatchObject({ lineIdx: 1, wordIdx: 0 })
  })

  it('docExtent is max(duration, last word end)', () => {
    expect(docExtent(normalizeDoc(rawProviderV2Doc()))).toBe(20)
    expect(docExtent(normalizeDoc(rawTranscriptionDoc()))).toBeCloseTo(21.5)
  })
})

describe('multi-voice', () => {
  const multiVoice = () => {
    const raw = rawProviderV2Doc()
    raw.voices = [{ id: '7', name: 'First' }, { id: '8', name: 'Second' }]
    raw.pages = raw.pages.map((p, i) => ({ ...p, voice: i % 2 === 0 ? '7' : '8' }))
    return raw
  }

  it('keeps the voice roster through normalize', () => {
    expect(normalizeDoc(multiVoice()).voices).toEqual([
      { id: '7', name: 'First' },
      { id: '8', name: 'Second' },
    ])
  })

  it('round-trips the roster and the page tags', () => {
    // Losing `voices` on save would leave orphan page tags and silently turn
    // multi-voice rendering off for that song.
    const raw = multiVoice()
    const out = serializeDoc(normalizeDoc(raw))
    expect(out.voices).toEqual(raw.voices)
    expect(out.pages.map((p) => p.voice)).toEqual(raw.pages.map((p) => p.voice))
  })

  it('omits voices for a document that has none', () => {
    expect('voices' in serializeDoc(normalizeDoc(rawProviderV2Doc()))).toBe(false)
  })
})
