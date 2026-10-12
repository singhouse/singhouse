// SPDX-License-Identifier: AGPL-3.0-only
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { featuresApi } from '@/api/client'

/**
 * Operator-gated capability flags (GET /api/features).
 *
 * A UI hint only — every capability here is enforced server-side at its own
 * route. The point is to avoid rendering an affordance that can only fail:
 * a "look up lyrics" control on a server where the lookup is switched off.
 *
 * Defaults are the OFF//absent shape, so a failed or not-yet-completed load
 * hides optional affordances rather than showing broken ones. Third-party
 * lyrics lookup in particular is opt-in and off by default, and guessing
 * "probably on" would defeat that.
 */
export const useFeaturesStore = defineStore('features', () => {
  const lyricsLookup = ref({ enabled: false, provider: 'lrclib', label: '', env: '' })
  const cdgExport = ref(false)
  const llmPaging = ref(false)
  // Whether lyrics may be read off the operator's own media server. Its own
  // flag, not part of lyricsLookup: that one is about contacting a third-party
  // service at all, this one is about reusing text already on the operator's
  // server. Same OFF-by-default reasoning applies to both.
  const plexLyrics = ref({ enabled: false, env: '' })
  const loaded = ref(false)

  // In-flight request, so concurrent callers share one fetch instead of each
  // seeing loaded===false and firing their own.
  let inFlight = null

  const lyricsLookupEnabled = computed(() => lyricsLookup.value.enabled === true)
  const lyricsLookupLabel = computed(() => lyricsLookup.value.label || 'a third-party service')
  const llmPagingEnabled = computed(() => llmPaging.value === true)
  const cdgExportEnabled = computed(() => cdgExport.value === true)
  const plexLyricsEnabled = computed(() => plexLyrics.value.enabled === true)
  const plexLyricsEnv = computed(() => plexLyrics.value.env || 'KARAOKE_PLEX_LYRICS')

  // Monotonic issue counter: a response only wins if no newer request has
  // been issued since. Without it a slow first load can land after a forced
  // refresh and overwrite the fresher answer.
  let generation = 0

  async function load({ force = false } = {}) {
    if (loaded.value && !force) return Promise.resolve()
    if (inFlight && !force) return inFlight

    const mine = ++generation
    const p = (async () => {
      try {
        const res = await featuresApi.get()
        if (mine !== generation) return          // superseded; discard
        if (res.data?.lyrics_lookup) lyricsLookup.value = res.data.lyrics_lookup
        cdgExport.value = res.data?.cdg_export === true
        llmPaging.value = res.data?.llm_paging === true
        if (res.data?.plex_lyrics) plexLyrics.value = res.data.plex_lyrics
        loaded.value = true
      } catch (e) {
        // Leave the OFF defaults in place. A 401 here just means the gate is
        // locked and the caller will be sent to unlock; anything else and the
        // conservative read is that optional capabilities stay hidden.
        console.warn('Feature flags unavailable:', e.message)
      }
    })()

    inFlight = p
    // Clear only if we are still the current request — a concurrent forced
    // load may have replaced the slot while this one was in flight.
    p.finally(() => { if (inFlight === p) inFlight = null })
    return p
  }

  return {
    lyricsLookup, cdgExport, plexLyrics, llmPaging, loaded,
    lyricsLookupEnabled, lyricsLookupLabel, cdgExportEnabled, llmPagingEnabled,
    plexLyricsEnabled, plexLyricsEnv,
    load,
  }
})
