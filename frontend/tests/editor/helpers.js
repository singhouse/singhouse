// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic doc builders for editor tests. All-fake lyrics — the real corpus
// (your own library) lives in gitignored fixtures/ and is exercised by
// corpus.test.js only when present.

/** Build a line of words from a space-separated string; each word gets
 * `dur` seconds starting at `t0`, back to back. */
export function line(text, t0, dur = 0.5) {
  return text.split(/\s+/).map((w, i) => ({
    text: w,
    start: t0 + i * dur,
    end: t0 + (i + 1) * dur,
  }))
}

/** Minimal transcription-style raw doc (word key `text`, no pages). */
export function rawTranscriptionDoc() {
  return {
    lines: [
      line('never gonna give you up', 10),
      line('never gonna let you down', 14),
      line('never gonna run around and desert you', 18),
    ],
    segments: [{ words: [] }],
    metadata: { method: 'whisper-only', model: 'heart' },
  }
}

/** Provider-v2-style raw doc: word key `word`, syllables, pages, lead-ins,
 * count-in. Three lines across two pages. */
export function rawProviderV2Doc() {
  const mkWord = (text, start, end, syl) => ({ word: text, start, end, ...(syl ? { syl } : {}) })
  return {
    lines: [
      [
        mkWord('hello', 5.0, 5.6, [
          { text: 'hel', start: 5.0, end: 5.3 },
          { text: 'lo', start: 5.3, end: 5.6 },
        ]),
        mkWord('there', 5.6, 6.2),
      ],
      [mkWord('general', 8.0, 8.9), mkWord('kenobi', 8.9, 9.8)],
      [mkWord('you', 12.0, 12.4), mkWord('are', 12.4, 12.8), mkWord('bold', 12.8, 13.5)],
    ],
    pages: [
      { line_idx: [0, 1], fade_in_start: 4.0, fade_in_dur: 0.4, fade_out_start: 10.0, fade_out_dur: 0.4 },
      { line_idx: [2], fade_in_start: 11.0, fade_in_dur: 0.4, fade_out_start: 14.0, fade_out_dur: 0.4 },
    ],
    lead_ins: [
      { line_idx: 0, start: 3.0 },
      { line_idx: 2, start: 10.5 },
    ],
    count_in: { start: 1.0, end: 4.6, step: 0.9, count: 4 },
    duration: 20.0,
    segments: [{ words: [] }],
    metadata: { method: 'provider-xml', format_version: 2 },
  }
}

/** Deterministic PRNG (mulberry32) for reproducible random-op tests. */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
