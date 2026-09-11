// SPDX-License-Identifier: AGPL-3.0-only
// Single source of brand identity for the frontend.
//
// Every brand-identifying string the UI shows lives HERE and nowhere else;
// premium consumes it via the shared `@/components` brand components, and the
// core-neutrality gate bans brand literals anywhere outside this module. Load-bearing
// identifiers (storage keys, cookie names, env vars, package names) are
// deliberately neutral and never derive from these constants.

export const BRAND_NAME = 'Singhouse'
export const BRAND_WORDMARK = { head: 'sing', accent: 'house' }
export const BRAND_TAGLINE =
  'self-hosted karaoke player with stem separation and vocal mixing'
