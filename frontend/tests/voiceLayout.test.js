// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest'
import { normalizeWordSync } from '@/stage/adapter.mjs'
import { applyVoiceLayout, rosterIds, colorForVoiceId } from '@/utils/voiceLayout.js'
import { STAGE_HEIGHT } from '@/stage/frame.mjs'

// Build a document from a page spec. `lines` (default 1) sets how many lines a
// page carries — page height is what makes bands too small, so tests that only
// ever use one-line pages cannot see a whole class of layout bug.
function docFrom(spec, voiceIds = ['a', 'b']) {
  const lines = []
  const pages = spec.map((s, i) => {
    const line_idx = []
    for (let k = 0; k < (s.lines ?? 1); k++) {
      line_idx.push(lines.length)
      lines.push(
        s.blank
          ? [{ word: '   ', start: s.in + 0.3, end: s.in + 0.4 }]
          : [{ word: `w${i}_${k}`, start: s.in + 0.3 + k * 0.1, end: s.in + 0.4 + k * 0.1 }],
      )
    }
    return {
      line_idx,
      voice: s.voice,
      fade_in_start: s.in,
      fade_in_dur: 0.2,
      fade_out_start: s.out,
      fade_out_dur: 0.2,
    }
  })
  return { voices: voiceIds.map((id, i) => ({ id, name: `Voice ${i + 1}` })), lines, pages }
}

// Two voices trading pages, each voice's own pages overlapping the way an
// authored read-ahead crossfade does.
const DUET = [
  { voice: 'a', in: 0.5, out: 2.5 },
  { voice: 'b', in: 1.5, out: 3.5 },
  { voice: 'a', in: 2.5, out: 4.5 },
  { voice: 'b', in: 3.5, out: 5.5 },
]

const box = (page) => ({
  top: Math.min(...page.lines.map((l) => l.y)),
  bottom: Math.max(...page.lines.map((l) => l.y + l.height)),
})
const centerOf = (page) => (box(page).top + box(page).bottom) / 2
const visible = (page, t) =>
  page.fadeInStart <= t && t < Math.max(page.fadeOutStart, page.fadeInStart) + page.fadeOutDuration

function expectNoSimultaneousOverlap(model, until = 10) {
  for (let t = 0; t <= until; t += 0.05) {
    const boxes = model.pages.filter((p) => visible(p, t)).map(box)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlaps = boxes[i].top < boxes[j].bottom && boxes[j].top < boxes[i].bottom
        expect(overlaps, `pages overlap at t=${t.toFixed(2)}`).toBe(false)
      }
    }
  }
}

function expectOnStage(model) {
  for (const page of model.pages) {
    expect(box(page).top).toBeGreaterThanOrEqual(0)
    expect(box(page).bottom).toBeLessThanOrEqual(STAGE_HEIGHT)
  }
}

const laidOut = (doc) => applyVoiceLayout(normalizeWordSync(doc), doc)

describe('applyVoiceLayout — documents it must not touch', () => {
  it('leaves a document with no voices untouched', () => {
    const doc = docFrom(DUET)
    delete doc.voices
    doc.pages.forEach((p) => delete p.voice)
    expect(JSON.stringify(laidOut(doc))).toBe(JSON.stringify(normalizeWordSync(doc)))
  })

  it('leaves a single-voice document untouched', () => {
    const doc = docFrom(DUET.map((s) => ({ ...s, voice: 'a' })), ['a'])
    expect(JSON.stringify(laidOut(doc))).toBe(JSON.stringify(normalizeWordSync(doc)))
  })

  it('leaves a document untouched when only one voice actually sings', () => {
    const doc = docFrom(DUET.map((s) => ({ ...s, voice: 'a' })))  // roster still declares b
    expect(JSON.stringify(laidOut(doc))).toBe(JSON.stringify(normalizeWordSync(doc)))
  })

  it('leaves a page with an unknown voice where the adapter put it', () => {
    const doc = docFrom([...DUET, { voice: 'ghost', in: 6.0, out: 7.0 }])
    const model = laidOut(doc)
    expect(centerOf(model.pages[4])).toBeCloseTo(centerOf(normalizeWordSync(doc).pages[4]), 6)
  })
})

