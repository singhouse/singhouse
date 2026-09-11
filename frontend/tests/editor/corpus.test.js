// SPDX-License-Identifier: AGPL-3.0-only
// Corpus sweep: run the editor core over every real word_sync doc exported
// from the local DB (backend/scripts/export-lyrics-fixtures.py). The fixture
// dir is gitignored (personal library data), so this whole file skips cleanly
// when it's absent — CI and fresh clones still pass on synthetic tests alone.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { normalizeDoc, serializeDoc } from '../../src/editor/model.js'
import { mergeLines, splitLine } from '../../src/editor/ops.js'
import { validateDoc } from '../../src/editor/validate.js'

const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures', 'lyrics')
const INDEX = join(FIXTURES_DIR, 'index.json')
const available = existsSync(INDEX)

const entries = available ? JSON.parse(readFileSync(INDEX, 'utf8')) : []
const load = (entry) =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, entry.file), 'utf8')).word_sync

describe.skipIf(!available)(`real corpus (${entries.length} docs)`, () => {
  it.each(entries.map((e) => [`${e.method} #${e.lyrics_set_id} ${e.artist} - ${e.title}`, e]))(
    'normalizes, validates and round-trips: %s',
    (_name, entry) => {
      const canon = normalizeDoc(load(entry))

      // Real docs must be structurally clean by our rules — if this fails,
      // either the doc is genuinely corrupt or our rules are wrong.
      const { errors } = validateDoc(canon)
      expect(errors).toEqual([])

      // serialize → normalize is idempotent
      expect(normalizeDoc(serializeDoc(canon))).toEqual(canon)
    },
  )

  it.each(entries.map((e) => [`${e.method} #${e.lyrics_set_id}`, e]))(
    'split/merge round-trips on every line: %s',
    (_name, entry) => {
      const canon = normalizeDoc(load(entry))
      for (let lineIdx = 0; lineIdx < canon.lines.length; lineIdx++) {
        if (canon.lines[lineIdx].length < 2) continue
        const mid = Math.floor(canon.lines[lineIdx].length / 2)
        const roundTripped = mergeLines(splitLine(canon, { lineIdx, wordIdx: mid }), { lineIdx })
        expect(roundTripped).toEqual(canon)
      }
    },
  )
})
