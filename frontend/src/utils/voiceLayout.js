// SPDX-License-Identifier: AGPL-3.0-only
// Voice-aware stage layout.
//
// A multi-voice word-sync document declares a `voices` roster and tags each
// page with the voice that sings it. The stage adapter places pages from
// timing alone — it has no concept of who is singing — so two parts that
// overlap in time can be handed the same position and collide on screen. This
// pass runs after normalizeWordSync and gives each voice its own horizontal
// band, so a part always appears in the same place and in its own color.
//
// Producer-agnostic: anything emitting `voices` + `pages[].voice` gets this
// treatment — imported files, generated tracks, hand-edited ones alike.
// Documents with fewer than two singing voices are returned untouched, so solo
// tracks render exactly as they did before.
//
// Within a band a voice's own consecutive pages still overlap in time — that
// overlap is the read-ahead crossfade, not a defect — so each band is split
// into as many rows as that voice needs and pages are packed into them by
// interval partitioning. Bands are then sized to the height each voice
// actually needs rather than by dividing the stage evenly: an even split hands
// a demanding voice less room than its pages occupy, and the per-page clamp
// then pulls its rows back on top of each other.
//
// Bands only work while they fit. Each voice's reservation is its own worst
// case — two rows deep, because of that crossfade — held for the whole song
// whether or not anyone else is singing, so three voices of two-line pages
// reserve more than the stage has while never putting more than about 410px of
// it to use at once. Past that point the voices share rows instead (see
// placeInSharedRows): rows are interval-partitioned across every voice at once,
// so the row count is the peak number of pages actually on screen together
// rather than the sum of what each voice might need. Colour still identifies
// the singer; what a shared-row stage gives up is the fixed position, which no
// layout could have kept at that density anyway.
//
// Placement is a translation, not a re-layout: a page keeps the line heights,
// pitch and horizontal geometry the adapter gave it, and the whole block
// slides to its row center. This pass only decides *where* a page sits, never
// how it is built — with one exception, the last-resort scaling below, which
// shrinks a block's line heights and with them its font (layout.mjs derives
// the font size from line.height). Horizontal geometry is never touched.

import { STAGE_HEIGHT, isFiniteNumber } from '@/stage/frame.mjs'
import { ACTIVE_COLOR, ACTIVE_BORDER } from '@/stage/colors.mjs'

// Per-voice active colors, applied by roster position. The first voice keeps
// the default stage coral so a duet reads as "normal, plus a second part"
// rather than two unfamiliar colors. Chosen for legibility on the dark stage
// rather than to match any source document's own palette.
const VOICE_COLORS = [
  { activeColor: ACTIVE_COLOR, activeBorder: ACTIVE_BORDER },
  { activeColor: '#ffdd66', activeBorder: '#332200' },
  { activeColor: '#ff9ad5', activeBorder: '#3a0526' },
  { activeColor: '#9df0a8', activeBorder: '#0a3312' },
]

// Two pages that merely touch (one ends exactly as the next appears) can share
// a row; floating-point fade arithmetic needs the slack.
const TOUCH_EPSILON = 1e-6

// Breathing room between rows inside a band, so stacked pages don't abut.
const ROW_GAP = 6

// How far the text may be shrunk to keep a document on the band layout, where
// every voice holds one fixed place all song. A tenth off the font is a price
// worth paying for that; much more is not, and those documents are better
// served at full size on shared rows.
const BAND_SHRINK_FLOOR = 0.9

// The floor on shrinking generally. Past it the text is too small to sing from,
// so an over-subscribed stage stops shrinking and accepts the overlap it cannot
// avoid: unreadably small is no better than overlapping, and invisible — which
// is where unbounded scaling ends up, at zero — is worse than both.
const MIN_BLOCK_SCALE = 0.4

// Past the curated palette, walk the hue circle by the golden angle so any
// number of voices stay distinguishable from each other.
function colorFor(index) {
  if (index < VOICE_COLORS.length) return VOICE_COLORS[index]
  const hue = Math.round((index * 137.508) % 360)
  return { activeColor: `hsl(${hue} 85% 70%)`, activeBorder: `hsl(${hue} 60% 12%)` }
}