describe('applyVoiceLayout — band assignment', () => {
  it('gives each voice its own half when both need the same room', () => {
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 1.5 },
      { voice: 'b', in: 1.0, out: 2.0 },
    ])
    const model = laidOut(doc)
    expect(centerOf(model.pages[0])).toBeCloseTo(120, 6)
    expect(centerOf(model.pages[1])).toBeCloseTo(360, 6)
  })

  it('does not reserve a band for a declared voice that never sings', () => {
    const doc = docFrom(
      [{ voice: 'a', in: 0.5, out: 1.5 }, { voice: 'b', in: 1.0, out: 2.0 }],
      ['a', 'b', 'silent'],
    )
    const model = laidOut(doc)
    // Two singing voices split the stage in half; a third band would push
    // these to 80 and 240.
    expect(centerOf(model.pages[0])).toBeCloseTo(120, 6)
    expect(centerOf(model.pages[1])).toBeCloseTo(360, 6)
  })

  it('keeps each voice inside its own band', () => {
    const model = laidOut(docFrom(DUET))
    const half = STAGE_HEIGHT / 2
    ;[0, 2].forEach((i) => expect(box(model.pages[i]).bottom).toBeLessThanOrEqual(half))
    ;[1, 3].forEach((i) => expect(box(model.pages[i]).top).toBeGreaterThanOrEqual(half))
  })

  it('gives each voice its own active color', () => {
    const model = laidOut(docFrom(DUET))
    expect(model.pages[0].activeColor).toBe(model.pages[2].activeColor)
    expect(model.pages[1].activeColor).toBe(model.pages[3].activeColor)
    expect(model.pages[0].activeColor).not.toBe(model.pages[1].activeColor)
  })

  it('keeps colors distinct past the curated palette', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const doc = docFrom(ids.map((v, i) => ({ voice: v, in: i * 2 + 0.5, out: i * 2 + 1.5 })), ids)
    const colors = laidOut(doc).pages.map((p) => p.activeColor)
    expect(new Set(colors).size).toBe(ids.length)
  })
})

