// SPDX-License-Identifier: AGPL-3.0-only
// Canonical editor document for word_sync JSON.
//
// The stored corpus is heterogeneous: provider-origin docs key word text as
// `word`, transcription docs as `text`; only format_version 2 docs carry
// `pages` / `lead_ins` / `count_in` / `syl`. The editor normalizes everything
// into one canonical shape, edits that, and serializes back using the source
// doc's original word key so a load→save round trip is diff-minimal.
//
// Canonical doc:
//   {
//     lines: [[{text, start, end, syl?, interpolated?}, ...], ...],
//     pages?: [{line_idx: [int], ...fadeFields}],
//     lead_ins?: [{line_idx: int, start: number, ...}],
//     count_in?: {...},
//     duration?: number,
//     metadata: {...},
//     wordKey: 'word' | 'text',
//   }

export function clone(value) {
  try {
    return structuredClone(value)
  } catch {
    // Reactive proxies (e.g. a Vue-wrapped doc) can't be structured-cloned.
    // Docs are JSON-shaped data, so a JSON round-trip is equivalent.
    return JSON.parse(JSON.stringify(value))
  }
}

function normalizeWord(w) {
  const text = String(w?.word ?? w?.text ?? '').trim()
  const word = {
    text,
    start: Number(w?.start),
    end: Number(w?.end),
  }
  if (Array.isArray(w?.syl) && w.syl.length) {
    word.syl = w.syl.map((s) => ({
      text: String(s?.text ?? ''),
      start: Number(s?.start),
      end: Number(s?.end),
    }))
  }
  if (w?.interpolated) word.interpolated = true
  return word
}

function detectWordKey(rawLines) {
  for (const line of rawLines) {
    for (const w of line || []) {
      if (w && typeof w === 'object') {
        if ('word' in w) return 'word'
        if ('text' in w) return 'text'
      }
    }
  }
  return 'text'
}

/**
 * Normalize a raw word_sync JSON object into a canonical editor doc.
 * Throws on input that has no usable words at all.
 */
export function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('word_sync doc must be an object')
  }

  let rawLines = Array.isArray(raw.lines) ? raw.lines : null
  if (!rawLines || !rawLines.length) {
    // Fallback mirroring the renderers: one line per transcription segment.
    const segments = Array.isArray(raw.segments) ? raw.segments : []
    rawLines = segments
      .map((seg) => (Array.isArray(seg?.words) ? seg.words : []))
      .filter((words) => words.length)
  }
  if (!rawLines.length) {
    throw new Error('word_sync doc has no lines or segment words')
  }

  const wordKey = detectWordKey(rawLines)
  const lines = rawLines
    .map((line) => (Array.isArray(line) ? line.map(normalizeWord) : []))
    .filter((line) => line.length)

  if (!lines.length) {
    throw new Error('word_sync doc has no non-empty lines')
  }

  const doc = {
    lines,
    metadata: raw.metadata ? clone(raw.metadata) : {},
    wordKey,
  }
  if (Array.isArray(raw.pages)) {
    doc.pages = raw.pages.map((p) => ({
      ...clone(p),
      line_idx: (Array.isArray(p?.line_idx) ? p.line_idx : []).map(Number),
    }))
  }
  if (Array.isArray(raw.lead_ins)) {
    doc.lead_ins = raw.lead_ins.map((l) => ({ ...clone(l), line_idx: Number(l?.line_idx) }))
  }
  if (raw.count_in && typeof raw.count_in === 'object') doc.count_in = clone(raw.count_in)
  // The voice roster rides along untouched. Pages carry `voice` ids that mean
  // nothing without it, so dropping it here would silently un-multi-voice a
  // document the first time it was saved from the editor.
  if (Array.isArray(raw.voices)) doc.voices = clone(raw.voices)
  if (Number.isFinite(raw.duration)) doc.duration = raw.duration
  return doc
}

function serializeWord(w, wordKey) {
  const out = { [wordKey]: w.text, start: w.start, end: w.end }
  if (w.syl) out.syl = clone(w.syl)
  if (w.interpolated) out.interpolated = true
  return out
}

/**
 * Serialize a canonical doc back into word_sync JSON.
 *
 * `segments` is regenerated as a single flat segment (the same shape the
 * pipeline emits for whisper-only docs) — the original segments are stale the
 * moment any edit touches `lines`, and every renderer prefers `lines`.
 */
export function serializeDoc(doc) {
  const wordKey = doc.wordKey === 'word' ? 'word' : 'text'
  const lines = doc.lines.map((line) => line.map((w) => serializeWord(w, wordKey)))
  const out = {
    lines,
    segments: [{ words: lines.flat().map((w) => clone(w)) }],
    metadata: clone(doc.metadata || {}),
  }
  if (doc.pages) out.pages = clone(doc.pages)
  if (doc.lead_ins) out.lead_ins = clone(doc.lead_ins)
  if (doc.count_in) out.count_in = clone(doc.count_in)
  if (doc.voices) out.voices = clone(doc.voices)
  if (Number.isFinite(doc.duration)) out.duration = doc.duration
  return out
}

/** Flat list of words with their (lineIdx, wordIdx) addresses, in doc order. */
export function flatWords(doc) {
  const out = []
  doc.lines.forEach((line, lineIdx) => {
    line.forEach((word, wordIdx) => out.push({ word, lineIdx, wordIdx }))
  })
  return out
}

/** Total time extent of the doc (max word end; falls back to doc.duration). */
export function docExtent(doc) {
  let max = Number.isFinite(doc.duration) ? doc.duration : 0
  for (const line of doc.lines) {
    for (const w of line) {
      if (Number.isFinite(w.end) && w.end > max) max = w.end
    }
  }
  return max
}