// The ordered, de-duplicated voice ids of a word-sync doc — the same roster the
// stage colors pages by, exposed so the mixer can key a lane's color to its
// on-stage voice. Mirrors the (previously inline) logic in applyVoiceLayout.
export function rosterIds(doc) {
  const ids = []
  for (const voice of Array.isArray(doc?.voices) ? doc.voices : []) {
    const id = voice && typeof voice.id === 'string' ? voice.id : null
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// Well-known unnamed stems (no roster) still get stable, distinct colors so a
// standard lead/backing pair doesn't collapse to one hue: lead→slot 0 (stage
// coral), backing→slot 1 (amber) — matching the first two roster colors.
const WELL_KNOWN_COLOR_INDEX = { lead: 0, backing: 1 }

function stableIndexFor(key) {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  // Land past the curated palette so it uses the golden-angle regime and stays
  // distinct from the well-known slots.
  return VOICE_COLORS.length + (h % 251)
}

// The palette entry for a voice id, shared with the on-stage voice of the same
// id. When the id is in the roster, its color is the roster-index color the
// stage uses (colorFor(index)); otherwise a well-known/stable fallback.
//
// A compound id ('7+8') is one stem file carrying several voices at once. It
// takes the color of the first of its constituents that is on the roster: a
// lane has one color and those voices have several, so the tie has to go
// somewhere, and the first-named one keeps the lane recognizable against the
// stage. An accepted limit of combined stems, not a defect to route around.
export function colorForVoiceId(id, ids) {
  const roster = Array.isArray(ids) ? ids : []
  const key = String(id)
  const indexOf = (k) => roster.findIndex((x) => String(x) === k)

  let i = indexOf(key)
  if (i < 0 && key.includes('+')) {
    // Well-formed compounds only (every part non-empty) — a degenerate id
    // like '7+' is not a compound and keeps its own fallback color, matching
    // the backend's parsing rule.
    const parts = key.split('+')
    if (parts.every((p) => p !== '')) {
      for (const part of parts) {
        const found = indexOf(part)
        if (found >= 0) { i = found; break }
      }
    }
  }
  if (i < 0) i = WELL_KNOWN_COLOR_INDEX[key] ?? stableIndexFor(key)
  return colorFor(i)
}

// The window a page is actually on screen, matching the renderer's own
// visibility rule: present on [fadeInStart, fadeOutStart + fadeOutDuration),
// with a malformed fade-out clamped up to the fade-in.
function visibleWindow(page) {
  // Substitute for non-finite fades exactly as computePageOpacity does. The
  // adapter always emits finite ones, so this is unreachable through the app —
  // but a NaN end would poison a row for the rest of the song (nothing is ever
  // free after it), inflating the row count and dragging a whole document into
  // the shrink path, so the guard is worth its two lines.
  const start = isFiniteNumber(page.fadeInStart) ? page.fadeInStart : 0
  const rawOut = isFiniteNumber(page.fadeOutStart) ? page.fadeOutStart : start
  const outDuration = isFiniteNumber(page.fadeOutDuration) ? page.fadeOutDuration : 0
  return { start, end: Math.max(rawOut, start) + Math.max(outDuration, 0) }
}

// Identity of a line, as the first syllable the adapter would keep from it.
// Model pages carry no back-reference to the document, and index alignment is
// not safe — the adapter drops lines and pages that end up empty and appends
// its own pages for unclaimed lines. Content identity survives all of that.
function docLineKey(tokens) {
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token || typeof token !== 'object') continue
    if (Array.isArray(token.syl) && token.syl.length > 0) {
      const first = token.syl.find(
        (s) => s && typeof s.text === 'string' && s.text !== ''
          && isFiniteNumber(s.start) && isFiniteNumber(s.end),
      )
      if (first) return `${first.start.toFixed(6)}|${first.text}`
      continue
    }
    const text = typeof token.word === 'string'
      ? token.word
      : typeof token.text === 'string' ? token.text : ''
    if (text.trim() === '') continue
    if (!isFiniteNumber(token.start) || !isFiniteNumber(token.end)) continue
    return `${token.start.toFixed(6)}|${text}`
  }
  return null
}

