// SPDX-License-Identifier: AGPL-3.0-only
// Pure edit operations over the canonical editor doc (see model.js).
//
// Every op is (doc, params) → new doc. Inputs are never mutated; invalid
// params throw RangeError/Error so a buggy caller fails loudly instead of
// corrupting a doc. Ops are serializable as plain objects ({type, ...params})
// so an editing session is (initialDoc, opLog): that gives undo/redo by
// replay, reproducible bug reports, and golden tests for free.
//
// Structural ops (split/merge/delete) remap `pages[].line_idx` and
// `lead_ins[].line_idx` so v2 (provider-origin) docs survive editing. `shiftRange`
// deliberately does NOT touch page fade timelines — retiming a v2 page
// timeline is out of scope for the editor; the validator warns instead.

import { clone } from './model.js'

function checkLine(doc, lineIdx) {
  if (!Number.isInteger(lineIdx) || lineIdx < 0 || lineIdx >= doc.lines.length) {
    throw new RangeError(`lineIdx ${lineIdx} out of range (0..${doc.lines.length - 1})`)
  }
}

function checkWord(doc, lineIdx, wordIdx) {
  checkLine(doc, lineIdx)
  const len = doc.lines[lineIdx].length
  if (!Number.isInteger(wordIdx) || wordIdx < 0 || wordIdx >= len) {
    throw new RangeError(`wordIdx ${wordIdx} out of range (0..${len - 1}) in line ${lineIdx}`)
  }
}

/**
 * Remap line references after a structural change.
 * `mapIdx(oldIdx)` returns the new index, an array of new indices (split), or
 * null when the line was removed. Pages whose line_idx empties out are
 * dropped. Dedupe is across ALL pages (first page in order wins): merging a
 * line from page B into a line from page A must leave the merged line in A
 * only — a line referenced by two pages would render twice.
 *
 * `leadInMapIdx` overrides the mapping for lead_ins when their semantics
 * diverge from pages (a merged-away line's lead-in is dropped, not remapped:
 * it pointed at a line start that no longer exists).
 */
function remapLineRefs(doc, mapIdx, leadInMapIdx = mapIdx) {
  if (doc.pages) {
    const seen = new Set()
    doc.pages = doc.pages
      .map((page) => {
        const line_idx = page.line_idx
          .flatMap((i) => {
            const mapped = mapIdx(i)
            if (mapped === null) return []
            return Array.isArray(mapped) ? mapped : [mapped]
          })
          .filter((i) => (seen.has(i) ? false : (seen.add(i), true)))
        return { ...page, line_idx }
      })
      .filter((page) => page.line_idx.length)
    if (!doc.pages.length) delete doc.pages
  }
  if (doc.lead_ins) {
    doc.lead_ins = doc.lead_ins
      .map((l) => {
        const mapped = leadInMapIdx(l.line_idx)
        if (mapped === null) return null
        // A split line keeps its lead-in on the first half.
        return { ...l, line_idx: Array.isArray(mapped) ? mapped[0] : mapped }
      })
      .filter(Boolean)
    if (!doc.lead_ins.length) delete doc.lead_ins
  }
}

/** Split line `lineIdx` before word `wordIdx` (which starts the new line). */
export function splitLine(doc, { lineIdx, wordIdx }) {
  checkLine(doc, lineIdx)
  const len = doc.lines[lineIdx].length
  if (!Number.isInteger(wordIdx) || wordIdx <= 0 || wordIdx >= len) {
    throw new RangeError(`split point ${wordIdx} must be inside line ${lineIdx} (1..${len - 1})`)
  }
  const next = clone(doc)
  const line = next.lines[lineIdx]
  next.lines.splice(lineIdx, 1, line.slice(0, wordIdx), line.slice(wordIdx))
  remapLineRefs(next, (i) => (i < lineIdx ? i : i > lineIdx ? i + 1 : [lineIdx, lineIdx + 1]))
  return next
}

/** Merge line `lineIdx + 1` into line `lineIdx`. */
export function mergeLines(doc, { lineIdx }) {
  checkLine(doc, lineIdx)
  if (lineIdx + 1 >= doc.lines.length) {
    throw new RangeError(`no line after ${lineIdx} to merge`)
  }
  const next = clone(doc)
  const [tail] = next.lines.splice(lineIdx + 1, 1)
  next.lines[lineIdx] = next.lines[lineIdx].concat(tail)
  remapLineRefs(
    next,
    (i) => (i <= lineIdx ? i : i === lineIdx + 1 ? lineIdx : i - 1),
    (i) => (i <= lineIdx ? i : i === lineIdx + 1 ? null : i - 1),
  )
  return next
}

/** Replace a word's text. Any syllable detail is dropped — the old syllable
 * boundaries described the old text; the renderer falls back to a whole-word
 * wipe. */
export function editWordText(doc, { lineIdx, wordIdx, text }) {
  checkWord(doc, lineIdx, wordIdx)
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('word text must be non-empty (use deleteWords to remove)')
  const next = clone(doc)
  const word = next.lines[lineIdx][wordIdx]
  word.text = trimmed
  delete word.syl
  return next
}

/** Delete words [fromWordIdx..toWordIdx] (inclusive) from one line. A line
 * left empty is removed and line refs are remapped. */
