// SPDX-License-Identifier: AGPL-3.0-only
//
// The Pass-2 lead/backing models the UI offers, in one place.
//
// These ids are the server's allowlist (`karaoke_models.CHOICES`) — the
// backend resolves each into the checkpoint a subprocess is handed, so what
// travels over the wire is only ever one of these strings. Upload picks the
// model for a new song and the mixer can re-pick it for an existing one; two
// copies of the list would drift.
//
// Roformer is better on ordinary mixes and stays the default. It struggles
// when one singer is multi-tracked against themselves: the doubles read as one
// voice and land in the lead stem. MDX-Net Karaoke 2 separates those better,
// at some cost on everything else — hence a per-song choice, not a new
// default. Nothing here is ever trusted as a filename.

export const KARAOKE_MODELS = [
  { id: 'roformer', label: 'Roformer', hint: 'Default. Best on ordinary mixes.' },
  { id: 'mdxnet_kara2', label: 'MDX-Net Karaoke 2', hint: 'Better when one singer is multi-tracked (doubled/stacked vocals).' },
]

// What both callers start on, and what the server falls back to when a request
// names no model at all.
export const DEFAULT_KARAOKE_MODEL = 'roformer'
