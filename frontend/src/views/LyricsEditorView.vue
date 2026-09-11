<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="flex h-screen flex-col overflow-hidden bg-dark-900 p-4 text-gray-100">
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <router-link
        to="/"
        class="rounded border border-dark-500 bg-dark-800 px-2 py-1 text-xs text-gray-300 hover:border-primary hover:text-primary"
        title="Back to the host view"
      >← Library</router-link>
      <h1 class="text-lg font-semibold text-primary">Lyrics Editor</h1>
      <span v-if="song" class="truncate text-sm text-gray-300">
        {{ song.artist }} — {{ song.title }}
      </span>

      <!-- set switcher -->
      <select
        v-if="sets.length"
        :value="setId ?? 0"
        class="ed-select"
        title="Which lyrics set to edit"
        @change="openSet(Number($event.target.value))"
      >
        <option :value="0" disabled>Pick lyrics set…</option>
        <option v-for="ls in sets" :key="ls.id" :value="ls.id" :disabled="!ls.has_word_sync">
          #{{ ls.id }} {{ ls.source }}{{ ls.label ? ` · ${ls.label}` : '' }}{{ ls.is_active ? ' · active' : '' }}{{ ls.has_word_sync ? '' : ' (no word sync)' }}
        </option>
      </select>

      <button
        v-if="setId"
        class="ed-btn"
        :disabled="busy"
        title="Duplicate this set and edit the copy (original stays untouched and active)"
        @click="duplicateSet"
      >⧉ Duplicate set</button>

      <!-- With no active set there is nothing for this workbench to be the
           right tool for: the way forward is a version to edit, and that is
           what Song tools makes. -->
      <button
        v-if="!hasActiveSet && songId"
        class="ed-btn"
        title="Lyrics versions, re-fit, re-split and metadata for this song"
        @click="openTools"
      >⚙ Song tools</button>
    </header>

    <p v-if="notice" class="mb-2 rounded bg-dark-600 px-3 py-2 text-sm" :class="noticeIsError ? 'text-red-300' : 'text-emerald-300'">
      {{ notice }}
    </p>

    <div v-if="loading" class="mt-24 text-center text-gray-500">
      <p class="text-xl">Loading…</p>
    </div>

    <EditorWorkbench
      v-else-if="wordSync"
      :word-sync="wordSync"
      :song-id="songId"
      :set-id="setId"
      :set-label="setLabel"
      @saved="onSaved"
    />

    <div v-else class="mt-24 text-center text-gray-500">
      <p class="text-xl">This song has no editable lyrics set.</p>
      <p class="mt-2 text-sm">
        Only sets with word-level sync can be edited here — make one in Song
        tools first, with “Listen again” or by pasting lyrics.
      </p>
      <button v-if="songId" class="ed-btn mt-4" @click="openTools">⚙ Open Song tools</button>
    </div>

    <!-- Same panel the library shows, docked to the right of the workbench.
         Fixed rather than a flex sibling: this view fills the viewport and its
         columns are the editor's own. -->
    <aside v-if="tools.songId" class="ed-tools">
      <SongToolsPanel
        :key="tools.songId"
        :song-id="tools.songId"
        :initial-tab="tools.tab"
        @close="closeTools"
      />
    </aside>
  </div>
</template>

<script setup>
// Production word-timing editor. Deep-linkable:
//   /songs/:songId/lyrics-editor          → edit the active (or first) set with word sync
//   /songs/:songId/lyrics-editor/:setId   → edit that set
// Saving creates a NEW manual set (activated) and the editor moves onto it, so
// repeated saves chain provenance instead of compounding "edited from edited
// from…" labels. "Duplicate set" copies via the backend and opens the copy.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { lyricsSetsApi, songApi } from '@/api/client'
import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'
import SongToolsPanel from '@/components/SongToolsPanel.vue'
import { useSongToolsStore } from '@/stores/songTools'

const route = useRoute()
const router = useRouter()
const tools = useSongToolsStore()

const songId = ref(null)
const song = ref(null)
const sets = ref([])

const setId = ref(null)
const setLabel = ref('')
const wordSync = ref(null)

