// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a song can have its lead/backing split re-run, and — when it cannot
// — why not, in words the host can act on.
//
// The backend refuses anything that is not a plain lead/backing pair, because
// a re-split produces exactly those two lanes and would orphan any others.
// The same test runs here so the control carries a reason instead of a 409:
// `stems.vocals` is the ordered roster the read side derived from disk, so two
// entries with these ids IS the pair.

export function resplitEligibility(song) {
  if (!song) {
    return { canResplit: false, reason: 'No song loaded.' }
  }
  if (song.status !== 'ready') {
    const status = song.status || 'not ready'
    return {
      canResplit: false,
      reason: `This song is ${status} — a re-split needs finished stems to replace.`,
    }
  }
  if (song.has_video) {
    return {
      canResplit: false,
      reason: 'This song came in as a karaoke video: it has one instrumental '
        + 'stem and its lyrics are part of the picture, so there is no '
        + 'lead/backing pair to split.',
    }
  }
  const vocals = (song.stems || song || {}).vocals
  if (!Array.isArray(vocals) || vocals.length === 0) {
    return { canResplit: false, reason: 'This song has no vocal stems to split.' }
  }
  const isPair = vocals.length === 2
    && vocals[0]?.id === 'lead'
    && vocals[1]?.id === 'backing'
  if (!isPair) {
    return {
      canResplit: false,
      reason: 'A re-split produces exactly one lead and one backing stem. '
        + 'This song has a per-voice roster or extra lanes, which the split '
        + 'would orphan.',
    }
  }
  return { canResplit: true, reason: '' }
}
