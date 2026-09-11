// SPDX-License-Identifier: AGPL-3.0-only
// Word-sync adapter: normalizes word-sync lyrics JSON (v1 or v2) into the
// stage model consumed by the renderer core.
//
// Layout heuristics here are product behavior, not compatibility
// requirements; the contract-stable parts are: syllable text/timing preserved
// exactly, fillers dropped, v1 words become single syllables, explicit v2
// page/fade/count-in/lead-in/silence data honored, long instrumental gaps get
// a synthesized count-in bar, and geometry stays inside the 640x480 stage.

import { STAGE_WIDTH, STAGE_HEIGHT, isFiniteNumber } from './frame.mjs'

const MAX_LINES_PER_PAGE = 4
const MAX_WORDS_PER_LINE = 8
const PAGE_PREROLL = 2.0
const PAGE_FADE = 0.4
const PAGE_HOLD = 1.0
const LINE_BREAK_GAP = 1.5
const PAGE_BREAK_GAP = 3.0

// Instrumental break bars. A silent stretch at least INSTRUMENTAL_GAP_SEC long
// between sung pages (or INSTRUMENTAL_INTRO_SEC before the first page) gets a
// countdown bar: a progress fill across the gap plus a COUNT_IN_BEATS numeral
// count-in before re-entry. Beat length is estimated from the lyrics timing.
const INSTRUMENTAL_GAP_SEC = 5.0
const INSTRUMENTAL_INTRO_SEC = 2.0
const COUNT_IN_BEATS = 4
const BEAT_MIN_SEC = 0.3
const BEAT_MAX_SEC = 0.75
const BEAT_DEFAULT_SEC = 0.5

const LINE_HEIGHT = 52
// Vertical distance between successive line box tops within a page; may be
// smaller than the box height (glyphs at the ~70% factor do not collide).
const LINE_PITCH = 46
const LINE_MARGIN_X = 40
// Target clear space between the two vertical regions when overlapping pages
// are on screen together. Regions are derived from the pages' own heights
// rather than fixed centers, so this holds exactly for every page size the
// paging worker emits (up to MAX_LINES_PER_PAGE). Taller hand-authored pages
// compress it — see regionCenter.
const REGION_GUTTER = 20

const ACTIVE_COLOR = '#ffdd66'
const INACTIVE_COLOR = '#ffffff'
const ACTIVE_BORDER = '#332200'
const INACTIVE_BORDER = '#222222'

// One input token -> one word (array of syllables), or null for fillers and
// unusable tokens. Explicit `syl` arrays are honored verbatim; otherwise the
// word becomes a single syllable spanning its own start/end.
function parseWordToken(token) {
  if (!token || typeof token !== 'object') return null
  if (Array.isArray(token.syl) && token.syl.length > 0) {
    const syllables = token.syl
      .filter(
        (s) =>
          s &&
          typeof s.text === 'string' &&
          s.text !== '' &&
          isFiniteNumber(s.start) &&
          isFiniteNumber(s.end)
      )
      .map((s) => ({ text: s.text, start: s.start, end: s.end }))
    return syllables.length > 0 ? syllables : null
  }
  const text = typeof token.word === 'string' ? token.word : typeof token.text === 'string' ? token.text : ''
  if (text.trim() === '') return null // empty filler token
  if (!isFiniteNumber(token.start) || !isFiniteNumber(token.end)) return null
  return [{ text, start: token.start, end: token.end }]
}

function parseWordArray(tokens) {
  const words = []
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const word = parseWordToken(token)
    if (word) words.push(word)
  }
  return words
}

function wordStart(word) {
  return word[0].start
}

function wordEnd(word) {
  return word[word.length - 1].end
}

