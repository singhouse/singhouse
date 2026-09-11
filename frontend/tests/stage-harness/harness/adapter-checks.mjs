// SPDX-License-Identifier: AGPL-3.0-only
// Structural checks for the word-sync adapter (normalizeWordSync).
//
// Unlike the golden frames, adapter output layout is product behavior the spec
// allows to be tuned (page grouping heuristics, synthesized positions), so
// these checks assert contract-stable properties only:
//   - syllable text/timing survives normalization exactly;
//   - fillers are discarded; v1 words become single syllables;
//   - explicit v2 page/fade/count-in/lead-in data is honored;
//   - synthesized geometry stays inside the 640x480 virtual stage.

const STAGE_W = 640
const STAGE_H = 480

function flattenSyllables(model) {
  const out = []
  for (const page of model.pages || []) {
    for (const line of page.lines || []) {
      for (const word of line.words || []) {
        for (const syl of word) out.push(syl)
      }
    }
  }
  return out
}

function flattenLines(model) {
  const out = []
  for (const page of model.pages || []) {
    for (const line of page.lines || []) out.push(line)
  }
  return out
}

function approx(a, b) {
  return typeof a === 'number' && Math.abs(a - b) <= 1e-6
}

function checkBounds(model, errors) {
  for (const line of flattenLines(model)) {
    if (!(line.x >= 0 && line.x + line.width <= STAGE_W)) {
      errors.push(`line horizontal box out of stage bounds: x=${line.x} width=${line.width}`)
    }
    if (!(line.y >= 0 && line.y + line.height <= STAGE_H)) {
      errors.push(`line vertical box out of stage bounds: y=${line.y} height=${line.height}`)
    }
  }
  for (const bar of model.silences || []) {
    if (!(bar.x >= 0 && bar.x + bar.width <= STAGE_W && bar.y >= 0 && bar.y + bar.height <= STAGE_H)) {
      errors.push(`countdown bar out of stage bounds`)
    }
  }
}

function expectSyllableSequence(model, expected, errors) {
  const syls = flattenSyllables(model)
  if (syls.length !== expected.length) {
    errors.push(`expected ${expected.length} syllables, got ${syls.length}: [${syls.map((s) => s.text).join(', ')}]`)
    return
  }
  expected.forEach((e, i) => {
    const s = syls[i]
    if (s.text !== e.text || !approx(s.start, e.start) || !approx(s.end, e.end)) {
      errors.push(
        `syllable ${i}: expected {${e.text} ${e.start}-${e.end}}, got {${s.text} ${s.start}-${s.end}}`
      )
    }
  })
}

function checkV2Paged(model, errors) {
  if (!model || !Array.isArray(model.pages)) {
    errors.push('normalizeWordSync returned no pages array')
    return
  }
  if (model.pages.length !== 1) {
    errors.push(`expected 1 page from explicit page data, got ${model.pages.length}`)
    return
  }
  const page = model.pages[0]
  if ((page.lines || []).length !== 2) {
    errors.push(`expected 2 lines on the page, got ${(page.lines || []).length}`)
  }

  expectSyllableSequence(model, [
    { text: 'Ma', start: 10.0, end: 10.4 },
    { text: 'ple', start: 10.4, end: 10.8 },
    { text: 'en', start: 11.0, end: 11.4 },
    { text: 'gines', start: 11.4, end: 11.9 },
    { text: 'hum', start: 13.0, end: 13.5 },
  ], errors)

  if (!approx(page.fadeInStart, 8.0)) errors.push(`fadeInStart: expected 8.0, got ${page.fadeInStart}`)
  if (!approx(page.fadeInDuration, 0.4)) errors.push(`fadeInDuration: expected 0.4, got ${page.fadeInDuration}`)
  if (!approx(page.fadeOutStart, 14.0)) errors.push(`fadeOutStart: expected 14.0, got ${page.fadeOutStart}`)
  if (!approx(page.fadeOutDuration, 0.4)) errors.push(`fadeOutDuration: expected 0.4, got ${page.fadeOutDuration}`)

  const silences = model.silences || []
  if (silences.length !== 1) {
    errors.push(`expected count_in to become 1 countdown bar, got ${silences.length}`)
  } else {
    const bar = silences[0]
    if (!approx(bar.start, 2.0) || !approx(bar.end, 9.0) || !approx(bar.step, 1.0) || bar.count !== 4) {
      errors.push(`count_in mapping wrong: got start=${bar.start} end=${bar.end} step=${bar.step} count=${bar.count}`)
    }
  }

  const line0 = page.lines && page.lines[0]
  const line1 = page.lines && page.lines[1]
  if (!line0 || !line0.leadIn || !approx(line0.leadIn.start, 8.0)) {
    errors.push(`lead_ins[0] (line 0, start 8.0) not honored: got ${JSON.stringify(line0 && line0.leadIn)}`)
  }
  if (line1 && line1.leadIn) {
    errors.push(`line 1 has an unexpected leadIn: ${JSON.stringify(line1.leadIn)}`)
  }

  checkBounds(model, errors)
}

