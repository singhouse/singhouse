<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="flex h-screen flex-col overflow-hidden bg-dark-900 p-4 text-gray-100">
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <h1 class="text-lg font-semibold text-primary">Lyrics Editor Lab</h1>
      <span class="rounded bg-dark-600 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">dev</span>

      <!-- fixture picker -->
      <select v-model="pickedFixture" class="lab-select" @change="loadFixture">
        <option value="">
          {{ fixtureKeys.length ? `Load fixture… (${fixtureKeys.length})` : 'No fixtures (run export-lyrics-fixtures.py)' }}
        </option>
        <option v-for="key in fixtureKeys" :key="key" :value="key">{{ fixtureLabel(key) }}</option>
      </select>

      <!-- API loaders -->
      <select v-model.number="pickedSongId" class="lab-select" @focus="ensureSongs" @change="loadSets">
        <option :value="0">Load song from API…</option>
        <option v-for="s in songs" :key="s.id" :value="s.id">{{ s.artist }} — {{ s.title }}</option>
      </select>
      <select v-if="sets.length" v-model.number="pickedSetId" class="lab-select" @change="loadSet">
        <option :value="0">Pick lyrics set…</option>
        <option v-for="ls in sets" :key="ls.id" :value="ls.id" :disabled="!ls.has_word_sync">
          #{{ ls.id }} {{ ls.source }}{{ ls.label ? ` · ${ls.label}` : '' }}{{ ls.is_active ? ' · active' : '' }}{{ ls.has_word_sync ? '' : ' (no word sync)' }}
        </option>
      </select>

      <span v-if="source.label" class="truncate text-xs text-gray-500">{{ source.label }}</span>
    </header>

    <p v-if="notice" class="mb-2 rounded bg-dark-600 px-3 py-2 text-sm text-red-300">
      {{ notice }}
    </p>

    <div v-if="!source.wordSync" class="mt-24 text-center text-gray-500">
      <p class="text-xl">Load a fixture or a song's lyrics set to start editing.</p>
      <p class="mt-2 text-sm">
        Fixtures come from <code class="text-gray-400">backend/scripts/export-lyrics-fixtures.py</code>.
        The production editor lives at <code class="text-gray-400">/songs/&lt;id&gt;/lyrics-editor</code>.
      </p>
    </div>

    <EditorWorkbench
      v-else
      :word-sync="source.wordSync"
      :song-id="source.songId"
      :set-id="source.setId"
      :set-label="source.setLabel"
      @saved="loadSets"
    />
  </div>
</template>

<script setup>
// Dev-only playground wrapper around EditorWorkbench: adds the gitignored
// fixture corpus (import.meta.glob must never reach a prod bundle — the
// fixtures hold personal library data) and quick song/set pickers. The
// production entry point is /songs/:songId/lyrics-editor (LyricsEditorView).
import { ref } from 'vue'

import { lyricsSetsApi } from '@/api/client'
import { fetchAllSongs } from '@/utils/fetchAllSongs'
import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'

const notice = ref('')
// {wordSync, songId, setId, setLabel, label} — a fresh object per load so the
// workbench's wordSync watcher fires even when re-picking the same set.
const source = ref({ wordSync: null, songId: null, setId: null, setLabel: '', label: '' })

// ─── fixtures (gitignored; glob is empty when not exported) ─────────────────
const fixtureModules = import.meta.glob('/fixtures/lyrics/*/*.json')
const fixtureKeys = Object.keys(fixtureModules).sort()
const pickedFixture = ref('')
const fixtureLabel = (key) => key.replace('/fixtures/lyrics/', '').replace(/\.json$/, '')

async function loadFixture() {
  if (!pickedFixture.value) return
  const mod = await fixtureModules[pickedFixture.value]()
  const fixture = mod.default ?? mod
  // Fixtures record their source song_id — if that song is still in the
  // library, the workbench plays its stems under the lane. No setId → the
  // workbench disables saving (export session only).
  source.value = {
    wordSync: fixture.word_sync,
    songId: fixture.song_id ?? null,
    setId: null,
    setLabel: '',
    label: `${fixture.artist} — ${fixture.title} (${fixture.method})`,
  }
  notice.value = ''
  pickedSongId.value = 0
  pickedSetId.value = 0
  sets.value = []
}

// ─── API loading ────────────────────────────────────────────────────────────
const songs = ref([])
const sets = ref([])
const pickedSongId = ref(0)
const pickedSetId = ref(0)

async function ensureSongs() {
  if (songs.value.length) return
  try {
    const all = await fetchAllSongs()
    songs.value = all.filter((s) => s.status === 'ready')
  } catch (err) {
    notice.value = `Could not list songs (are you logged in?): ${err.message}`
  }
}

async function loadSets() {
  sets.value = []
  pickedSetId.value = 0
  if (!pickedSongId.value) return
  try {
    const res = await lyricsSetsApi.list(pickedSongId.value)
    sets.value = res.data
  } catch (err) {
    notice.value = `Could not list lyrics sets: ${err.message}`
  }
}

async function loadSet() {
  if (!pickedSetId.value) return
  try {
    const res = await lyricsSetsApi.get(pickedSongId.value, pickedSetId.value)
    const ls = res.data
    if (!ls.word_sync) {
      notice.value = 'That set has no word_sync payload.'
      return
    }
    const song = songs.value.find((s) => s.id === pickedSongId.value)
    source.value = {
      wordSync: ls.word_sync,
      songId: pickedSongId.value,
      setId: ls.id,
      setLabel: ls.label || ls.source,
      label: `${song?.artist ?? '?'} — ${song?.title ?? '?'} · set #${ls.id} (${ls.source}${ls.label ? ` · ${ls.label}` : ''})`,
    }
    notice.value = ''
    pickedFixture.value = ''
  } catch (err) {
    notice.value = `Could not load set: ${err.message}`
  }
}
</script>

<style scoped>
.lab-select {
  max-width: 20rem;
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
  color: #e5e7eb;
}
</style>
