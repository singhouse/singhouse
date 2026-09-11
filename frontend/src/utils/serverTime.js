// SPDX-License-Identifier: AGPL-3.0-only
//
// `created_at` arrives as NAIVE UTC — SQLite's CURRENT_TIMESTAMP through
// `.isoformat()`, e.g. "2026-08-11T01:35:18" with no `Z` and no offset. JS
// parses a bare date-time as LOCAL, so reading it raw shifts every timestamp
// by the viewer's UTC offset: a song added at 20:35 Central renders as the
// NEXT day. That is every song added during an evening show — which is why
// this lives in one place rather than in each surface that shows a date.

export function parseServerTs(iso) {
  if (!iso) return NaN
  return Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
}

/** Short date, in the viewer's locale. Empty string for an unparseable value. */
export function formatServerDate(iso) {
  const t = parseServerTs(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleDateString(undefined, {
    year: '2-digit', month: 'numeric', day: 'numeric',
  })
}

/** Date + time, for surfaces where "which of today's three runs" matters. */
export function formatServerDateTime(iso) {
  const t = parseServerTs(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString(undefined, {
    year: '2-digit', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