function modelPageKey(page) {
  const first = page?.lines?.[0]?.words?.[0]?.[0]
  if (!first || typeof first.text !== 'string' || !isFiniteNumber(first.start)) return null
  return `${first.start.toFixed(6)}|${first.text}`
}

// Which voice sings each model page, or null where it can't be established.
//
// Matching is positional, not by content: voices singing in unison produce
// pages with identical words at identical times, so content alone cannot tell
// them apart. The adapter emits one page per source page that keeps at least
// one usable line, in order, then appends its own pages for unclaimed lines —
// so predicting which source pages survive reproduces the alignment exactly.
// Each match is then checked against the page's actual first line, and any
// disagreement abandons the whole mapping: leaving pages unvoiced costs the
// feature, while a mis-alignment would put one singer's words in another's
// band.
function voicePerPage(model, doc) {
  const survivors = []
  for (const pageDef of Array.isArray(doc?.pages) ? doc.pages : []) {
    if (!pageDef || typeof pageDef !== 'object' || !Array.isArray(pageDef.line_idx)) continue
    let key = null
    for (const idx of pageDef.line_idx) {
      if (!Number.isInteger(idx)) continue
      const candidate = docLineKey(doc?.lines?.[idx])
      if (candidate !== null) {
        key = candidate
        break
      }
    }
    if (key === null) continue // a page with no usable line is dropped
    survivors.push({ voice: typeof pageDef.voice === 'string' ? pageDef.voice : null, key })
  }

  const out = new Array(model.pages.length).fill(null)
  for (let i = 0; i < survivors.length && i < model.pages.length; i++) {
    if (modelPageKey(model.pages[i]) !== survivors[i].key) return out.fill(null)
    out[i] = survivors[i].voice
  }
  return out
}

// Line records are shared between pages when several pages reference the same
// line index. Their geometry can't be moved on one page's behalf without
// moving it on the other's, so such pages are left where the adapter put them.
function sharedLineRecords(pages) {
  const seen = new Set()
  const shared = new Set()
  for (const page of pages) {
    for (const line of Array.isArray(page?.lines) ? page.lines : []) {
      if (seen.has(line)) shared.add(line)
      else seen.add(line)
    }
  }
  return shared
}

// The vertical extent of a page as the adapter laid it out, or null when the
// page carries no usable geometry.
function blockOf(page) {
  const lines = Array.isArray(page.lines) ? page.lines : []
  let top = Infinity
  let bottom = -Infinity
  for (const line of lines) {
    if (!isFiniteNumber(line?.y) || !isFiniteNumber(line?.height)) return null
    top = Math.min(top, line.y)
    bottom = Math.max(bottom, line.y + line.height)
  }
  return bottom > top ? { top, bottom, height: bottom - top } : null
}

// Interval-partition one voice's pages into rows: each page takes the first
// row free at its start time, opening a new row only when every existing one
// is still occupied. Guarantees no two of this voice's pages ever share a row
// while both are on screen, using the fewest rows that allows.
function assignRows(entries) {
  const rowEnds = []
  const rowOf = new Map()
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    let row = rowEnds.findIndex((end) => end <= entry.start + TOUCH_EPSILON)
    if (row < 0) {
      row = rowEnds.length
      rowEnds.push(0)
    }
    rowEnds[row] = entry.end
    rowOf.set(entry.index, row)
  }
  return { rowOf, rowCount: Math.max(1, rowEnds.length) }
}

