// SPDX-License-Identifier: AGPL-3.0-only
// Text layout geometry for lyric lines.
//
// Measurement is injected (`measure(text) -> width in virtual px`) so the
// same code runs against a real canvas 2D context and against deterministic
// fakes in unit tests. All output coordinates are virtual-stage coordinates.
//
// The syllable runs produced here use the same valid-syllable flattening as
// the frame descriptor, so a reveal state's `syllable` index addresses
// `runs[index]` directly.

import { STAGE_WIDTH, isValidSyllable, isFiniteNumber, clamp01 } from './frame.mjs'

// Horizontal breathing room kept when scaling down overlong unfitted lines.
const STAGE_EDGE_MARGIN = 8

export function lineFontPx(line) {
  const height = isFiniteNumber(line && line.height) ? line.height : 40
  return Math.round(height * 0.7)
}

export function lineFont(line) {
  return `bold ${lineFontPx(line)}px sans-serif`
}

// Lay out one line: per-syllable x-advances (unscaled), with a measured
// space between adjacent rendered words. Returns:
//   startX      left edge of the rendered run, in stage coordinates
//   scaleX      horizontal glyph scale applied to the run
//   natural     unscaled measured width of the run
//   rendered    natural * scaleX
//   runs        [{ text, x0, x1 }] indexed like the valid-syllable flattening
//   spaceWidth  measured width of one inter-word space
export function layoutLine(line, measure) {
  const spaceWidth = measure(' ')
  const runs = []
  let advance = 0
  let firstWord = true
  const words = line && Array.isArray(line.words) ? line.words : []
  for (const word of words) {
    if (!Array.isArray(word)) continue
    const valid = word.filter(isValidSyllable)
    if (valid.length === 0) continue // ignored word: no glyphs, no space
    if (!firstWord) advance += spaceWidth
    firstWord = false
    for (const syllable of valid) {
      const width = measure(syllable.text)
      runs.push({ text: syllable.text, x0: advance, x1: advance + width })
      advance += width
    }
  }
  const natural = advance

  let scaleX = 1
  const boxWidth = isFiniteNumber(line && line.width) && line.width > 0 ? line.width : STAGE_WIDTH
  if (line && line.fit === 'scale-x') {
    if (natural > 0) scaleX = boxWidth / natural
  } else {
    // fit 'none' / omitted: natural width, but scale down exceptionally long
    // runs so they never overflow the virtual stage.
    const available = STAGE_WIDTH - 2 * STAGE_EDGE_MARGIN
    if (natural > available) scaleX = available / natural
  }
  const rendered = natural * scaleX

  const startX =
    line && line.align === 'center'
      ? (STAGE_WIDTH - rendered) / 2
      : isFiniteNumber(line && line.x)
        ? line.x
        : 0

  return { startX, scaleX, natural, rendered, runs, spaceWidth }
}

// The x position of the active-wipe reveal edge for a reveal state, in stage
// coordinates. A boundary reveal ends at the completed syllable's right edge
// (the following space is not yet active); a partial reveal at fraction 0 sits
// at the active syllable's left edge (any preceding space is now behind the
// edge). That gives the space-activation rule its timing half for free:
// a space can never become active before the preceding syllable completes.
export function revealEdgeX(layout, reveal) {
  if (!reveal || reveal.kind === 'none') return layout.startX
  if (reveal.kind === 'full') return layout.startX + layout.rendered
  const run = layout.runs[reveal.syllable]
  if (!run) return layout.startX
  if (reveal.kind === 'boundary') return layout.startX + run.x1 * layout.scaleX
  const fraction = clamp01(reveal.fraction)
  return layout.startX + (run.x0 + (run.x1 - run.x0) * fraction) * layout.scaleX
}
