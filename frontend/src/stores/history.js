// SPDX-License-Identifier: AGPL-3.0-only
// Flat play-history store — the core "what got sung" log.
//
// CORE-ONLY: the /api/history router mounts only in the single-host assembly,
// so this store is only ever driven from surfaces gated on the absence of a
// queue provider (QueuePanel Sing, HostShell's core ended branch, HistoryModal).
//
// A play is recorded at the ▶ Sing dequeue moment and flipped `completed` when
// the deck emits a NATURAL end for that same song. History is plain DB hygiene:
// retention is a setting (0 = keep forever), never a paywall.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { historyApi } from '@/api/client'

export const useHistoryStore = defineStore('history', () => {
  // The in-flight play: recordPlay sets these, completeIfPending clears them.
  const currentHistoryId = ref(null)
  const currentPlaySongId = ref(null)

  const entries = ref([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref(null)
  const search = ref('')
  const retentionDays = ref(30)
  const fetchedOnce = ref(false)

  // Fire-and-forget by contract: the ▶ Sing action calls this bare and must
  // NEVER be blocked or broken by a history write failing. So it never throws —
  // a failure surfaces on `error` and leaves the ids null (no play to complete
  // later). Returns the new id, or null on failure.
  async function recordPlay(songId, singerName = null) {
    try {
      const res = await historyApi.record(songId, singerName)
      currentHistoryId.value = res.data?.id ?? null
      currentPlaySongId.value = songId
      return currentHistoryId.value
    } catch (e) {
      error.value = e.message
      currentHistoryId.value = null
      currentPlaySongId.value = null
      return null
    }
  }

  // The `ended`-event consumer for the core build. Only a NATURAL end of the
  // song we actually recorded completes the row — reason 'stopped' (host cut it
  // short) does not, and the songId match prevents completing the wrong row
  // when an unrelated play (e.g. a direct library load) ended in between.
  async function completeIfPending(info) {
    if (info?.reason !== 'natural') return
    if (currentHistoryId.value == null) return
    if (info.songId !== currentPlaySongId.value) return
    try {
      await historyApi.complete(currentHistoryId.value)
    } catch (e) {
      // 404: the row is gone (undone from another tab of the host view);
      // there is nothing left to complete and nothing to report.
      if (e?.status !== 404) error.value = e.message
    }
    currentHistoryId.value = null
    currentPlaySongId.value = null
  }

  // Undo of a ▶ Sing. Rewind the pending-completion pointer first (and
  // synchronously, before any await) when it still points at the undone row,
  // so a later `ended` can never complete it; `previous` is the pointer as it
  // stood before that Sing, which puts the reloaded song's own row back in
  // line. `rewind: false` leaves the pointer alone (a tab that did not make
  // the Sing has its own deck). Then delete the row only if it never
  // completed and, given `songId`, still points at that song — the server
  // decides, so a play that really finished stays in the log. Never throws;
  // a missing id (the record had failed) is a no-op, and a row already gone
  // is fine.
  async function undoPlay(historyId, previous = null, { rewind = true, songId = null } = {}) {
    if (historyId == null) return
    if (rewind && currentHistoryId.value === historyId) {
      currentHistoryId.value = previous?.historyId ?? null
      currentPlaySongId.value = previous?.historyId != null ? previous.songId ?? null : null
    }
    try {
      await historyApi.remove(historyId, songId != null ? { ifIncomplete: true, songId } : { ifIncomplete: true })
    } catch (e) {
      if (e?.status !== 404) error.value = e.message
    }
  }

  async function fetchList() {
    loading.value = true
    error.value = null
    try {
      const res = await historyApi.list({ search: search.value })
      entries.value = res.data?.entries || []
      total.value = res.data?.total || 0
      fetchedOnce.value = true
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function remove(id) {
    try {
      await historyApi.remove(id)
    } catch (e) {
      error.value = e.message
      return false
    }
    await fetchList()
    return true
  }

  async function clear() {
    try {
      await historyApi.clear()
    } catch (e) {
      error.value = e.message
      return false
    }
    await fetchList()
    return true
  }

  async function fetchSettings() {
    try {
      const res = await historyApi.getSettings()
      retentionDays.value = res.data?.retention_days ?? retentionDays.value
    } catch (e) {
      error.value = e.message
    }
  }

  async function setRetention(days) {
    try {
      const res = await historyApi.setSettings(days)
      retentionDays.value = res.data?.retention_days ?? days
    } catch (e) {
      error.value = e.message
    }
  }

  return {
    // state
    currentHistoryId, currentPlaySongId,
    entries, total, loading, error, search, retentionDays, fetchedOnce,
    // actions
    recordPlay, completeIfPending, undoPlay,
    fetchList, remove, clear, fetchSettings, setRetention,
  }
})
