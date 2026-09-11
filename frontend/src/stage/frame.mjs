// SPDX-License-Identifier: AGPL-3.0-only
// Core per-frame stage state for the karaoke stage renderer.
//
// Pure timing/visibility computation: given a normalized stage model, a
// playback time in seconds, and a viewport, produce a FrameDescriptor that
// says what would be drawn. No canvas, no DOM — the drawing layer consumes
// this same descriptor so tests and pixels can never disagree.

export const STAGE_WIDTH = 640
export const STAGE_HEIGHT = 480

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

// Virtual 640x480 stage mapped into the viewport, aspect preserved, centered.
export function computeStageTransform(viewport) {
  const scale = Math.min(viewport.width / STAGE_WIDTH, viewport.height / STAGE_HEIGHT)
  return {
    scale,
    offsetX: (viewport.width - STAGE_WIDTH * scale) / 2,
    offsetY: (viewport.height - STAGE_HEIGHT * scale) / 2,
  }
}

// A syllable is invalid if `text` is missing, not a string, or the empty
// string, or if `start`/`end` is not a finite number. Whitespace-only text
// is valid. Invalid syllables contribute no glyphs and no timing.
export function isValidSyllable(syllable) {
  return (
    syllable !== null &&
    typeof syllable === 'object' &&
    typeof syllable.text === 'string' &&
    syllable.text !== '' &&
    isFiniteNumber(syllable.start) &&
    isFiniteNumber(syllable.end)
  )
}

// The line's valid syllables flattened across words in order. Words with an
// empty (or entirely invalid) syllable array simply contribute nothing.
export function validSyllables(line) {
  const out = []
  const words = line && Array.isArray(line.words) ? line.words : []
  for (const word of words) {
    if (!Array.isArray(word)) continue
    for (const syllable of word) {
      if (isValidSyllable(syllable)) out.push(syllable)
    }
  }
  return out
}

function completedState(index, total) {
  return index === total - 1 ? { kind: 'full' } : { kind: 'boundary', syllable: index }
}

// Reveal state over the flattened valid syllables using half-open intervals:
// a syllable is active on [start, end); at t = end it is completed (boundary
// through it, or full if last). Instant syllables (end <= start) complete the
// moment t reaches start. A later syllable's state supersedes an earlier one.
export function computeReveal(syllables, time) {
  const total = syllables.length
  if (total === 0) return { kind: 'none' }
  let reveal = { kind: 'none' }
  for (let i = 0; i < total; i++) {
    const s = syllables[i]
    if (s.end <= s.start) {
      if (time >= s.start) reveal = completedState(i, total)
    } else if (time >= s.end) {
      reveal = completedState(i, total)
    } else if (time >= s.start) {
      reveal = { kind: 'partial', syllable: i, fraction: (time - s.start) / (s.end - s.start) }
    }
  }
  return reveal
}

// Lead-in indicator: shown on [leadIn.start, firstSyllableStart), never when
// the line has no valid syllables or the lead-in would start at/after the
// first syllable.
export function computeLeadIn(line, syllables, time) {
  const leadIn = line && line.leadIn
  if (!leadIn || typeof leadIn !== 'object' || !isFiniteNumber(leadIn.start)) return null
  if (syllables.length === 0) return null
  const firstStart = syllables[0].start
  if (leadIn.start >= firstStart) return null
  if (time < leadIn.start || time >= firstStart) return null
  return { progress: clamp01((time - leadIn.start) / (firstStart - leadIn.start)) }
}

// Page visibility and opacity. Malformed pages (fadeOutStart < fadeInStart)
// clamp the effective fade-out start up to fadeInStart. Returns null when the
// page is hidden (outside [fadeInStart, effectiveOutStart + max(outDur, 0))).
export function computePageOpacity(page, time) {
  const inStart = isFiniteNumber(page.fadeInStart) ? page.fadeInStart : 0
  const inDuration = isFiniteNumber(page.fadeInDuration) ? page.fadeInDuration : 0
  const rawOutStart = isFiniteNumber(page.fadeOutStart) ? page.fadeOutStart : inStart
  const outDuration = isFiniteNumber(page.fadeOutDuration) ? page.fadeOutDuration : 0
  const outStart = Math.max(rawOutStart, inStart)
  const hideAt = outStart + Math.max(outDuration, 0)
  if (!(time >= inStart && time < hideAt)) return null
  const fadeInRamp = inDuration > 0 ? (time - inStart) / inDuration : 1
  const fadeOutRamp = time < outStart ? 1 : outDuration > 0 ? 1 - (time - outStart) / outDuration : 0
  return clamp01(Math.min(fadeInRamp, fadeOutRamp))
}

// Countdown bars. Bars with step <= 0, count <= 0, or end <= start are
// ignored entirely. Visible on [start, end); opacity is the minimum of the
// fade-in ramp (first `step` seconds) and fade-out ramp (final `step`
// seconds), clamped. The numeral appears only inside the final count * step
// window (clamped to the bar start).
export function describeCountdowns(silences, time) {
  const out = []
  const bars = Array.isArray(silences) ? silences : []
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]
    if (!bar || typeof bar !== 'object') continue
    const { start, end, step, count } = bar
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue
    if (!isFiniteNumber(step) || !isFiniteNumber(count)) continue
    if (step <= 0 || count <= 0 || end <= start) continue
    if (time < start || time >= end) continue

    const opacity = clamp01(Math.min((time - start) / step, (end - time) / step, 1))
    const fill = clamp01((time - start) / (end - start))
    const windowStart = Math.max(start, end - count * step)
    let numeral = null
    if (time >= windowStart) {
      numeral = Math.ceil((end - time) / step)
      if (numeral < 1) numeral = 1
      if (numeral > count) numeral = count
    }
    out.push({ index, opacity, fill, segments: count, numeral })
  }
  return out
}

// Full frame descriptor. `singStart`/`singEnd` and `mode`/`availableModes`
// are advisory metadata and deliberately never read here.
export function describeFrame(model, time, viewport) {
  const m = model && typeof model === 'object' ? model : {}
  const t = time
  const pages = []
  const modelPages = Array.isArray(m.pages) ? m.pages : []
  for (let index = 0; index < modelPages.length; index++) {
    const page = modelPages[index]
    if (!page || typeof page !== 'object') continue
    const opacity = computePageOpacity(page, t)
    if (opacity === null) continue
    const pageLines = Array.isArray(page.lines) ? page.lines : []
    const lines = pageLines.map((line, lineIndex) => {
      const syllables = validSyllables(line)
      return {
        index: lineIndex,
        reveal: computeReveal(syllables, t),
        leadIn: computeLeadIn(line, syllables, t),
      }
    })
    pages.push({ index, opacity, lines })
  }
  return {
    stageTransform: computeStageTransform(viewport),
    pages,
    countdowns: describeCountdowns(m.silences, t),
  }
}