export function deleteWords(doc, { lineIdx, fromWordIdx, toWordIdx = fromWordIdx }) {
  checkWord(doc, lineIdx, fromWordIdx)
  checkWord(doc, lineIdx, toWordIdx)
  if (toWordIdx < fromWordIdx) throw new RangeError('toWordIdx < fromWordIdx')
  const next = clone(doc)
  next.lines[lineIdx].splice(fromWordIdx, toWordIdx - fromWordIdx + 1)
  if (!next.lines[lineIdx].length) {
    next.lines.splice(lineIdx, 1)
    if (!next.lines.length) throw new Error('cannot delete the last remaining words of the doc')
    remapLineRefs(next, (i) => (i < lineIdx ? i : i === lineIdx ? null : i - 1))
  }
  return next
}

/** Insert a new word before `wordIdx` (0..line.length).
 *
 * With explicit `start`/`end` (e.g. a span drawn on the timing lane) the word
 * uses that timing verbatim and is NOT flagged — the user placed it
 * deliberately. Otherwise timing is interpolated into the gap between its
 * flat-order neighbours and the word is flagged `interpolated` so the UI can
 * surface it for manual retiming. */
export function insertWord(doc, { lineIdx, wordIdx, text, start: exStart, end: exEnd }) {
  checkLine(doc, lineIdx)
  const len = doc.lines[lineIdx].length
  if (!Number.isInteger(wordIdx) || wordIdx < 0 || wordIdx > len) {
    throw new RangeError(`insert point ${wordIdx} out of range (0..${len})`)
  }
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('word text must be non-empty')

  if (exStart !== undefined || exEnd !== undefined) {
    if (!Number.isFinite(exStart) || !Number.isFinite(exEnd)) {
      throw new Error('explicit timing requires both start and end')
    }
    if (exStart < 0 || exEnd < exStart) {
      throw new Error('explicit timing must satisfy 0 <= start <= end')
    }
    const next = clone(doc)
    next.lines[lineIdx].splice(wordIdx, 0, { text: trimmed, start: exStart, end: exEnd })
    return next
  }

  const next = clone(doc)
  const line = next.lines[lineIdx]
  const prev =
    wordIdx > 0
      ? line[wordIdx - 1]
      : lineIdx > 0
        ? next.lines[lineIdx - 1][next.lines[lineIdx - 1].length - 1]
        : null
  const after =
    wordIdx < len ? line[wordIdx] : lineIdx + 1 < next.lines.length ? next.lines[lineIdx + 1][0] : null

  const FALLBACK_DUR = 0.5
  let start = prev ? prev.end : after ? Math.max(0, after.start - FALLBACK_DUR) : 0
  let end = after ? after.start : start + FALLBACK_DUR
  if (end < start) end = start

  line.splice(wordIdx, 0, { text: trimmed, start, end, interpolated: true })
  return next
}

function rescaleSyl(word, oldStart, oldEnd) {
  if (!word.syl) return
  const oldLen = oldEnd - oldStart
  const newLen = word.end - word.start
  word.syl = word.syl.map((s) => {
    if (oldLen <= 0) return { ...s, start: word.start, end: word.end }
    return {
      ...s,
      start: word.start + ((s.start - oldStart) / oldLen) * newLen,
      end: word.start + ((s.end - oldStart) / oldLen) * newLen,
    }
  })
}

/** Adjust a word's start/end by deltas (seconds). Start is clamped to >= 0
 * and the pair is kept ordered; syllable times are rescaled into the new
 * interval. */
export function nudgeWord(doc, { lineIdx, wordIdx, startDelta = 0, endDelta = 0 }) {
  checkWord(doc, lineIdx, wordIdx)
  const next = clone(doc)
  const word = next.lines[lineIdx][wordIdx]
  const oldStart = word.start
  const oldEnd = word.end
  word.start = Math.max(0, oldStart + startDelta)
  word.end = Math.max(word.start, oldEnd + endDelta)
  rescaleSyl(word, oldStart, oldEnd)
  return next
}

/** Shift every word (and syllable, and lead-in) in lines
 * [fromLine..toLine] by `delta` seconds. The block-displacement fix. */
export function shiftRange(doc, { fromLine, toLine, delta }) {
  checkLine(doc, fromLine)
  checkLine(doc, toLine)
  if (toLine < fromLine) throw new RangeError('toLine < fromLine')
  if (!Number.isFinite(delta)) throw new Error('delta must be a finite number')
  const next = clone(doc)
  for (let i = fromLine; i <= toLine; i++) {
    for (const word of next.lines[i]) {
      word.start = Math.max(0, word.start + delta)
      word.end = Math.max(word.start, word.end + delta)
      if (word.syl) {
        word.syl = word.syl.map((s) => ({
          ...s,
          start: Math.max(0, s.start + delta),
          end: Math.max(0, s.end + delta),
        }))
      }
    }
  }
  if (next.lead_ins) {
    next.lead_ins = next.lead_ins.map((l) =>
      l.line_idx >= fromLine && l.line_idx <= toLine
        ? { ...l, start: Math.max(0, l.start + delta) }
        : l,
    )
  }
  return next
}

const OPS = {
  splitLine,
  mergeLines,
  editWordText,
  deleteWords,
  insertWord,
  nudgeWord,
  shiftRange,
}

/** Apply a serialized op object ({type, ...params}). */
export function applyOp(doc, op) {
  const fn = OPS[op?.type]
  if (!fn) throw new Error(`unknown op type: ${op?.type}`)
  return fn(doc, op)
}

/** Replay an op log against a doc. */
export function applyOps(doc, ops) {
  return ops.reduce((acc, op) => applyOp(acc, op), doc)
}

export const OP_TYPES = Object.keys(OPS)
