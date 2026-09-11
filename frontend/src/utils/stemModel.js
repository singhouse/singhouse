// SPDX-License-Identifier: AGPL-3.0-only
// Ordered playable-lane model derived from the song-detail `stems` DTO.
// One lane per `stems.vocals[]` entry in the DTO's order (roster
// order), then the "instrumental" bed LAST — it's the lane least likely to
// need adjusting, so it sits at the bottom like the old fixed mixer.
// `karaoke` is a preview-only stem and never a lane.
//
// Each lane: { key, kind, url, label, color, icon, volume, prevVolume }
//   key    — stable id used by the audio engine registries AND the mixer:
//            'instrumental' for the bed, the vocal id ('lead'/'backing'/'6'…)
//            for each vocal. (Vocal ids never collide with 'instrumental'.)
//   kind   — 'instrumental' | 'vocal' (drives the engine's analyser tap)
//   color  — hex; a vocal lane shares its color with the on-stage voice of the
//            same id (see colorForVoiceId). Instrumental gets a fixed neutral.
//   icon   — emoji for well-known lanes, else '' (mixer shows a color dot)
//   volume — default: instrumental 1, any backing lane 0.7, every other vocal 0
//            (muted guide). Matches the historical karaoke default, generalized.

import { colorForVoiceId } from './voiceLayout.js'

export const MAX_VOCAL_LANES = 12          // runaway-data guard
const INSTRUMENTAL_COLOR = '#9aa0b5'       // neutral; not a voice palette slot

const WELL_KNOWN_LABEL = { lead: 'Lead Vocals', backing: 'Backing Vocals' }
const WELL_KNOWN_ICON = { lead: '🎤', backing: '🎶' }

// Generic ids past the first of their kind are numbered: 'lead_2', 'backing_3'.
// The base id stays bare ('lead'), so the numbering starts at 2 and the
// well-known labels above still cover it.
const NUMBERED_ID = /^(lead|backing)_(\d+)$/

// Label for an unnamed vocal: the well-known one, else the numbered form, else
// the bare id. Numbered lanes deliberately get no icon — the mixer falls back
// to the lane's color dot, which is what tells two backing lanes apart.
function fallbackLabel(id) {
  if (WELL_KNOWN_LABEL[id]) return WELL_KNOWN_LABEL[id]
  const m = NUMBERED_ID.exec(id)
  if (m) return `${WELL_KNOWN_LABEL[m[1]]} ${m[2]}`
  return `Voice ${id}`
}

function vocalDefaultVolume(id) {
  // Every backing lane, numbered or not, is part of the audible backing bed by
  // convention — so 'backing_2' opens at the same level as 'backing'.
  if (id === 'backing' || /^backing_\d+$/.test(id)) return 0.7
  return 0                            // lead + every named voice: muted guide
}

/**
 * @param {object} stems  the song-detail `stems` object (or the song itself)
 * @param {string[]} rosterIds  ordered voice ids from word_sync (for color match)
 * @returns {Array} ordered lane models (see file header)
 */
export function buildStemModel(stems, rosterIds = []) {
  const s = stems || {}
  const lanes = []

  // Lane keys must be unique — they key the engine's node registries and the
  // mixer's v-for. The DTO is filesystem-derived, so a stray vocal_instrumental
  // file (or a duplicated id) could otherwise collide and silently overwrite a
  // registered lane's nodes: first claim wins, later collisions are skipped.
  const seen = new Set(['instrumental'])
  let vocalLanes = 0
  const vocals = Array.isArray(s.vocals) ? s.vocals : []
  for (const v of vocals) {
    if (vocalLanes >= MAX_VOCAL_LANES) break
    if (!v || v.url == null) continue
    const id = String(v.id)
    if (seen.has(id)) continue
    seen.add(id)
    vocalLanes++
    const vol = vocalDefaultVolume(id)
    lanes.push({
      key: id, kind: 'vocal', url: v.url,
      label: v.name || fallbackLabel(id),
      icon: WELL_KNOWN_ICON[id] || '',
      color: colorForVoiceId(id, rosterIds).activeColor,
      volume: vol, prevVolume: vol > 0 ? vol : 1, available: false,
    })
  }

  // The bed goes last: it's the lane least likely to need adjusting
  // mid-song, so the singer-facing lanes stay on top.
  if (s.instrumental) {
    lanes.push({
      key: 'instrumental', kind: 'instrumental', url: s.instrumental,
      label: 'Instrumental', icon: '🎸', color: INSTRUMENTAL_COLOR,
      volume: 1, prevVolume: 1, available: false,
    })
  }
  return lanes
}
