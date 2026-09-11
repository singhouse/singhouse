// SPDX-License-Identifier: AGPL-3.0-only
import { songApi } from '@/api/client'

// The library endpoint is paginated and caps `page_size` at 500 server-side
// (`le=500`), so a single request cannot stand in for "the whole library" at
// any size we care about — it silently returns a prefix and the caller has no
// way to tell a full library from a truncated one. Anything that means *all
// songs* walks the pages through here.
//
// The walk is OFFSET-based over a NON-UNIQUE sort key: the backend orders by
// `created_at DESC` with no tiebreak, and `created_at` is SQLite's
// CURRENT_TIMESTAMP — second granularity, so ties exist. Worse, the poll
// re-walks while rows are being ingested, and a single insert between two
// pages shifts every later offset by one. Both make the same two mistakes
// reachable: a row served twice, and a row skipped entirely.
//
// So: dedupe by id, and decide "done" from rows REQUESTED rather than rows
// KEPT. Counting kept rows would let duplicates satisfy `total` while real
// songs were still unfetched — silently reproducing the truncation this
// util exists to remove.
export const SONG_PAGE_SIZE = 500   // == the backend's `le=500` ceiling
export const MAX_PAGES = 100        // backstop: a wrong `total` must not spin forever

/**
 * Fetch every song in the library, walking pagination.
 *
 * @param {string|undefined} search  optional free-text filter, passed through
 * @returns {Promise<Array>} all matching songs, first-seen (server) order
 */
export async function fetchAllSongs(search) {
  const byId = new Map()
  let page = 1

  for (; page <= MAX_PAGES; page++) {
    const res = await songApi.list({ search, page, pageSize: SONG_PAGE_SIZE })
    const batch = res.data?.songs || res.data || []
    if (!Array.isArray(batch)) break

    const before = byId.size
    for (const song of batch) {
      // A row with no id cannot be deduped or keyed; keep it under a
      // synthetic key rather than dropping data on the floor.
      const key = song?.id ?? `__anon_${byId.size}`
      if (!byId.has(key)) byId.set(key, song)
    }

    // A short page is the last page. This is also what stops us after a
    // single request when the response carries no `total` at all.
    if (batch.length < SONG_PAGE_SIZE) break

    // A full page that contributed nothing new means the server is not
    // advancing (a `page` param it ignores, say). Walking on would spin to
    // the backstop for no rows.
    if (byId.size === before) break

    const total = res.data?.total
    if (typeof total === 'number' && page * SONG_PAGE_SIZE >= total) break
  }

  if (page > MAX_PAGES) {
    // Truncating quietly is the exact bug this util was written to fix, one
    // order of magnitude up. Say so.
    console.warn(
      `fetchAllSongs: stopped at the ${MAX_PAGES}-page backstop ` +
      `(${byId.size} songs); the library list may be incomplete.`
    )
  }

  return [...byId.values()]
}