// Stack rows at the height each actually needs and center the stack in the
// band. The band is never smaller than the stack it holds: bands are sized from
// these same row heights, and a stage too small for all of them takes the
// shared-row path rather than compressing. Compressing was the old behaviour
// and it could not work — it scaled the row centers while the blocks kept their
// full height, so a voice's own two rows were laid on top of each other, and
// the band clamp below then squared the two blocks up against the band edges
// and roughly doubled the overlap it was trying to avoid.
function rowCentersFor(rowHeights, bandTop, bandHeight) {
  const total = rowHeights.reduce((sum, h) => sum + h, 0) + ROW_GAP * (rowHeights.length - 1)
  let cursor = bandTop + Math.max(0, bandHeight - total) / 2
  return rowHeights.map((height) => {
    const center = cursor + height / 2
    cursor += height + ROW_GAP
    return center
  })
}

// Every placeable page packed into rows that all voices share, instead of each
// voice reserving rows of its own. A page prefers a row its own voice already
// uses, so a part keeps its place wherever the timing allows; failing that it
// takes any row free at its fade-in, and opens a new row only when every
// existing row is still occupied. The row count is therefore exactly the peak
// number of pages ever on screen together — the fewest any collision-free
// layout can use, and far fewer than a band per voice reserves, because a voice
// that is not singing is not holding a row.
function packRows(entries) {
  const rowEnds = []
  const rowsOfVoice = new Map()
  const rowOf = new Map()
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    const isFree = (end) => end <= entry.start + TOUCH_EPSILON
    const own = rowsOfVoice.get(entry.rosterIndex) || []
    let row = own.find((candidate) => isFree(rowEnds[candidate]))
    if (row === undefined) {
      const free = rowEnds.findIndex(isFree)
      row = free < 0 ? rowEnds.length : free
    }
    if (row === rowEnds.length) rowEnds.push(0)
    rowEnds[row] = entry.end
    rowOf.set(entry.index, row)
    if (!rowsOfVoice.has(entry.rosterIndex)) rowsOfVoice.set(entry.rosterIndex, [])
    const mine = rowsOfVoice.get(entry.rosterIndex)
    if (!mine.includes(row)) mine.push(row)
  }
  return { rowOf, rowCount: Math.max(1, rowEnds.length) }
}

// Rows carry no meaning of their own, so they can be stacked in any order: keep
// each voice's rows together and in roster order, so a shared-row stage still
// reads top-to-bottom as the same sequence of parts wherever the timing allows.
// A row several voices use belongs to whichever uses it most, ties going to the
// earlier voice on the roster.
function rowOrder(entries, rowOf, rowCount) {
  const owners = Array.from({ length: rowCount }, () => new Map())
  const firstStart = new Array(rowCount).fill(Infinity)
  for (const entry of entries) {
    const row = rowOf.get(entry.index)
    owners[row].set(entry.rosterIndex, (owners[row].get(entry.rosterIndex) || 0) + 1)
    firstStart[row] = Math.min(firstStart[row], entry.start)
  }
  const dominant = owners.map((counts) => {
    let winner = Infinity
    let best = -1
    for (const [rosterIndex, count] of counts) {
      if (count > best || (count === best && rosterIndex < winner)) {
        winner = rosterIndex
        best = count
      }
    }
    return winner
  })
  return Array.from({ length: rowCount }, (_, row) => row).sort(
    (a, b) => dominant[a] - dominant[b] || firstStart[a] - firstStart[b] || a - b
  )
}

// Shrink a page's block about its own top edge, text and all — the line height
// drives the font size (see layout.mjs), so scaling the boxes is what makes the
// glyphs shrink with them. Only reached when even shared rows overflow the
// stage, which no material in hand does; a stage that shrinks its text stays
// legible, one that overlaps it does not.
function scaleBlock(page, block, factor) {
  for (const line of page.lines) {
    line.y = block.top + (line.y - block.top) * factor
    line.height *= factor
  }
}