describe('applyVoiceLayout — no overlap', () => {
  it('never lets two pages on screen at once overlap vertically', () => {
    expectNoSimultaneousOverlap(laidOut(docFrom(DUET)))
  })

  it('handles multi-line pages that self-overlap', () => {
    // Two-line pages need 98px per row. Two rows per voice plus gaps is 404px
    // of the 480px stage — it fits, but an even half-stage split would give
    // each voice 240px and squash its rows together.
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 4.0, lines: 2 },
      { voice: 'a', in: 3.0, out: 6.5, lines: 2 },
      { voice: 'b', in: 1.5, out: 5.0, lines: 2 },
      { voice: 'b', in: 4.0, out: 7.5, lines: 2 },
    ])
    const model = laidOut(doc)
    expectNoSimultaneousOverlap(model)
    expectOnStage(model)
  })

  it('keeps three voices in disjoint bands when they fit', () => {
    const doc = docFrom(
      [
        { voice: 'a', in: 0.5, out: 3.0, lines: 2 },
        { voice: 'b', in: 1.0, out: 3.5, lines: 2 },
        { voice: 'c', in: 1.5, out: 4.0, lines: 2 },
      ],
      ['a', 'b', 'c'],
    )
    const model = laidOut(doc)
    expectNoSimultaneousOverlap(model)
    expectOnStage(model)
    const boxes = model.pages.map(box)
    expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[1].top)
    expect(boxes[1].bottom).toBeLessThanOrEqual(boxes[2].top)
  })

  it('still keeps everything on stage when the voices want more room than exists', () => {
    // Two voices, each with two simultaneous 3-line pages: 12 lines at once
    // needs 588px of a 480px stage. Separation is impossible at that point;
    // staying on screen is not.
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 4.0, lines: 3 },
      { voice: 'a', in: 3.0, out: 6.5, lines: 3 },
      { voice: 'b', in: 1.5, out: 5.0, lines: 3 },
      { voice: 'b', in: 4.0, out: 7.5, lines: 3 },
    ])
    expectOnStage(laidOut(doc))
  })

  it('never hides one page of a voice entirely behind another', () => {
    // Once a voice needs more height than its band, overlap is unavoidable and
    // staying on stage is the only hard guarantee. But a page whose block sits
    // entirely inside another's is not degraded, it is gone — so partial
    // overlap is the real floor, and it is the one the stage-bounds
    // assertions above cannot see.
    //
    // Two cases, because the two ways of getting this wrong fail on different
    // material. Equal rows (a): laying rows out from the band top pushes the
    // overflow past the bottom edge, where the clamp pins them flush and
    // stacks them exactly. Unequal rows (b): spacing centers evenly ignores
    // the heights, dropping a short row inside a tall neighbour's block.
    const cases = {
      // Three simultaneous 3-line pages per voice — 444px of need in the
      // 240px each compressed band gets.
      'equal rows': [
        { voice: 'a', in: 0.5, out: 6.0, lines: 3 },
        { voice: 'a', in: 0.7, out: 6.2, lines: 3 },
        { voice: 'a', in: 0.9, out: 6.4, lines: 3 },
        { voice: 'b', in: 1.1, out: 6.6, lines: 3 },
        { voice: 'b', in: 1.3, out: 6.8, lines: 3 },
        { voice: 'b', in: 1.5, out: 7.0, lines: 3 },
      ],
      // Barely over-subscribed (496px of 480) and lopsided: voice a's two
      // 1-line rows are dwarfed by its 4-line one.
      'unequal rows': [
        { voice: 'a', in: 0.5, out: 6.0, lines: 1 },
        { voice: 'a', in: 0.7, out: 6.2, lines: 1 },
        { voice: 'a', in: 0.9, out: 6.4, lines: 4 },
        { voice: 'b', in: 1.1, out: 6.6, lines: 4 },
      ],
    }

    for (const [name, spec] of Object.entries(cases)) {
      const model = laidOut(docFrom(spec))
      expectOnStage(model)
      const byVoice = new Map()
      spec.forEach((s, i) => byVoice.set(s.voice, [...(byVoice.get(s.voice) ?? []), i]))
      for (const pages of byVoice.values()) {
        const boxes = pages.map((i) => box(model.pages[i]))
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const [x, y] = [boxes[i], boxes[j]]
            const swallowed =
              (x.top >= y.top && x.bottom <= y.bottom) || (y.top >= x.top && y.bottom <= x.bottom)
            expect(swallowed, `${name}: pages ${pages[i]} and ${pages[j]} — one hides the other`)
              .toBe(false)
          }
        }
      }
    }
  })

  it('centers a voice in its band when it never overlaps itself', () => {
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 1.5 },
      { voice: 'b', in: 1.0, out: 2.0 },
      { voice: 'a', in: 2.0, out: 3.0 },
    ])
    const model = laidOut(doc)
    expect(centerOf(model.pages[0])).toBeCloseTo(centerOf(model.pages[2]), 6)
  })
})

