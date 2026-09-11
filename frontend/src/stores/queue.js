// SPDX-License-Identifier: AGPL-3.0-only
// BasicManualQueue store — the core "sing next" list.
//
// Deliberately tiny: no singer identity, no shows, no wishlist, no join or
// tunnel state. Entries come back from /api/queue with song fields already
// joined, ordered by (position, id). Polling is ref-counted so QueuePanel and
// any future surface share one timer.

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { queueApi } from '@/api/client'

const POLL_INTERVAL_MS = 5000

export const useQueueStore = defineStore('queue', () => {
  const entries = ref([])
  const loading = ref(false)
  const error = ref(null)
  const fetchedOnce = ref(false)

  let _pollTimer = null
  let _pollers = 0 // ref-count so multiple views can share one timer

  const upNext = computed(() => entries.value[0] || null)
  const count = computed(() => entries.value.length)

  async function fetch() {
    loading.value = true
    error.value = null
    try {
      const res = await queueApi.list()
      entries.value = res.data?.entries || []
      fetchedOnce.value = true
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  // Mutations surface failures on `error` instead of throwing — the panel's
  // buttons call these bare, and an unhandled rejection would be invisible.
  // The next successful fetch (including the 5s poll) clears the message.
  async function add(songId, singerName = null) {
    try {
      await queueApi.add(songId, singerName)
    } catch (e) {
      error.value = e.message
      return false
    }
    await fetch()
    return true
  }

  async function remove(entryId) {
    try {
      await queueApi.remove(entryId)
    } catch (e) {
      error.value = e.message
      return false
    }
    await fetch()
    return true
  }

  async function clear() {
    try {
      await queueApi.clear()
    } catch (e) {
      error.value = e.message
      return false
    }
    await fetch()
    return true
  }

  // Reorder consumes the ListResponse the endpoint returns (no extra round
  // trip). A 409 means our picture of the queue was stale — another tab or
  // device changed it — so refetch and surface a soft error instead of
  // pretending the move happened.
  async function reorder(entryIds) {
    try {
      const res = await queueApi.reorder(entryIds)
      entries.value = res.data?.entries || []
      error.value = null
    } catch (e) {
      // The client interceptor rejects a plain Error with `.status` — the
      // axios `.response` object does NOT survive it (api/client.js).
      if (e.status === 409) {
        // Refetch FIRST — fetch() clears error, so the soft message must
        // land after it or the user never sees why their drag didn't stick.
        await fetch()
        error.value = 'Queue changed — try again'
      } else {
        error.value = e.message
      }
    }
  }

  function _permutationMoving(entryId, delta) {
    const ids = entries.value.map(e => e.id)
    const i = ids.indexOf(entryId)
    const j = i + delta
    if (i === -1 || j < 0 || j >= ids.length) return null
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    return ids
  }

  async function moveUp(entryId) {
    const ids = _permutationMoving(entryId, -1)
    if (ids) await reorder(ids)
  }

  async function moveDown(entryId) {
    const ids = _permutationMoving(entryId, +1)
    if (ids) await reorder(ids)
  }

  function startPolling() {
    _pollers += 1
    if (_pollTimer) return
    fetch()
    _pollTimer = setInterval(fetch, POLL_INTERVAL_MS)
  }

  function stopPolling() {
    _pollers = Math.max(0, _pollers - 1)
    if (_pollers === 0 && _pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
  }

  return {
    // state
    entries, loading, error, fetchedOnce,
    // computed
    upNext, count,
    // actions
    fetch, add, remove, clear, reorder, moveUp, moveDown,
    startPolling, stopPolling,
  }
})
