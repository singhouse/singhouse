// SPDX-License-Identifier: AGPL-3.0-only
// Structural validation for canonical editor docs (see model.js).
//
// One source of truth for "what is a well-formed word_sync doc". Used three
// ways: as the oracle in tests (any op sequence must leave a doc error-free),
// as live lint badges in the editor UI, and as a pre-save gate so a buggy
// editor build can't write a corrupt doc into the DB.
//
// Errors are structural facts that break rendering or later editing.
// Warnings are suspicious-but-renderable (overlaps happen in real duets;
// zero-duration words render as instant wipes).

const EPS = 1e-3

function issue(code, path, message) {
  return { code, path, message }
}

export function validateDoc(doc) {
  const errors = []
  const warnings = []

  if (!doc || !Array.isArray(doc.lines) || !doc.lines.length) {
    errors.push(issue('no-lines', 'lines', 'doc has no lines'))
    return { errors, warnings, ok: false }
  }

  let prevWord = null
  doc.lines.forEach((line, li) => {
    if (!Array.isArray(line) || !line.length) {
      errors.push(issue('empty-line', `lines[${li}]`, 'line has no words'))
      return
    }
    line.forEach((w, wi) => {
      const path = `lines[${li}][${wi}]`
      if (typeof w.text !== 'string' || !w.text.trim()) {
        errors.push(issue('empty-word', path, 'word has no text'))
      }
      if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) {
        errors.push(issue('bad-time', path, `non-finite timing (${w.start}..${w.end})`))
        return
      }
      if (w.start < 0) {
        errors.push(issue('negative-time', path, `start ${w.start} < 0`))
      }
      if (w.end < w.start - EPS) {
        errors.push(issue('negative-duration', path, `end ${w.end} < start ${w.start}`))
      } else if (w.end - w.start < EPS) {
        warnings.push(issue('zero-duration', path, 'word has ~zero duration'))
      }
      if (prevWord && Number.isFinite(prevWord.end)) {
        if (w.start < prevWord.start - EPS) {
          // Out of order vs the previous word in doc order. Warning, not
          // error: word order is authored by the lyric text (array order),
          // timing regressions are a quality problem the user may be mid-way
          // through fixing — and across lines real songs overlap anyway
          // (duets, backing vocals).
          warnings.push(
            issue(
              prevWord.li === li ? 'out-of-order' : 'line-overlap',
              path,
              `starts at ${w.start.toFixed(2)} before previous word at ${prevWord.start.toFixed(2)}`,
            ),
          )
        } else if (prevWord.li === li && w.start < prevWord.end - EPS) {
          warnings.push(issue('word-overlap', path, 'overlaps previous word'))
        }
      }
      prevWord = { start: w.start, end: w.end, li }

      if (w.syl) {
        if (!Array.isArray(w.syl) || !w.syl.length) {
          errors.push(issue('bad-syl', path, 'syl present but empty'))
        } else {
          let sPrev = null
          w.syl.forEach((s, si) => {
            const sPath = `${path}.syl[${si}]`
            if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) {
              errors.push(issue('bad-time', sPath, 'non-finite syllable timing'))
              return
            }
            if (s.start < w.start - EPS || s.end > w.end + EPS) {
              warnings.push(issue('syl-outside-word', sPath, 'syllable timing outside word bounds'))
            }
            if (sPrev !== null && s.start < sPrev - EPS) {
              errors.push(issue('syl-out-of-order', sPath, 'syllables out of order'))
            }
            sPrev = s.start
          })
          const joined = w.syl.map((s) => s.text).join('')
          if (joined.replace(/\s+/g, '') !== String(w.text).replace(/\s+/g, '')) {
            warnings.push(issue('syl-text-mismatch', path, `syl text "${joined}" != word "${w.text}"`))
          }
        }
      }
    })
  })

  const nLines = doc.lines.length
  if (doc.pages) {
    const seen = new Map() // lineIdx -> pageIdx
    doc.pages.forEach((p, pi) => {
      const path = `pages[${pi}]`
      if (!Array.isArray(p.line_idx) || !p.line_idx.length) {
        errors.push(issue('empty-page', path, 'page references no lines'))
        return
      }
      p.line_idx.forEach((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= nLines) {
          errors.push(issue('dangling-page-ref', path, `references line ${i} (doc has ${nLines})`))
        } else if (seen.has(i)) {
          errors.push(issue('duplicate-page-ref', path, `line ${i} already in pages[${seen.get(i)}]`))
        } else {
          seen.set(i, pi)
        }
      })
    })
    for (let i = 0; i < nLines; i++) {
      if (!seen.has(i)) {
        warnings.push(issue('unpaged-line', `lines[${i}]`, 'line not referenced by any page'))
      }
    }
  }

  if (doc.lead_ins) {
    doc.lead_ins.forEach((l, i) => {
      const path = `lead_ins[${i}]`
      if (!Number.isInteger(l.line_idx) || l.line_idx < 0 || l.line_idx >= nLines) {
        errors.push(issue('dangling-lead-in', path, `references line ${l.line_idx}`))
      }
      if (!Number.isFinite(l.start)) {
        errors.push(issue('bad-time', path, 'non-finite lead-in start'))
      }
    })
  }

  return { errors, warnings, ok: errors.length === 0 }
}