describe('applyVoiceLayout — shared rows when bands cannot fit', () => {
  // Three voices, each with two 2-line pages overlapping themselves the way a
  // read-ahead crossfade does. Every voice needs two rows of 98px = 202px of
  // band, so bands want 606px of a 480px stage — but the three voices are never
  // all doubled up at the same instant, so at most four pages are ever on
  // screen together (t=6.6: a's second, both of b's, c's first) and shared rows
  // hold those in 410px at full size.
  const CROWDED = [
    { voice: 'a', in: 0.5, out: 4.0, lines: 2 },
    { voice: 'a', in: 3.0, out: 6.5, lines: 2 },
    { voice: 'b', in: 3.5, out: 7.0, lines: 2 },
    { voice: 'b', in: 6.0, out: 9.5, lines: 2 },
    { voice: 'c', in: 6.5, out: 10.0, lines: 2 },
    { voice: 'c', in: 9.0, out: 12.5, lines: 2 },
  ]

  it('stops the overlap that per-voice bands could not avoid', () => {
    const model = laidOut(docFrom(CROWDED, ['a', 'b', 'c']))
    expectNoSimultaneousOverlap(model, 14)
    expectOnStage(model)
  })

  it('keeps every voice its own color', () => {
    const model = laidOut(docFrom(CROWDED, ['a', 'b', 'c']))
    const colors = model.pages.map((p) => p.activeColor)
    expect(colors[0]).toBe(colors[1]) // both 'a' pages
    expect(colors[2]).toBe(colors[3]) // both 'b' pages
    expect(colors[4]).toBe(colors[5]) // both 'c' pages
    expect(new Set(colors).size).toBe(3)
  })

  it('does not shrink the text while whole-size rows still fit', () => {
    const model = laidOut(docFrom(CROWDED, ['a', 'b', 'c']))
    for (const page of model.pages) {
      for (const line of page.lines) expect(line.height).toBe(52)
    }
  })

  it('uses no more rows than the peak number of pages on screen at once', () => {
    const model = laidOut(docFrom(CROWDED, ['a', 'b', 'c']))
    // Four pages are on screen together at the busiest moment, so the layout
    // may occupy at most four distinct vertical slots.
    const centers = new Set(model.pages.map((p) => centerOf(p).toFixed(6)))
    expect(centers.size).toBeLessThanOrEqual(4)
  })

  it('shrinks the text, and only then, when even shared rows overflow', () => {
    // Six 2-line pages all on screen at once: 588px of blocks plus gaps against
    // a 480px stage. No arrangement fits at full size, so the blocks scale.
    const doc = docFrom(
      [
        { voice: 'a', in: 0.5, out: 8.0, lines: 2 },
        { voice: 'a', in: 1.0, out: 8.5, lines: 2 },
        { voice: 'b', in: 1.5, out: 9.0, lines: 2 },
        { voice: 'b', in: 2.0, out: 9.5, lines: 2 },
        { voice: 'c', in: 2.5, out: 10.0, lines: 2 },
        { voice: 'c', in: 3.0, out: 10.5, lines: 2 },
      ],
      ['a', 'b', 'c'],
    )
    const model = laidOut(doc)
    expectNoSimultaneousOverlap(model, 12)
    expectOnStage(model)
    for (const page of model.pages) {
      for (const line of page.lines) expect(line.height).toBeLessThan(52)
    }
  })

  // Three voices whose pages interleave so that two of the design's choices are
  // observable. Bands want 606px of a 480px stage and shrinking to fit them
  // would cost more than a tenth of the font, so this lands on shared rows at
  // full size: four rows, the busiest moment holding four pages.
  //
  // Row occupancy, in arrival order (row = the slot a page is packed into):
  //   a1 -> 0   b1 -> 1   a2 -> 2   b2 -> 1   c1 -> 0   b3 -> 2   c2 -> 3
  // b2 is the interesting one: when it arrives both row 0 and its own voice's
  // row 1 are free, and it takes its own.
  const INTERLEAVED = [
    { voice: 'a', in: 0.5, out: 3.0, lines: 2 },
    { voice: 'b', in: 1.0, out: 3.5, lines: 2 },
    { voice: 'a', in: 2.0, out: 4.5, lines: 2 },
    { voice: 'b', in: 4.0, out: 6.5, lines: 2 },
    { voice: 'c', in: 5.0, out: 7.5, lines: 2 },
    { voice: 'b', in: 5.5, out: 8.0, lines: 2 },
    { voice: 'c', in: 6.5, out: 9.0, lines: 2 },
  ]
  const [A1, B1, A2, B2, C1] = [0, 1, 2, 3, 4]

  it('keeps a part in the row it already uses when that row is free', () => {
    // b2 could take row 0, which is free and lower, or the row b1 used. Taking
    // its own is what "a part keeps its place where the timing allows" means,
    // and it is invisible in the row COUNT — both choices pack into four rows.
    const model = laidOut(docFrom(INTERLEAVED, ['a', 'b', 'c']))
    expect(centerOf(model.pages[B2])).toBeCloseTo(centerOf(model.pages[B1]), 6)
    expect(centerOf(model.pages[B2])).not.toBeCloseTo(centerOf(model.pages[A1]), 6)
    expectNoSimultaneousOverlap(model, 12)
  })

  it('stacks rows so the voices read down the stage in roster order', () => {
    // Rows can be stacked in any order without breaking the packing, so they
    // are grouped by the voice that uses each one most. Without that, this
    // document stacks as a, b, a, c — the first voice appearing twice with the
    // second between its two rows.
    const model = laidOut(docFrom(INTERLEAVED, ['a', 'b', 'c']))
    const roster = [...new Set([A1, B1, C1].map((i) => model.pages[i].activeColor))]

    // One entry per occupied row, top of the stage down, holding the roster
    // position of the voice that uses that row most.
    const rows = new Map()
    model.pages.forEach((page) => {
      const key = centerOf(page).toFixed(6)
      if (!rows.has(key)) rows.set(key, [])
      rows.get(key).push(roster.indexOf(page.activeColor))
    })
    const dominant = [...rows.entries()]
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([, voices]) =>
        voices
          .slice()
          .sort((m, n) => voices.filter((v) => v === m).length - voices.filter((v) => v === n).length || n - m)
          .pop(),
      )
    expect(dominant).toEqual([...dominant].sort((m, n) => m - n))
    expect(new Set(dominant).size).toBeGreaterThan(1) // the ordering had work to do
  })

  it('shrinks the bands instead of breaking them when barely over budget', () => {
    // Two voices wanting 496px of a 480px stage: 3% off the font keeps every
    // voice in one fixed place all song, which is worth more than the 3%.
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 4.0, lines: 2 },
      { voice: 'a', in: 3.0, out: 6.5, lines: 3 },
      { voice: 'b', in: 1.5, out: 5.0, lines: 3 },
      { voice: 'b', in: 4.0, out: 7.5, lines: 2 },
    ])
    const model = laidOut(doc)
    expectNoSimultaneousOverlap(model, 12)
    expectOnStage(model)
    // Still banded: each voice keeps its own half of the stage.
    const half = STAGE_HEIGHT / 2
    ;[0, 1].forEach((i) => expect(box(model.pages[i]).bottom).toBeLessThanOrEqual(half + 1e-6))
    ;[2, 3].forEach((i) => expect(box(model.pages[i]).top).toBeGreaterThanOrEqual(half - 1e-6))
    // ...at exactly the size that makes them fit, and no smaller. Four rows of
    // 98 + 144 + 144 + 98 = 484px of blocks, and the two inter-row gaps (one
    // per voice, 12px) do not scale because they are breathing room, not text:
    // (480 - 12) / 484 of the adapter's 52px line. Packing the same pages into
    // shared rows instead would need three gaps, not two, and shrink further —
    // which is how this pins the band path rather than merely a small font.
    const expected = 52 * ((STAGE_HEIGHT - 12) / 484)
    for (const page of model.pages) {
      for (const line of page.lines) expect(line.height).toBeCloseTo(expected, 6)
    }
  })

  it('leaves a fitting document on the band path untouched', () => {
    // The duet in DUET fits in bands, so it must still be placed by bands —
    // one voice per half — not packed into shared rows.
    const model = laidOut(docFrom(DUET))
    const half = STAGE_HEIGHT / 2
    ;[0, 2].forEach((i) => expect(box(model.pages[i]).bottom).toBeLessThanOrEqual(half))
    ;[1, 3].forEach((i) => expect(box(model.pages[i]).top).toBeGreaterThanOrEqual(half))
  })
})

