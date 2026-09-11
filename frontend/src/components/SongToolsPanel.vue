<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <section class="tools" aria-label="Song tools">
    <header class="tools__head">
      <div class="tools__ident">
        <p class="tools__title" :title="titleText">{{ titleText }}</p>
        <p class="tools__artist">{{ song?.artist || 'Unknown Artist' }}</p>
      </div>
      <button class="tools__close" aria-label="Close song tools" @click="$emit('close')">×</button>
    </header>

    <nav class="tools__tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="tools__tab"
        :class="{ 'tools__tab--on': tab === t.id }"
        role="tab"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >{{ t.label }}</button>
    </nav>

    <!-- The current job, inline. It belongs to the SONG, not to this panel:
         closing and reopening finds it exactly where it was. -->
    <p
      v-if="job"
      class="tools__job"
      :class="{
        'tools__job--error': job.status === 'failed',
        'tools__job--done': job.status === 'done',
      }"
    >
      <span class="tools__job-kind">{{ jobLabel }}</span>
      <span class="tools__job-text">{{ jobText }}</span>
      <button
        v-if="!jobRunning"
        class="tools__job-x"
        aria-label="Dismiss job status"
        @click="store.clearJob(songId)"
      >×</button>
    </p>

    <div class="tools__body">
      <p v-if="loadError" class="tools__error">{{ loadError }}</p>

      <LyricsTab
        v-show="tab === 'lyrics'"
        :song-id="songId"
        :song="song"
        :sets="sets"
        @refresh="refresh"
      />
      <StemsTab v-show="tab === 'stems'" :song-id="songId" :song="song" />
      <DetailsTab
        v-show="tab === 'details'"
        :song-id="songId"
        :song="song"
        @refresh="refresh"
      />
    </div>
  </section>
</template>

<script setup>
// Song tools: everything you can do TO a song, in one place, for any song in
// the library — ready, processing or failed — without loading it onto the
// deck. It replaces the lyrics modal, which could only be reached from the
// mixer of the song already playing.
//
// It holds no job state of its own. Jobs live on the songs store keyed by
// song id, so closing this panel orphans no polling and reopening it on
// another song cannot inherit the first one's progress.
import { computed, ref, watch } from 'vue'
import { useSongsStore, JOB_KIND_LABELS } from '@/stores/songs'
import { songApi } from '@/api/client'
import LyricsTab from './songtools/LyricsTab.vue'
import StemsTab from './songtools/StemsTab.vue'
import DetailsTab from './songtools/DetailsTab.vue'

const props = defineProps({
  songId:     { type: Number, required: true },
  initialTab: { type: String, default: 'lyrics' },
})

defineEmits(['close'])

const TABS = [
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'stems', label: 'Stems' },
  { id: 'details', label: 'Details' },
]

const store = useSongsStore()

const tab = ref(TABS.some(t => t.id === props.initialTab) ? props.initialTab : 'lyrics')
const detail = ref(null)
const sets = ref([])
const loadError = ref('')

// The library row is refreshed by the store's processing poll, so its status,
// phase and progress are the live ones; the detail carries everything the list
// projection leaves out (stems, error_message, the active set). Neither alone
// is the whole song.
const row = computed(() => store.songs.find(s => s.id === props.songId) || null)
const song = computed(() => {
  if (!detail.value && !row.value) return null
  return { ...(detail.value || {}), ...(row.value || {}) }
})

const titleText = computed(
  () => song.value?.title || song.value?.filename || `Song ${props.songId}`
)

const job = computed(() => store.jobFor(props.songId))
const jobRunning = computed(() => store.isJobRunning(props.songId))
const jobLabel = computed(() => JOB_KIND_LABELS[job.value?.kind] || 'Job')
const jobText = computed(() => {
  const j = job.value
  if (!j) return ''
  if (j.status === 'failed') return j.error || 'failed'
  if (j.status === 'done') return j.message || 'finished'
  const parts = []
  if (j.phase) parts.push(j.phase)
  if (j.progress != null) parts.push(`${j.progress}%`)
  return parts.join(' · ') || j.message || 'running…'
})

async function refresh() {
  if (!props.songId) return
  const wanted = props.songId
  loadError.value = ''
  try {
    const res = await songApi.get(wanted)
    // The panel can have been re-pointed while the request was in flight.
    if (props.songId !== wanted) return
    detail.value = res.data
  } catch (e) {
    if (props.songId !== wanted) return
    detail.value = null
    loadError.value = `Could not load song ${wanted}: ${e.message}`
  }
  const list = await store.listLyricsSets(wanted)
  if (props.songId !== wanted) return
  sets.value = list
}

watch(() => props.songId, () => {
  detail.value = null
  sets.value = []
  refresh()
}, { immediate: true })

// A finished job changes what this panel is showing — a new set, replaced
// stems, a song that is no longer failed. Only on the transition into `done`,
// so a panel opened long after a job finished does not re-fetch on mount.
watch(() => job.value?.status, (status, prev) => {
  if (status === 'done' && prev && prev !== 'done') refresh()
})

defineExpose({ tab, sets, song, refresh, job })
</script>

<style scoped>
.tools {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: rgba(0, 0, 0, 0.55);
  border-left: 1px solid var(--border-subtle);
}

.tools__head {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.7rem 0.8rem 0.5rem;
  border-bottom: 1px solid var(--border-subtle);
}
.tools__ident { flex: 1; min-width: 0; }
.tools__title {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tools__artist {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tools__close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.35rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.2rem;
}
.tools__close:hover { color: #fff; }

.tools__tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.4rem 0.8rem 0;
}
.tools__tab {
  padding: 0.3rem 0.6rem;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border: 1px solid transparent;
  border-bottom: none;
  background: none;
  color: var(--text-secondary);
  font-size: 0.78rem;
  cursor: pointer;
}
.tools__tab:hover { color: #fff; }
.tools__tab--on {
  background: var(--bg-glass);
  border-color: var(--border-subtle);
  color: #fff;
}

.tools__job {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin: 0.4rem 0.8rem 0;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--c-primary-bg);
  border: 1px solid var(--c-primary-border);
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.tools__job--error {
  background: var(--c-error-bg);
  border-color: var(--c-error-border);
  color: var(--c-error);
}
.tools__job--done {
  background: var(--c-success-bg);
  border-color: var(--c-success-border);
}
.tools__job-kind { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.tools__job--error .tools__job-kind { color: var(--c-error); }
.tools__job-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tools__job-x {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
  font-size: 0.9rem;
  line-height: 1;
  padding: 0;
}
.tools__job-x:hover { opacity: 1; }

.tools__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.7rem 0.8rem 1.2rem;
}
.tools__error {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  color: var(--c-error);
}
</style>
