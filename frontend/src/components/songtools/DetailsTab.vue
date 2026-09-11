<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="det">
    <section class="det__block">
      <h4 class="det__h">Metadata</h4>
      <label class="det__field">
        <span>Artist</span>
        <input v-model="artist" type="text" placeholder="Unknown Artist" />
      </label>
      <label class="det__field">
        <span>Title</span>
        <input v-model="title" type="text" placeholder="Unknown Title" />
      </label>
      <div class="det__actions">
        <button class="det__go" :disabled="!dirty || saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button class="det__ghost" :disabled="!dirty || saving" @click="reset">Revert</button>
      </div>
      <p v-if="notice" class="det__notice" :class="{ 'det__notice--error': noticeIsError }">
        {{ notice }}
      </p>
    </section>

    <section class="det__block">
      <h4 class="det__h">Facts</h4>
      <dl class="det__facts">
        <div class="det__fact"><dt>Status</dt><dd>{{ statusText }}</dd></div>
        <div class="det__fact"><dt>Duration</dt><dd>{{ durationText }}</dd></div>
        <div class="det__fact"><dt>Added</dt><dd>{{ addedText }}</dd></div>
        <div class="det__fact"><dt>File</dt><dd class="det__mono">{{ song?.filename || '—' }}</dd></div>
        <div class="det__fact"><dt>Song ID</dt><dd class="det__mono">{{ songId }}</dd></div>
      </dl>
    </section>

    <!-- A failed ingest used to be a dead row: the options were chosen in the
         upload form, the form is gone, and the file is no longer where the
         browser could re-send it. Retry replays the original job. -->
    <section v-if="isFailed" class="det__block det__block--bad">
      <h4 class="det__h">Ingest failed</h4>
      <p class="det__err">{{ song?.error_message || 'No error message was recorded.' }}</p>
      <button class="det__go" :disabled="retryBlocked" @click="retry">Retry ingest</button>
    </section>

    <section v-else-if="isProcessing" class="det__block">
      <h4 class="det__h">Progress</h4>
      <p class="det__proc">
        <span>{{ phaseText }}</span>
        <span v-if="song?.progress != null" class="det__pct">{{ song.progress }}%</span>
      </p>
    </section>

    <!-- Outside the failed block on purpose. Both lines are about the JOB, and
         a successful retry flips the row to `processing` within a second of
         the click — inside, they would vanish on the very click that produced
         them, taking with them the one notice that says this run is not the
         run the operator originally asked for. -->
    <p v-if="retryBlocked" class="det__why">A job is already running for this song.</p>
    <p v-if="optionsFallback" class="det__why">
      The original ingest options could not be read back — this retry ran on
      server defaults.
    </p>
  </div>
</template>

<script setup>
// The Details tab: the metadata the host can correct, the facts they cannot,
// and — for a song whose ingest failed — the error and the way out of it.
import { computed, ref, watch } from 'vue'
import { useSongsStore } from '@/stores/songs'
import { formatServerDateTime } from '@/utils/serverTime'

const props = defineProps({
  songId: { type: Number, required: true },
  song:   { type: Object, default: null },
})

const emit = defineEmits(['refresh'])

const store = useSongsStore()

const artist = ref('')
const title = ref('')
const saving = ref(false)
const notice = ref('')
const noticeIsError = ref(false)

// Re-seed whenever the song this tab is showing changes underneath it — an
// edit in progress on song A must never be saved onto song B.
watch(() => [props.songId, props.song?.artist, props.song?.title], () => {
  if (saving.value) return
  artist.value = props.song?.artist || ''
  title.value = props.song?.title || ''
}, { immediate: true })

const dirty = computed(
  () => artist.value !== (props.song?.artist || '') || title.value !== (props.song?.title || '')
)

function reset() {
  artist.value = props.song?.artist || ''
  title.value = props.song?.title || ''
  notice.value = ''
}

async function save() {
  if (!dirty.value || saving.value) return
  saving.value = true
  notice.value = ''
  try {
    await store.updateSongMeta(props.songId, {
      artist: artist.value,
      title: title.value,
    })
    noticeIsError.value = false
    notice.value = 'Saved.'
    emit('refresh')
  } catch (e) {
    noticeIsError.value = true
    notice.value = e.message
  } finally {
    saving.value = false
  }
}

const PHASE_LABELS = {
  uploading: 'Uploading',
  queued: 'Queued',
  importing: 'Importing',
  separating: 'Separating stems',
  fetching_lyrics: 'Fetching lyrics',
  transcribing: 'Transcribing',
  aligning: 'Aligning words',
  done: 'Ready',
  failed: 'Failed',
}

const isFailed = computed(() => props.song?.status === 'failed')
const isProcessing = computed(
  () => props.song?.status === 'processing' || props.song?.status === 'uploading'
)

const statusText = computed(() => props.song?.status || '—')
const phaseText = computed(() => {
  const phase = props.song?.phase
  if (!phase) return props.song?.message || 'Processing…'
  return PHASE_LABELS[phase] || phase
})
const durationText = computed(() => {
  const seconds = props.song?.duration
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
})
const addedText = computed(() => formatServerDateTime(props.song?.created_at) || '—')

const retryBlocked = computed(() => store.isJobRunning(props.songId))

// `options_recovered: false` means the retry ran on server defaults because no
// ingest job survived to replay. Worth offering, not worth passing off as a
// faithful re-run — so it is said out loud.
const optionsFallback = computed(() => {
  const job = store.jobFor(props.songId)
  return job?.kind === 'retry' && job.envelope?.options_recovered === false
})

function retry() {
  if (retryBlocked.value) return
  store.startRetryIngest(props.songId)
}

defineExpose({ artist, title, dirty, save, retry, retryBlocked })
</script>

<style scoped>
.det { display: flex; flex-direction: column; gap: 1rem; }
.det__block { display: flex; flex-direction: column; gap: 0.4rem; }
.det__block--bad {
  padding: 0.55rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--c-error-border);
  background: var(--c-error-bg);
}
.det__h {
  margin: 0;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-muted);
}
.det__field { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.66rem; color: var(--text-muted); }
.det__field input {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  padding: 0.35rem 0.45rem;
  font-size: 0.82rem;
  outline: none;
}
.det__field input:focus { border-color: var(--c-primary-border); }
.det__actions { display: flex; gap: 0.4rem; }
.det__go {
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--c-primary);
  color: #0a0a1a;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
}
.det__go:hover:not(:disabled) { background: var(--c-primary-hover); }
.det__go:disabled { opacity: 0.45; cursor: not-allowed; }
.det__ghost {
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-light);
  background: var(--bg-glass);
  color: var(--text-secondary);
  font-size: 0.78rem;
  cursor: pointer;
}
.det__ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.det__notice { margin: 0; font-size: 0.72rem; color: var(--text-secondary); }
.det__notice--error { color: var(--c-error); }

.det__facts { margin: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.det__fact { display: flex; gap: 0.5rem; font-size: 0.74rem; }
.det__fact dt { flex: 0 0 5.5rem; color: var(--text-muted); }
.det__fact dd { margin: 0; color: var(--text-primary); min-width: 0; overflow-wrap: anywhere; }
.det__mono { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; }

.det__err {
  margin: 0;
  font-size: 0.74rem;
  color: var(--c-error);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.det__why { margin: 0; font-size: 0.68rem; color: var(--text-muted); line-height: 1.35; }
.det__proc { margin: 0; display: flex; gap: 0.5rem; font-size: 0.78rem; color: var(--text-secondary); }
.det__pct { color: var(--c-primary); font-variant-numeric: tabular-nums; }
</style>