describe('rosterIds', () => {
  it('dedups and keeps string ids only, in order', () => {
    expect(rosterIds({ voices: [{ id: 'a' }, { id: 'a' }, { id: 'b' }, {}, { id: 5 }] }))
      .toEqual(['a', 'b'])
  })

  it('returns [] for a doc with no voices', () => {
    expect(rosterIds({})).toEqual([])
    expect(rosterIds(null)).toEqual([])
  })
})

describe('colorForVoiceId', () => {
  it('keys a roster id to the stage color the layout stamps for its index', () => {
    // Voice 'b' is roster index 1; the DUET pages it sings are 1 and 3.
    const model = laidOut(docFrom(DUET))
    expect(colorForVoiceId('b', ['a', 'b']).activeColor).toBe(model.pages[1].activeColor)
    expect(colorForVoiceId('a', ['a', 'b']).activeColor).toBe(model.pages[0].activeColor)
  })

  it('gives distinct roster ids distinct colors', () => {
    expect(colorForVoiceId('a', ['a', 'b']).activeColor)
      .not.toBe(colorForVoiceId('b', ['a', 'b']).activeColor)
  })

  it('gives well-known lead/backing distinct colors without a roster', () => {
    expect(colorForVoiceId('lead', []).activeColor)
      .not.toBe(colorForVoiceId('backing', []).activeColor)
  })

  // A compound id is one stem file carrying several voices; it takes the color
  // of the first constituent the roster actually knows.
  it('colors a compound id as its first rostered constituent', () => {
    expect(colorForVoiceId('7+8', ['7', '8']).activeColor)
      .toBe(colorForVoiceId('7', ['7', '8']).activeColor)
  })

  it('skips constituents the roster does not know', () => {
    expect(colorForVoiceId('8+9', ['9']).activeColor)
      .toBe(colorForVoiceId('9', ['9']).activeColor)
  })

  it('falls back on the whole id when no constituent is rostered', () => {
    expect(colorForVoiceId('7+8', ['1', '2']).activeColor)
      .toBe(colorForVoiceId('7+8', []).activeColor)
  })

  it('leaves plain ids on exactly their old path', () => {
    expect(colorForVoiceId('lead', ['a', 'b']).activeColor)
      .toBe(colorForVoiceId('lead', []).activeColor)
    expect(colorForVoiceId('a', ['a', 'b']).activeColor)
      .not.toBe(colorForVoiceId('a', []).activeColor)
  })
})