const loading = ref(true)
const busy = ref(false)
const notice = ref('')
const noticeIsError = ref(false)

function flash(msg, isError = false) {
  notice.value = msg
  noticeIsError.value = isError
}

const hasActiveSet = computed(() => sets.value.some(ls => ls.is_active))

// The pointer is global and this view is one of three places that can move it.
// It deliberately does NOT close the panel on the way out: the host who opened
// Song tools in the library and then stepped into the workbench would come
// back to it shut, having closed nothing. Whoever opened it closes it.
function openTools() {
  if (songId.value) tools.open(songId.value)
}

// The panel can have activated, deleted or re-paged a set while it was open,
// so the switcher and the loaded set are re-read on the way out.
async function closeTools() {
  tools.close()
  if (!songId.value) return
  try {
    await refreshSets()
  } catch (err) {
    flash(`Could not refresh the set list: ${err.message}`, true)
  }
}

async function refreshSets() {
  const res = await lyricsSetsApi.list(songId.value)
  sets.value = res.data
}

/** Load one set into the editor and reflect it in the URL. */
async function openSet(lid, { replaceUrl = true } = {}) {
  if (!lid) return
  try {
    const res = await lyricsSetsApi.get(songId.value, lid)
    const ls = res.data
    if (!ls.word_sync) {
      flash(`Set #${lid} has no word-level sync to edit.`, true)
      return
    }
    setId.value = ls.id
    setLabel.value = ls.label || ls.source
    wordSync.value = ls.word_sync
    flash('')
    if (replaceUrl && Number(route.params.setId) !== ls.id) {
      router.replace({ params: { ...route.params, setId: String(ls.id) } })
    }
  } catch (err) {
    flash(`Could not load set #${lid}: ${err.message}`, true)
  }
}

/** Which set to open when the URL doesn't say: active if editable, else the
 *  first (newest last in list order) set that has word sync. */
function defaultSetId() {
  const editable = sets.value.filter((ls) => ls.has_word_sync)
  return (editable.find((ls) => ls.is_active) ?? editable[editable.length - 1])?.id ?? null
}

async function loadFromRoute() {
  loading.value = true
  try {
    songId.value = Number(route.params.songId)
    const [songRes] = await Promise.all([songApi.get(songId.value), refreshSets()])
    song.value = songRes.data
    const requested = Number(route.params.setId) || defaultSetId()
    if (requested) await openSet(requested)
  } catch (err) {
    flash(`Could not load song: ${err.message}`, true)
  } finally {
    loading.value = false
  }
}

// React to external navigation (back/forward, links from the sets modal).
// Our own router.replace calls are no-ops here because setId already matches.
watch(
  () => [route.params.songId, route.params.setId],
  ([sid, lid]) => {
    if (route.name !== 'lyrics-editor') return
    if (Number(sid) !== songId.value) loadFromRoute()
    else if (Number(lid) && Number(lid) !== setId.value) openSet(Number(lid), { replaceUrl: false })
  },
  { immediate: true },
)

async function onSaved(newSet) {
  await refreshSets()
  // Continue editing the freshly saved set so the next save chains from it.
  await openSet(newSet.id)
  flash(`Saved as new active set #${newSet.id} ("${newSet.label}"). Now editing the saved set.`)
}

async function duplicateSet() {
  if (!setId.value || busy.value) return
  busy.value = true
  try {
    const res = await lyricsSetsApi.copy(songId.value, setId.value)
    await refreshSets()
    await openSet(res.data.id)
    flash(`Duplicated into set #${res.data.id} ("${res.data.label}") — now editing the copy.`)
  } catch (err) {
    flash(`Copy failed: ${err.message}`, true)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.ed-tools {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(380px, 92vw);
  z-index: 30;
  display: flex;
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
}
.ed-tools > :deep(.tools) { flex: 1; min-width: 0; }

.ed-select {
  max-width: 24rem;
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
  color: #e5e7eb;
}
.ed-btn {
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  color: #d1d5db;
}
.ed-btn:hover:not(:disabled) {
  border-color: #e23e57;
  color: #e23e57;
}
.ed-btn:disabled {
  opacity: 0.4;
}
</style>
