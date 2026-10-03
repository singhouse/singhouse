// SPDX-License-Identifier: AGPL-3.0-only
// Contract test for the visualizer registry and its private-entry seam.
//
// visualizers/index.js discovers optional entries with import.meta.glob over
// private/, a directory the public build excludes.
// The failure this exists to catch is a glob that silently stops matching:
// the tree still builds, the public build is unaffected, and a local install
// loses its backdrop with nothing to notice. So the count assertion below is
// the load-bearing one — it re-globs INDEPENDENTLY of the registry and pins
// that every private module present in the tree actually reached the picker.
//
// What it does NOT catch, deliberately: reverting the glob to a static import.
// That is invisible to any in-tree test (both trees have the file) and is
// premium/tools/check_public_cut.sh's job — it deletes the directory and
// rebuilds, which a static import fails.
//
// It never names a private entry, so it holds in BOTH trees: in the public
// repo every private-side assertion runs over an empty set (0 === 0) and
// passes; here it runs over the real entries.

import { describe, expect, it } from 'vitest'
import { getVisualizer, listVisualizers } from '@/stage/visualizers/index.js'

// The publishable defaults, in host-picker order. Private entries sort after.
const PUBLIC_IDS = ['aurora', 'particles', 'waveform', 'tidal', 'ember']

// Independent of the registry's own glob ON PURPOSE: if this test reused that
// result it would agree with the registry by construction and could never
// detect the registry's glob going stale. Empty in the public tree.
const PRIVATE_MODULES = import.meta.glob('@/stage/visualizers/private/*.viz.js', { eager: true })

describe('visualizer registry', () => {
  it('registers every private visualizer present in this tree', () => {
    // The one assertion that fails when the registry's glob stops matching.
    expect(listVisualizers()).toHaveLength(
      1 + PUBLIC_IDS.length + Object.keys(PRIVATE_MODULES).length,
    )
  })

  it('lists None first, then the public visualizers in picker order', () => {
    const ids = listVisualizers().map(v => v.id)
    expect(ids.slice(0, 1 + PUBLIC_IDS.length)).toEqual(['none', ...PUBLIC_IDS])
  })

  it('resolves every public visualizer to a usable descriptor', () => {
    for (const id of PUBLIC_IDS) {
      const viz = getVisualizer(id)
      expect(viz, `getVisualizer(${id})`).toBeTruthy()
      expect(viz.id).toBe(id)
    }
  })

  it('holds every registered entry to the descriptor contract', () => {
    // Includes whatever private/ contributed in this tree — a module that
    // default-exports the wrong shape is the realistic way a glob seam breaks,
    // and it would otherwise surface as a blank projector mid-show.
    for (const { id, name } of listVisualizers().slice(1)) {
      expect(typeof id, `id of ${id}`).toBe('string')
      expect(typeof name, `name of ${id}`).toBe('string')
      expect(name.length, `name of ${id}`).toBeGreaterThan(0)
      expect(typeof getVisualizer(id).draw, `draw() of ${id}`).toBe('function')
    }
  })

  it('assigns each entry a unique id', () => {
    // A private entry reusing a public id would shadow it in the id map while
    // leaving both in the picker.
    const ids = listVisualizers().map(v => v.id)
    expect(ids).toHaveLength(new Set(ids).size)
  })

  it('returns null for the flat fill and for unknown ids', () => {
    // KaraokeStage's fallback: anything unresolvable renders 'none' rather
    // than throwing. This is what makes a public install tolerate a setting
    // left behind by a private entry it does not have.
    expect(getVisualizer('none')).toBeNull()
    expect(getVisualizer('definitely-not-registered')).toBeNull()
  })
})