describe('applyVoiceLayout — identifying which voice sings a page', () => {
  it('is not fooled by a dropped page sharing a fade-in time', () => {
    // Document page 0 has no usable words, so the adapter drops it. It shares
    // its fade-in with page 1, which belongs to the *other* voice — matching on
    // timing alone hands page 1 the dropped page's voice.
    const doc = docFrom([
      { voice: 'a', in: 1.0, out: 2.0, blank: true },
      { voice: 'b', in: 1.0, out: 2.0 },
      { voice: 'a', in: 3.0, out: 4.0 },
      { voice: 'b', in: 5.0, out: 6.0 },
    ])
    const model = laidOut(doc)
    expect(model.pages).toHaveLength(3)

    const half = STAGE_HEIGHT / 2
    expect(box(model.pages[0]).top).toBeGreaterThanOrEqual(half)     // voice b
    expect(box(model.pages[1]).bottom).toBeLessThanOrEqual(half)     // voice a
    expect(box(model.pages[2]).top).toBeGreaterThanOrEqual(half)     // voice b
  })

  it('leaves pages alone when two of them share a line', () => {
    const doc = docFrom([
      { voice: 'a', in: 0.5, out: 1.5 },
      { voice: 'b', in: 2.0, out: 3.0 },
      { voice: 'a', in: 4.0, out: 5.0 },
      { voice: 'b', in: 6.0, out: 7.0 },
    ])
    // Page 3 re-uses page 2's line: one line record, two pages, so its
    // geometry cannot be moved on behalf of either one.
    doc.pages[3].line_idx = [...doc.pages[2].line_idx]

    const baseline = normalizeWordSync(doc)
    const model = laidOut(doc)
    expect(centerOf(model.pages[2])).toBeCloseTo(centerOf(baseline.pages[2]), 6)
    expect(centerOf(model.pages[3])).toBeCloseTo(centerOf(baseline.pages[3]), 6)
    // The unshared pages are still laid out.
    expect(centerOf(model.pages[0])).not.toBeCloseTo(centerOf(baseline.pages[0]), 6)
  })
})