function checkV1Lines(model, errors) {
  expectSyllableSequence(model, [
    { text: 'Paper', start: 5.0, end: 5.6 },
    { text: 'rivers', start: 5.8, end: 6.4 },
    { text: 'fold', start: 9.5, end: 10.0 },
  ], errors)

  // Each v1 word must be a single-syllable word spanning the word's own time.
  for (const line of flattenLines(model)) {
    for (const word of line.words || []) {
      if (word.length !== 1) {
        errors.push(`v1 word became ${word.length} syllables: ${JSON.stringify(word)}`)
      }
    }
  }

  checkBounds(model, errors)
}

function checkV1Segments(model, errors) {
  // 12 input tokens, 1 empty filler -> 11 words, order and timing preserved.
  expectSyllableSequence(model, [
    { text: 'Gravel', start: 20.0, end: 20.4 },
    { text: 'moons', start: 20.5, end: 20.9 },
    { text: 'tumble', start: 21.0, end: 21.4 },
    { text: 'past', start: 21.5, end: 21.9 },
    { text: 'the', start: 22.0, end: 22.2 },
    { text: 'lighthouse', start: 22.3, end: 22.9 },
    { text: 'gate', start: 23.0, end: 23.4 },
    { text: 'ember', start: 27.0, end: 27.4 },
    { text: 'trains', start: 27.5, end: 27.9 },
    { text: 'whistle', start: 28.0, end: 28.4 },
    { text: 'home', start: 28.5, end: 29.0 },
  ], errors)

  const lines = flattenLines(model)
  if (lines.length < 2) {
    errors.push(`expected the >3s gap to break lines/pages: got ${lines.length} line(s)`)
  }
  for (const line of lines) {
    const wordCount = (line.words || []).filter((w) => w.length > 0).length
    if (wordCount < 1 || wordCount > 12) {
      errors.push(`line has implausible word count ${wordCount}`)
    }
  }
  if (!model.pages.length) {
    errors.push('no pages were synthesized')
  }
  for (const page of model.pages) {
    if (!(page.lines || []).length) {
      errors.push('a synthesized page has no lines')
      continue
    }
    const syls = []
    for (const line of page.lines) for (const w of line.words || []) syls.push(...w)
    if (!syls.length) continue
    const first = Math.min(...syls.map((s) => s.start))
    const last = Math.max(...syls.map((s) => s.end))
    if (!(page.fadeInStart <= first)) {
      errors.push(`page fade-in (${page.fadeInStart}) starts after its first syllable (${first})`)
    }
    if (!(page.fadeOutStart >= last)) {
      errors.push(`page fade-out (${page.fadeOutStart}) starts before its last syllable ends (${last})`)
    }
  }

  checkBounds(model, errors)
}

const CHECKS = {
  'v2-paged.json': checkV2Paged,
  'v1-lines.json': checkV1Lines,
  'v1-segments.json': checkV1Segments,
}

export function runAdapterChecks(normalizeWordSync, fixtureDir, loadJson) {
  const results = []
  for (const [name, check] of Object.entries(CHECKS)) {
    const errors = []
    let model = null
    try {
      model = normalizeWordSync(loadJson(`${fixtureDir}/${name}`))
    } catch (err) {
      errors.push(`normalizeWordSync threw: ${err && err.stack || err}`)
    }
    if (model !== null) {
      try {
        check(model, errors)
      } catch (err) {
        errors.push(`check crashed: ${err && err.stack || err}`)
      }
    }
    results.push({ name, errors, checks: errors.length ? 0 : 1 })
  }
  return results
}
