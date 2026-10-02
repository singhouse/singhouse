// SPDX-License-Identifier: AGPL-3.0-only
// Single source of brand identity for the frontend.
//
// Every brand-identifying string the UI shows lives HERE and nowhere else;
// premium consumes it via the shared `@/components` brand components, and the
// core-neutrality gate bans brand literals anywhere outside this module. Load-bearing
// identifiers (storage keys, cookie names, env vars, package names) are
// deliberately neutral and never derive from these constants. The one exception
// is BRAND_INSTALLED_NAME, the desktop packages' fixed on-disk name.

export const BRAND_NAME = 'singhouse'
// The installed product name the desktop packaging, signing and application
// name are configured with. It keeps its original casing so existing
// installations keep their paths, and it must stay equal to the name the
// desktop build, release and recovery code spell out in their file paths. The
// application's own UI never shows it.
export const BRAND_INSTALLED_NAME = 'Singhouse'
export const BRAND_WORDMARK = { head: 'sing', accent: 'house' }
export const BRAND_TAGLINE =
  'self-hosted karaoke player with stem separation and vocal mixing'