// Group a flat word stream into readable lines: break on a gap larger than
// LINE_BREAK_GAP seconds or when a line reaches MAX_WORDS_PER_LINE words.
function groupWordsIntoLines(words) {
  const lines = []
  let current = []
  let previousEnd = null
  for (const word of words) {
    const breakForGap = previousEnd !== null && wordStart(word) - previousEnd > LINE_BREAK_GAP
    if (current.length > 0 && (current.length >= MAX_WORDS_PER_LINE || breakForGap)) {
      lines.push(current)
      current = []
    }
    current.push(word)
    previousEnd = wordEnd(word)
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function lineStart(lineWords) {
  return wordStart(lineWords[0])
}

function lineEnd(lineWords) {
  return wordEnd(lineWords[lineWords.length - 1])
}

// Group lines into pages: break on a gap larger than PAGE_BREAK_GAP seconds
// or when a page reaches MAX_LINES_PER_PAGE lines.
function groupLinesIntoPages(lineRecords) {
  const pages = []
  let current = []
  let previousEnd = null
  for (const record of lineRecords) {
    const breakForGap = previousEnd !== null && lineStart(record.words) - previousEnd > PAGE_BREAK_GAP
    if (current.length > 0 && (current.length >= MAX_LINES_PER_PAGE || breakForGap)) {
      pages.push(current)
      current = []
    }
    current.push(record)
    previousEnd = lineEnd(record.words)
  }
  if (current.length > 0) pages.push(current)
  return pages
}

function synthesizedFades(records) {
  const first = Math.min(...records.map((r) => lineStart(r.words)))
  const last = Math.max(...records.map((r) => lineEnd(r.words)))
  return {
    fadeInStart: Math.max(0, first - PAGE_PREROLL),
    fadeInDuration: PAGE_FADE,
    fadeOutStart: last + PAGE_HOLD,
    fadeOutDuration: PAGE_FADE,
  }
}

// Visual height of a `count`-line block. The boxes overhang the pitch by
// (LINE_HEIGHT - LINE_PITCH), half above the first line and half below the
// last, so the block is symmetric about the center placeLines() is given.
function blockHeight(count) {
  return count * LINE_PITCH + (LINE_HEIGHT - LINE_PITCH)
}

// Stack a page's lines vertically around a center, centered horizontally.
function placeLines(page, centerY) {
  const count = page.lines.length
  const blockTop = centerY - (count * LINE_PITCH) / 2
  page.lines.forEach((line, i) => {
    line.x = LINE_MARGIN_X
    line.width = STAGE_WIDTH - 2 * LINE_MARGIN_X
    line.height = LINE_HEIGHT
    line.y = blockTop + i * LINE_PITCH + (LINE_PITCH - LINE_HEIGHT) / 2
  })
}

function pagesOverlap(a, b) {
  const aEnd = Math.max(a.fadeOutStart, a.fadeInStart) + Math.max(a.fadeOutDuration, 0)
  const bEnd = Math.max(b.fadeOutStart, b.fadeInStart) + Math.max(b.fadeOutDuration, 0)
  return a.fadeInStart < bEnd && b.fadeInStart < aEnd
}

// Center for a `count`-line page in region 0 (above the gutter) or region 1
// (below it): the block is pushed off the stage midline by half the gutter
// plus its own half-height, then clamped so it stays on the stage.
//
// Staying on stage wins over holding the gutter — a line drawn off the frame
// is a word the singer cannot read, which is worse than a tight gap. A block
// over 230px tall (six-plus lines, which the paging worker never emits) can't
// both clear the midline and fit above it, so the clamp lets it eat into the
// gutter and two such pages may touch.
function regionCenter(region, count) {
  const height = blockHeight(count)
  const half = height / 2
  const middle = STAGE_HEIGHT / 2
  // Taller than the stage itself: no placement is on-stage, and the clamp
  // below would invert and flush the block to one edge. Center it so the
  // unavoidable overflow is at least symmetric.
  if (height >= STAGE_HEIGHT) return middle
  const center =
    region === 0 ? middle - REGION_GUTTER / 2 - half : middle + REGION_GUTTER / 2 + half
  return Math.min(Math.max(center, half), STAGE_HEIGHT - half)
}

// Place overlapping pages into separate vertical regions when possible;
// standalone pages center in the stage.
function placePages(pages) {
  const regions = new Array(pages.length).fill(null)
  for (let i = 0; i < pages.length; i++) {
    const overlapsPrev = i > 0 && pagesOverlap(pages[i - 1], pages[i])
    if (overlapsPrev) {
      if (regions[i - 1] === null) regions[i - 1] = 0
      regions[i] = 1 - regions[i - 1]
    }
  }
  pages.forEach((page, i) => {
    placeLines(
      page,
      regions[i] === null ? STAGE_HEIGHT / 2 : regionCenter(regions[i], page.lines.length)
    )
  })
}

function buildLineRecord(words) {
  return {
    align: 'center',
    x: LINE_MARGIN_X,
    y: 0,
    width: STAGE_WIDTH - 2 * LINE_MARGIN_X,
    height: LINE_HEIGHT,
    leadIn: null,
    words,
  }
}

function buildPage(records, fades) {
  return {
    activeColor: ACTIVE_COLOR,
    inactiveColor: INACTIVE_COLOR,
    activeBorder: ACTIVE_BORDER,
    inactiveBorder: INACTIVE_BORDER,
    ...fades,
    lines: records,
  }
}

// Median consecutive syllable-start interval, clamped to a musical beat range
// (~80-200 BPM). Falls back to a half-second beat when there is too little
// timing data to estimate from.
function estimateBeatSec(pages) {
  const starts = []
  for (const page of pages) {
    for (const line of page.lines) {
      for (const word of line.words) {
        for (const syl of word) {
          if (isFiniteNumber(syl.start)) starts.push(syl.start)
        }
      }
    }
  }
  if (starts.length < 4) return BEAT_DEFAULT_SEC
  starts.sort((a, b) => a - b)
  const intervals = []
  for (let i = 1; i < starts.length; i++) {
    const d = starts[i] - starts[i - 1]
    if (d > 0 && d < 1.5) intervals.push(d)
  }
  if (intervals.length === 0) return BEAT_DEFAULT_SEC
  intervals.sort((a, b) => a - b)
  const median = intervals[Math.floor(intervals.length / 2)]
  return Math.max(BEAT_MIN_SEC, Math.min(BEAT_MAX_SEC, median))
}

function pageFirstStart(page) {
  let min = Infinity
  for (const line of page.lines) {
    for (const word of line.words) {
      for (const syl of word) {
        if (isFiniteNumber(syl.start) && syl.start < min) min = syl.start
      }
    }
  }
  return min
}

function pageLastEnd(page) {
  let max = -Infinity
  for (const line of page.lines) {
    for (const word of line.words) {
      for (const syl of word) {
        if (isFiniteNumber(syl.end) && syl.end > max) max = syl.end
      }
    }
  }
  return max
}

// Geometry/color defaults shared by every countdown bar, centered mid-stage.
function silenceBar(start, end, step, count) {
  return {
    start,
    end,
    step,
    count,
    x: 60,
    y: 282.5,
    width: 520,
    height: 35,
    activeColor: ACTIVE_COLOR,
    inactiveColor: '#555555',
    border: '#000000',
    borderSize: 2,
  }
}

// Validate an importer-authored silence entry and fill any missing
// geometry/colors with the shared defaults. Returns null when unusable.
function parseAuthoredSilence(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!isFiniteNumber(entry.start) || !isFiniteNumber(entry.end)) return null
  if (!isFiniteNumber(entry.step) || !isFiniteNumber(entry.count)) return null
  if (entry.step <= 0 || entry.count <= 0 || entry.end <= entry.start) return null
  const bar = silenceBar(entry.start, entry.end, entry.step, entry.count)
  if (isFiniteNumber(entry.x)) bar.x = entry.x
  if (isFiniteNumber(entry.y)) bar.y = entry.y
  if (isFiniteNumber(entry.width)) bar.width = entry.width
  if (isFiniteNumber(entry.height)) bar.height = entry.height
  if (typeof entry.activeColor === 'string') bar.activeColor = entry.activeColor
  if (typeof entry.inactiveColor === 'string') bar.inactiveColor = entry.inactiveColor
  if (typeof entry.border === 'string') bar.border = entry.border
  if (isFiniteNumber(entry.borderSize)) bar.borderSize = entry.borderSize
  return bar
}

export function normalizeWordSync(json) {
  const doc = json && typeof json === 'object' ? json : {}

  // Collect lines of words. Explicit `lines` arrays (v1 and v2) are honored
  // as given; flat v1 `segments` words are regrouped by gap/word-count.
  let lineWordGroups = []
  if (Array.isArray(doc.lines)) {
    lineWordGroups = doc.lines.map(parseWordArray)
  } else if (Array.isArray(doc.segments)) {
    const tokens = []
    for (const segment of doc.segments) {
      if (segment && Array.isArray(segment.words)) tokens.push(...segment.words)
    }
    lineWordGroups = groupWordsIntoLines(parseWordArray(tokens))
  }

  // Keep original indices so explicit v2 page/lead-in references stay valid
  // even when some lines turn out empty after filler removal.
  const lineRecords = lineWordGroups.map((words) => (words.length > 0 ? buildLineRecord(words) : null))

  // Lead-ins attach to lines by original index.
  for (const entry of Array.isArray(doc.lead_ins) ? doc.lead_ins : []) {
    if (!entry || typeof entry !== 'object') continue
    if (!isFiniteNumber(entry.start)) continue
    const record = Number.isInteger(entry.line_idx) ? lineRecords[entry.line_idx] : null
    if (record) record.leadIn = { start: entry.start }
  }

  // Pages: explicit v2 page data when present, otherwise grouped by heuristic.
  const pages = []
  const explicitPages = Array.isArray(doc.pages) ? doc.pages : []
  const claimed = new Set()
  for (const pageDef of explicitPages) {
    if (!pageDef || typeof pageDef !== 'object' || !Array.isArray(pageDef.line_idx)) continue
    const records = []
    for (const idx of pageDef.line_idx) {
      if (Number.isInteger(idx) && lineRecords[idx]) {
        records.push(lineRecords[idx])
        claimed.add(idx)
      }
    }
    if (records.length === 0) continue
    const defaults = synthesizedFades(records)
    pages.push(
      buildPage(records, {
        fadeInStart: isFiniteNumber(pageDef.fade_in_start) ? pageDef.fade_in_start : defaults.fadeInStart,
        fadeInDuration: isFiniteNumber(pageDef.fade_in_dur) ? pageDef.fade_in_dur : defaults.fadeInDuration,
        fadeOutStart: isFiniteNumber(pageDef.fade_out_start) ? pageDef.fade_out_start : defaults.fadeOutStart,
        fadeOutDuration: isFiniteNumber(pageDef.fade_out_dur) ? pageDef.fade_out_dur : defaults.fadeOutDuration,
      })
    )
  }

  const leftover = lineRecords.filter((record, idx) => record !== null && !claimed.has(idx))
  for (const group of groupLinesIntoPages(leftover)) {
    pages.push(buildPage(group, synthesizedFades(group)))
  }

  placePages(pages)

  // Countdown bars. Authored timing (count_in + silences) is preferred as-is;
  // long instrumental gaps with no authored coverage get a synthesized bar so
  // the singer still sees a progress fill and a beat count-in before re-entry.
  const silences = []
  const authored = []

  const countIn = doc.count_in
  if (
    countIn &&
    typeof countIn === 'object' &&
    isFiniteNumber(countIn.start) &&
    isFiniteNumber(countIn.end) &&
    isFiniteNumber(countIn.step) &&
    isFiniteNumber(countIn.count) &&
    countIn.step > 0 &&
    countIn.count > 0 &&
    countIn.end > countIn.start
  ) {
    silences.push(silenceBar(countIn.start, countIn.end, countIn.step, countIn.count))
    authored.push({ start: countIn.start, end: countIn.end })
  }

  for (const entry of Array.isArray(doc.silences) ? doc.silences : []) {
    const bar = parseAuthoredSilence(entry)
    if (bar) {
      silences.push(bar)
      authored.push({ start: bar.start, end: bar.end })
    }
  }

  const beat = estimateBeatSec(pages)
  const covered = (a, b) => authored.some((s) => s.start < b && s.end > a)
  const timed = pages
    .map((page) => ({ page, first: pageFirstStart(page), last: pageLastEnd(page) }))
    .filter((p) => Number.isFinite(p.first) && Number.isFinite(p.last))
    .sort((a, b) => a.first - b.first)

  // Silent intro before the first page.
  if (timed.length > 0) {
    const introEnd = timed[0].first
    if (introEnd >= INSTRUMENTAL_INTRO_SEC && !covered(0, introEnd)) {
      silences.push(silenceBar(0, introEnd, beat, COUNT_IN_BEATS))
    }
  }

  // Instrumental breaks between pages. The bar appears as the previous page
  // fades out and counts down to the next page's first syllable.
  for (let i = 0; i + 1 < timed.length; i++) {
    const prev = timed[i]
    const next = timed[i + 1]
    if (next.first - prev.last < INSTRUMENTAL_GAP_SEC) continue
    const fadeOutStart = isFiniteNumber(prev.page.fadeOutStart) ? prev.page.fadeOutStart : prev.last
    const barStart = Math.max(prev.last, fadeOutStart)
    const barEnd = next.first
    if (barEnd - barStart < 1.0) continue
    if (covered(barStart, barEnd)) continue
    silences.push(silenceBar(barStart, barEnd, beat, COUNT_IN_BEATS))
  }

  let duration = 0
  for (const page of pages) {
    duration = Math.max(duration, Math.max(page.fadeOutStart, page.fadeInStart) + Math.max(page.fadeOutDuration, 0))
  }
  for (const bar of silences) {
    duration = Math.max(duration, bar.end)
  }

  return { duration, tracks: {}, pages, silences }
}
