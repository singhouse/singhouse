// SPDX-License-Identifier: AGPL-3.0-only
// visualizers/index.js — registry of audio-reactive backdrop visualizers.
//
// Each entry is a module default-exporting { id, name, draw(ctx, w, h, frame) }.
// The stage wrapper (KaraokeStage.vue) resolves the host's chosen id to one of
// these and calls draw() every frame under the lyrics. `frame` is the fixed contract:
//
//   frame = {
//     t,        // song-clock position in seconds (rests when paused)
//     dt,       // seconds since last frame (0 on pause / seek / first frame)
//     level,    // 0..1 smoothed overall loudness of the selected source
//     bands,    // { bass, mid, treble } each 0..1, smoothed
//     beat,     // 0..1 bass-onset transient this frame (decays); for hits
//     freq,     // Uint8Array byte frequency data (len 512) or null
//     waveform, // Uint8Array byte time-domain data (len 1024) or null
//     animate,  // false when paused → draw a resting/frozen frame
//   }
//
// draw() owns the whole device canvas: it must paint an opaque full-frame
// backdrop and keep the center legible (vignette / scrim) so lyrics read on top.
//
// 'none' (flat fill) is handled by the renderer directly, not listed here.
import aurora from './aurora.js'
import particles from './particles.js'
import waveform from './waveform.js'
import tidal from './tidal.js'
import ember from './ember.js'

// Optional local visualizers are discovered rather than statically imported,
// so an installation with no local modules builds with only the standard
// visualizers. Dropping a *.viz.js file into private/ registers it without an
// edit here; a glob matching nothing resolves to {} at build time.
// Sorted by codepoint (not localeCompare — this must not vary with the
// runtime's locale) so the picker order is stable, never glob-order.
//
// The shape filter is not defensive noise: a drop-in file that forgets its
// default export builds CLEANLY and then throws while this module initializes,
// which takes out the stage chunk — and the canvas renderer has no
// fallback, so that is a dead projector mid-show. Skipping a malformed module
// degrades it to a missing picker entry instead.
const PRIVATE = Object.entries(import.meta.glob('./private/*.viz.js', { eager: true }))
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([, mod]) => mod.default)
  .filter(v => v && typeof v.id === 'string' && typeof v.draw === 'function')

// Order here is the order shown in the host picker; local entries come last.
const REGISTRY = [aurora, particles, waveform, tidal, ember, ...PRIVATE]
const BY_ID = new Map(REGISTRY.map(v => [v.id, v]))

export function getVisualizer(id) {
  return BY_ID.get(id) || null
}

// [{ id, name }] for the host picker, prefixed with the None option.
export function listVisualizers() {
  return [{ id: 'none', name: 'None' }, ...REGISTRY.map(v => ({ id: v.id, name: v.name }))]
}