// Slide a page's lines so its block centers on `centerY`, kept inside its band
// and, as a hard backstop, inside the stage.
function shiftBlockTo(page, block, centerY, bandTop, bandBottom) {
  let dy = centerY - (block.top + block.bottom) / 2
  // The top edge is applied last of each pair so a block taller than the space
  // it is being fitted into loses its last line rather than its first.
  if (block.bottom + dy > bandBottom) dy = bandBottom - block.bottom
  if (block.top + dy < bandTop) dy = bandTop - block.top
  if (block.bottom + dy > STAGE_HEIGHT) dy = STAGE_HEIGHT - block.bottom
  if (block.top + dy < 0) dy = -block.top
  for (const line of page.lines) line.y += dy
}

/**
 * Give each singing voice its own band and color. Mutates and returns `model`
 * (freshly built per lyrics load, never shared). A document with fewer than
 * two voices that actually sing, or a page whose voice can't be established,
 * keeps whatever the adapter chose.
 */
export function applyVoiceLayout(model, doc) {
  if (!model || !Array.isArray(model.pages) || model.pages.length === 0) return model

  const ids = rosterIds(doc)
  if (ids.length < 2) return model

  const voices = voicePerPage(model, doc)
  const shared = sharedLineRecords(model.pages)

  // What each voice needs: its rows, and the total height they occupy.
  const plans = []
  ids.forEach((id, rosterIndex) => {
    const entries = []
    model.pages.forEach((page, index) => {
      if (voices[index] !== id) return
      if (!isFiniteNumber(page.fadeInStart)) return
      if (page.lines.some((line) => shared.has(line))) return
      const block = blockOf(page)
      if (!block) return
      const { start, end } = visibleWindow(page)
      entries.push({ index, start, end, block })
    })
    if (entries.length === 0) return

    const { rowOf, rowCount } = assignRows(entries)
    const rowHeights = new Array(rowCount).fill(0)
    for (const entry of entries) {
      const row = rowOf.get(entry.index)
      rowHeights[row] = Math.max(rowHeights[row], entry.block.height)
    }
    const need = rowHeights.reduce((sum, h) => sum + h, 0) + ROW_GAP * (rowCount - 1)
    plans.push({ rosterIndex, entries, rowOf, rowHeights, need })
  })

  // A roster is not proof that two parts sing. Bands are worth nothing if only
  // one voice has pages we could place.
  if (plans.length < 2) return model

  for (const plan of plans) {
    const palette = colorFor(plan.rosterIndex)
    for (const entry of plan.entries) {
      const page = model.pages[entry.index]
      page.activeColor = palette.activeColor
      page.activeBorder = palette.activeBorder
    }
  }

  // A band per voice is the layout worth having — a part sits in one place for
  // the whole song — but it reserves each voice's worst case for the whole
  // song, and the read-ahead crossfade makes that worst case two rows deep per
  // voice whether or not anyone else is singing. Three voices of two-line pages
  // reserve 606px of a 480px stage while never actually putting more than about
  // 410px on screen at once, so the bands compress into each other and a
  // voice's own crossfade pair collides. Bands while they fit, therefore, and
  // shared rows when they do not.
  const totalNeed = plans.reduce((sum, plan) => sum + plan.need, 0)
  if (totalNeed <= STAGE_HEIGHT) {
    placeInBands(model, plans, totalNeed)
    return model
  }

  // Barely over is its own case. A document that wants 496px of a 480px stage
  // would lose every voice's fixed place to save 16px, while one wanting 716px
  // pays only in font size — so try the smaller font first, and demote to
  // shared rows only when the shrink needed to keep the bands would itself cost
  // more than the bands are worth.
  const shrunkNeed = shrinkToFitBands(model, plans, totalNeed)
  if (shrunkNeed !== null) placeInBands(model, plans, shrunkNeed)
  else placeInSharedRows(model, plans)

  return model
}

// Scale every block down just enough for the bands to fit, if that can be done
// without going under BAND_SHRINK_FLOOR. Returns the new total need, or null to
// say the bands are not worth what saving them would cost. The gaps between
// rows do not scale — they are breathing room, not text.
function shrinkToFitBands(model, plans, totalNeed) {
  const gaps = plans.reduce((sum, plan) => sum + ROW_GAP * (plan.rowHeights.length - 1), 0)
  const blocks = totalNeed - gaps
  if (blocks <= 0) return null
  const factor = (STAGE_HEIGHT - gaps) / blocks
  if (factor < BAND_SHRINK_FLOOR || factor >= 1) return null

  for (const plan of plans) {
    const heights = new Array(plan.rowHeights.length).fill(0)
    for (const entry of plan.entries) {
      const page = model.pages[entry.index]
      scaleBlock(page, entry.block, factor)
      entry.block = blockOf(page) || entry.block
      const row = plan.rowOf.get(entry.index)
      heights[row] = Math.max(heights[row], entry.block.height)
    }
    plan.rowHeights = heights
    plan.need = heights.reduce((sum, height) => sum + height, 0) + ROW_GAP * (heights.length - 1)
  }
  return plans.reduce((sum, plan) => sum + plan.need, 0)
}

// Each voice in its own band, sized to what that voice needs, spare room shared
// out evenly. Only called when the needs fit, so every band is at least as tall
// as the rows it holds and nothing has to compress.
function placeInBands(model, plans, totalNeed) {
  const slack = STAGE_HEIGHT - totalNeed
  let bandTop = 0
  for (const plan of plans) {
    plan.top = bandTop
    plan.height = plan.need + slack / plans.length
    bandTop += plan.height
  }
  for (const plan of plans) {
    const centers = rowCentersFor(plan.rowHeights, plan.top, plan.height)
    for (const entry of plan.entries) {
      shiftBlockTo(
        model.pages[entry.index],
        entry.block,
        centers[plan.rowOf.get(entry.index)],
        plan.top,
        plan.top + plan.height
      )
    }
  }
}

// Bands do not fit: pack every voice's pages into rows they share, then stack
// those rows down the stage. Colour still says who is singing; what is given up
// is the guarantee that a part always appears in the same place, which no
// layout could have kept here anyway.
function placeInSharedRows(model, plans) {
  const entries = plans.flatMap((plan) =>
    plan.entries.map((entry) => ({ ...entry, rosterIndex: plan.rosterIndex }))
  )
  const { rowOf, rowCount } = packRows(entries)
  const gaps = ROW_GAP * (rowCount - 1)

  const measureRows = () => {
    const heights = new Array(rowCount).fill(0)
    for (const entry of entries) {
      const row = rowOf.get(entry.index)
      heights[row] = Math.max(heights[row], entry.block.height)
    }
    return heights
  }

  let heights = measureRows()
  const natural = heights.reduce((sum, height) => sum + height, 0)
  if (natural + gaps > STAGE_HEIGHT && natural > 0) {
    // Floored: with enough rows the gaps alone exceed the stage and an
    // unbounded factor reaches zero, which renders nothing at all.
    const factor = Math.max(MIN_BLOCK_SCALE, (STAGE_HEIGHT - gaps) / natural)
    for (const entry of entries) {
      const page = model.pages[entry.index]
      scaleBlock(page, entry.block, factor)
      // blockOf only returns null for a block of no height, which a positive
      // factor cannot produce from the positive one an entry is built with.
      entry.block = blockOf(page) || entry.block
    }
    heights = measureRows()
  }

  // Spare room shared out evenly, so the rows spread down the stage instead of
  // huddling in the middle of it.
  const spare = Math.max(0, STAGE_HEIGHT - heights.reduce((sum, height) => sum + height, 0) - gaps)
  const slots = new Array(rowCount)
  let top = 0
  for (const row of rowOrder(entries, rowOf, rowCount)) {
    const height = heights[row] + spare / rowCount
    slots[row] = { top, bottom: top + height }
    top += height + ROW_GAP
  }

  for (const entry of entries) {
    const slot = slots[rowOf.get(entry.index)]
    shiftBlockTo(
      model.pages[entry.index],
      entry.block,
      (slot.top + slot.bottom) / 2,
      slot.top,
      slot.bottom
    )
  }
}
