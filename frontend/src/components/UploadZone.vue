<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="upload-zone-wrapper">
    <!-- Drop Zone -->
    <div
      class="drop-zone"
      role="button"
      aria-label="Add audio or karaoke video files"
      tabindex="0"
      :class="{
        'drop-zone--active': isDragging,
        'drop-zone--error': validationError
      }"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
      @click="openFilePicker"
      @keydown.enter="openFilePicker"
      @keydown.space.prevent="openFilePicker"
    >
      <input
        ref="fileInput"
        type="file"
        accept=".mp3,.flac,.wav,.ogg,.m4a,.mp4,.webm,.mov,.mkv,.cdg,.zip,audio/*,video/*"
        multiple
        class="hidden"
        @change="onFileSelect"
      />

      <div class="drop-zone__content">
        <div class="drop-zone__icon" :class="{ 'drop-zone__icon--pulse': isDragging }" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p class="drop-zone__title">
          Drop audio or karaoke video files here, or <span class="drop-zone__link">browse</span>
        </p>
      </div>
      <div class="dz-routes">
        <div class="dz-route">
          <b class="dz-route__label dz-route__label--ready">READY TO PLAY</b>
          <span>Karaoke video MP4 · WebM · MOV · MKV up to 2GB · CDG up to 30 min · MP3+G ZIP up to 550MB</span>
        </div>
        <div class="dz-route">
          <b class="dz-route__label">NEEDS PROCESSING</b>
          <span>Audio MP3 · FLAC · WAV · M4A · OGG up to 500MB · processed on this computer</span>
        </div>
      </div>

      <!-- Drag overlay -->
      <div v-if="isDragging" class="drop-zone__overlay" />
    </div>

    <!-- Validation error -->
    <transition name="slide-up">
      <div v-if="validationError" class="upload-error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        {{ validationError }}
      </div>
    </transition>

    <!-- Selected files, grouped by whether they need processing. Prepared
         video and CDG already carry their words, so they get no lyrics
         control; each audio row carries its own reference lyrics. -->
    <section
      v-for="group in groups"
      :key="group.key"
      class="pending-group"
      :class="`pending-group--${group.key}`"
      :aria-labelledby="`pending-group-${group.key}`"
    >
      <h3 :id="`pending-group-${group.key}`" class="group-head">{{ group.label }}</h3>
      <TransitionGroup name="list" tag="div" class="upload-list">
        <div
          v-for="pending in group.rows"
          :key="pending.id"
          class="upload-item upload-item--pending"
          :data-kind="pending.isPrepared ? 'prepared' : 'audio'"
        >
          <div class="row-main">
            <div class="upload-item__icon" aria-hidden="true">
              <svg v-if="pending.isPrepared" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5"/>
              </svg>
              <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M9 18V5l12-2v13"/>
                <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </div>
            <div class="upload-item__fields">
              <div class="field-row">
                <input
                  v-model="pending.artist"
                  class="meta-input"
                  type="text"
                  placeholder="Artist"
                  aria-label="Artist"
                  @change="lookupLyrics(pending)"
                  @keydown.enter="submitAll"
                />
                <span class="field-sep">—</span>
                <input
                  v-model="pending.title"
                  class="meta-input"
                  type="text"
                  placeholder="Title"
                  aria-label="Title"
                  @change="lookupLyrics(pending)"
                  @keydown.enter="submitAll"
                />
              </div>
              <div class="row-meta">
                <p class="pending-filename">{{ rowFacts(pending) }}</p>
                <span v-if="!pending.isPrepared" class="row-lyrics">
                  <span class="lyr-chip" :class="chipClass(pending)">{{ chipLabel(pending) }}</span>
                  <button
                    class="btn-paste-toggle"
                    :class="{ 'btn-paste-toggle--active': pending.lyricsOpen || pending.lyrics.trim() }"
                    type="button"
                    :aria-expanded="String(pending.lyricsOpen)"
                    :aria-controls="`lyr-${pending.id}`"
                    @click="toggleLyrics(pending)"
                  >
                    {{ pending.lyricsOpen ? 'Hide lyrics' : (pending.lrclibText ? 'Show lyrics' : 'Paste lyrics') }}
                  </button>
                </span>
              </div>
            </div>
            <button
              class="btn-cancel"
              type="button"
              title="Remove"
              :aria-label="`Remove ${pending.title || pending.file.name}`"
              @click="removePending(pending.id)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <template v-if="!pending.isPrepared">
            <div v-show="pending.lyricsOpen" :id="`lyr-${pending.id}`" class="row-panel">
              <textarea
                v-model="pending.lyrics"
                class="lyrics-box"
                rows="4"
                spellcheck="false"
                :aria-label="`Lyrics for ${pending.title || pending.file.name}`"
                placeholder="Paste reference lyrics to anchor alignment…"
              ></textarea>
            </div>
            <p v-if="lyricsState(pending) === 'none'" class="row-warn">
              Without reference lyrics, timing and words may be transcribed incorrectly. Paste lyrics for best results.
            </p>
          </template>
        </div>
      </TransitionGroup>
    </section>

    <!-- Active Uploads -->
    <TransitionGroup name="list" tag="div" class="upload-list">
      <div
        v-for="upload in store.uploads"
        :key="upload.id"
        class="upload-item"
        :class="`upload-item--${upload.status}`"
      >
        <div class="upload-item__icon">
          <!-- Spinner for uploading/processing -->
          <svg v-if="upload.status === 'uploading' || upload.status === 'processing'"
            class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          <!-- Check for done -->
          <svg v-else-if="upload.status === 'done'"
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f2cf7a" stroke-width="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <!-- X for failed -->
          <svg v-else-if="upload.status === 'failed'"
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fb7f5c" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </div>

        <div class="upload-item__info">
          <p class="upload-item__name">{{ upload.filename }}</p>
          <div class="upload-item__status-row">
            <Badge :variant="upload.status === 'done' ? 'ready' : upload.status">
              {{ phaseLabel(upload) }}
            </Badge>
            <span v-if="upload.message && upload.status === 'processing'" class="upload-item__phase-msg">
              {{ upload.message }}
            </span>
            <span v-if="upload.error" class="upload-item__error">{{ upload.error }}</span>
          </div>
        </div>

        <!-- Progress bar -->
        <div v-if="upload.status === 'uploading' || upload.status === 'processing'" class="upload-item__progress"
          role="progressbar"
          :aria-valuenow="upload.progress"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${upload.filename} upload progress`"
        >
          <div class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: upload.progress + '%' }"
            />
          </div>
          <span class="progress-pct">{{ upload.progress }}%</span>
        </div>
      </div>
    </TransitionGroup>

    <div class="upload-footer">
      <!-- Ingest options are only for audio that needs processing. -->
      <template v-if="pendingAudioCount">
        <label class="toggle-opt toggle-opt--select" :title="karaokeModelHint">
          <span>Backing vocals</span>
          <select v-model="optKaraokeModel" class="model-select">
            <option v-for="m in KARAOKE_MODELS" :key="m.id" :value="m.id">
              {{ m.label }}
            </option>
          </select>
        </label>
        <label v-if="features.llmPagingEnabled" class="toggle-opt">
          <input type="checkbox" v-model="optLlmPaging" />
          <span>LLM paging</span>
        </label>
      </template>
      <Button class="upload-footer__cancel" variant="ghost" @click="cancel">Cancel</Button>
      <Button
        class="upload-footer__add"
        variant="primary"
        :disabled="!pendingFiles.length || submitting"
        @click="submitAll"
      >{{ addLabel }}</Button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { songApi } from '@/api/client'
import { useFeaturesStore } from '@/stores/features'
import { useSongsStore } from '@/stores/songs'
import {
  isRoutableUpload, routeUpload, validateUpload, probeMediaDuration, formatDuration,
} from '@/utils/uploadRouting'
import { prepareHeart } from '@/composables/useHeartSetup'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { KARAOKE_MODELS, DEFAULT_KARAOKE_MODEL } from '@/utils/karaokeModels'

const emit = defineEmits(['close'])

const store = useSongsStore()
const features = useFeaturesStore()
features.load()

const isDragging = ref(false)
const validationError = ref('')
const fileInput = ref(null)
const pendingFiles = ref([])
const submitting = ref(false)

const optKaraokeModel = ref(DEFAULT_KARAOKE_MODEL)
const optLlmPaging = ref(false)
let dragCounter = 0

// Route choice, allowlists and size caps all live in @/utils/uploadRouting —
// the two ingest routes each have a server-side allowlist behind them and the
// rules are worth testing on their own. See that file's header.

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
  processing: 'Processing',
}

// Drives the footer's ingest options: transcription settings are meaningless
// for a video-only batch, so they only appear once an audio file is waiting.
const pendingAudioCount = computed(() => pendingFiles.value.filter(p => !p.isPrepared).length)

const groups = computed(() => [
  { key: 'ready', label: 'Ready to play', rows: pendingFiles.value.filter(p => p.isPrepared) },
  { key: 'process', label: 'Needs processing', rows: pendingFiles.value.filter(p => !p.isPrepared) },
].filter(g => g.rows.length))

const addLabel = computed(() => {
  const n = pendingFiles.value.length
  return n === 1 ? 'Add 1 file' : `Add ${n} files`
})

const karaokeModelHint = computed(
  () => KARAOKE_MODELS.find(m => m.id === optKaraokeModel.value)?.hint || ''
)

function phaseLabel(upload) {
  if (upload.status === 'failed') return 'Failed'
  if (upload.status === 'done') return 'Ready'
  if (upload.status === 'uploading') return 'Uploading'
  return PHASE_LABELS[upload.phase] || PHASE_LABELS.processing
}

// name · duration · size; the duration only once the probe has found it.
function rowFacts(row) {
  const parts = [row.file.name]
  if (row.duration) parts.push(formatDuration(row.duration))
  parts.push(formatSize(row.file.size))
  return parts.join(' · ')
}

function formatSize(bytes) {
  const mb = (Number(bytes) || 0) / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 100) return `${Math.round(mb)} MB`
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(mb * 1024))} KB`
}

// ── Per-file reference lyrics ────────────────────────────────────────────
// Each audio row owns its lyrics text. `lrclibText` is the unedited text the
// lookup returned (empty when there was no lookup or no match), so the row
// can tell a match from the user's own pasted or edited text.

function lyricsState(row) {
  const text = row.lyrics.trim()
  if (!text) return row.lookup === 'loading' ? 'loading' : 'none'
  if (row.lrclibText) return text === row.lrclibText ? 'lrclib' : 'edited'
  return 'pasted'
}

const CHIP_LABELS = {
  loading: 'Looking up…',
  none: 'No reference lyrics',
  lrclib: 'Lyrics: LRCLIB match',
  edited: 'Lyrics: edited',
  pasted: 'Lyrics: pasted',
}

function chipLabel(row) {
  return CHIP_LABELS[lyricsState(row)]
}

function chipClass(row) {
  const state = lyricsState(row)
  if (state === 'lrclib') return 'lyr-chip--lrclib'
  if (state === 'edited' || state === 'pasted') return 'lyr-chip--have'
  return ''
}

// Only the user's own text is sent. An unedited match is left out so ingest
// runs its own lookup exactly as it does for any other file.
function plainLyricsFor(row) {
  const state = lyricsState(row)
  return state === 'pasted' || state === 'edited' ? row.lyrics.trim() : ''
}

async function toggleLyrics(row) {
  row.lyricsOpen = !row.lyricsOpen
  if (!row.lyricsOpen) return
  await nextTick()
  document.getElementById(`lyr-${row.id}`)?.querySelector('textarea')?.focus()
}

async function lookupLyrics(row) {
  if (row.isPrepared || !features.lyricsLookupEnabled) return
  // The user's own text always wins; never replace it with a lookup.
  const state = lyricsState(row)
  if (state === 'pasted' || state === 'edited') return
  const artist = row.artist.trim()
  const title = row.title.trim()
  const key = `${artist}\n${title}`
  if (key === row.lookupKey) return
  row.lookupKey = key
  const seq = (row.lookupSeq || 0) + 1
  row.lookupSeq = seq
  // A match for the previous artist/title no longer describes this file.
  if (state === 'lrclib') row.lyrics = ''
  row.lrclibText = ''
  if (!artist || !title) {
    row.lookup = 'idle'
    return
  }
  row.lookup = 'loading'
  try {
    const res = await songApi.lookupLyrics(artist, title)
    if (row.lookupSeq !== seq) return
    const text = res.data?.found ? String(res.data.plain_lyrics || '').trim() : ''
    if (text && !row.lyrics.trim()) {
      row.lrclibText = text
      row.lyrics = text
    }
  } catch {
    // A failed lookup reads the same as no match.
  } finally {
    if (row.lookupSeq === seq) row.lookup = 'done'
  }
}

// Flags usually load before the first drop; if they land later, look up the
// rows already waiting.
watch(() => features.lyricsLookupEnabled, (on) => {
  if (on) pendingFiles.value.forEach(lookupLyrics)
})

function onDragOver() {
  dragCounter++
  isDragging.value = true
}

function onDragLeave() {
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragging.value = false
  }
}

function onDrop(e) {
  dragCounter = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer.files)
  processFiles(files)
}

function openFilePicker() {
  fileInput.value?.click()
}

function onFileSelect(e) {
  const files = Array.from(e.target.files)
  processFiles(files)
  // Reset input so the same file can be picked again
  e.target.value = ''
}

function parseArtistTitle(filename) {
  const stem = filename.replace(/\.[^.]+$/, '')
  if (stem.includes(' - ')) {
    const [artist, ...rest] = stem.split(' - ')
    return { artist: artist.trim(), title: rest.join(' - ').trim() }
  }
  return { artist: '', title: stem }
}

function processFiles(files) {
  validationError.value = ''

  // Mixed batches are fine — each file is routed on its own below. A file that
  // is not media at all is ignored the way a stray file in a multi-select
  // always has been; one the browser calls video in a container we cannot
  // import is NOT ignored — it stays in the list so validateUpload can name it
  // rather than letting the server refuse it after the transfer.
  const usableFiles = files.filter(isRoutableUpload)

  if (usableFiles.length === 0) {
    validationError.value = 'Please drop audio, a CDG or MP3+G ZIP, or a karaoke video from your library'
    setTimeout(() => { validationError.value = '' }, 4000)
    return
  }

  for (const file of usableFiles) {
    const err = validateUpload(file)
    if (err) {
      validationError.value = err
      setTimeout(() => { validationError.value = '' }, 5000)
      return
    }
  }

  // Add files to pending list for metadata entry
  for (const file of usableFiles) {
    const { artist, title } = parseArtistTitle(file.name)
    const route = routeUpload(file)
    const row = reactive({
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      artist,
      title,
      isVideo: route === 'video',
      isCdg: route === 'cdg',
      isPrepared: ['video', 'cdg'].includes(route),
      lyrics: '',
      lyricsOpen: false,
      lrclibText: '',
      lookup: 'idle',
      lookupKey: null,
      lookupSeq: 0,
      duration: null,
    })
    pendingFiles.value.push(row)
    lookupLyrics(row)
    if (route === 'audio' || route === 'video') {
      probeMediaDuration(file)
        .then(d => { if (d) row.duration = d })
        .catch(() => {})
    }
  }
}

async function submitAll() {
  if (submitting.value || !pendingFiles.value.length) return
  submitting.value = true
  validationError.value = ''
  try {
    // Prepared video and CDG already carry their words in the picture; the
    // transcription options and lyrics belong only to separable audio.
    for (const pending of pendingFiles.value.filter(p => p.isPrepared)) {
      if (pending.isVideo) store.importVideoSong(pending.file, pending.artist, pending.title)
      else store.importCdgSong(pending.file, pending.artist, pending.title)
      removePending(pending.id)
    }
    const audio = pendingFiles.value.slice()
    if (!audio.length) return
    await prepareHeart()
    const base = {}
    // Only a non-default pick is sent: the server owns what "default" means, and
    // it is configurable there (KARAOKE_MODEL), so echoing our own idea of it
    // would quietly override an operator's setting.
    if (optKaraokeModel.value !== DEFAULT_KARAOKE_MODEL) {
      base.karaokeModel = optKaraokeModel.value
    }
    if (features.llmPagingEnabled && optLlmPaging.value) base.llmPaging = true
    // Rows removed while setup was running are not sent.
    for (const pending of audio) {
      if (!pendingFiles.value.includes(pending)) continue
      const opts = { ...base }
      const lyrics = plainLyricsFor(pending)
      if (lyrics) opts.plainLyrics = lyrics
      store.uploadSong(pending.file, pending.artist, pending.title, opts)
      removePending(pending.id)
    }
  } catch (error) {
    validationError.value = error.message
  } finally {
    submitting.value = false
  }
}

function removePending(id) {
  pendingFiles.value = pendingFiles.value.filter(p => p.id !== id)
}

function cancel() {
  pendingFiles.value = []
  validationError.value = ''
  emit('close')
}
</script>

<style scoped>
.upload-zone-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.drop-zone {
  position: relative;
  border: 2px dashed rgba(255,255,255,0.15);
  border-radius: 1rem;
  padding: 1.25rem 1rem;
  cursor: pointer;
  transition: all 0.25s ease;
  background: rgba(255,255,255,0.02);
  overflow: hidden;
}

.drop-zone:hover {
  border-color: rgba(226, 62, 87, 0.4);
  background: rgba(226, 62, 87, 0.03);
}

.drop-zone--active {
  border-color: #e23e57;
  background: rgba(226, 62, 87, 0.06);
  transform: scale(1.01);
}

.drop-zone--error {
  border-color: rgba(239, 68, 68, 0.5);
}

.drop-zone__overlay {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, rgba(226,62,87,0.08) 0%, transparent 70%);
  pointer-events: none;
}

.drop-zone__content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  pointer-events: none;
}

.drop-zone__icon {
  display: flex;
  color: rgba(255,255,255,0.3);
  transition: color 0.25s, transform 0.25s;
}
.drop-zone--active .drop-zone__icon {
  color: #e23e57;
  transform: translateY(-4px);
}
.drop-zone__icon--pulse {
  animation: iconBounce 0.6s ease-in-out infinite alternate;
}
@keyframes iconBounce {
  from { transform: translateY(-4px) scale(1); }
  to   { transform: translateY(-8px) scale(1.05); }
}

.drop-zone__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
}
.drop-zone__link {
  color: #e23e57;
  text-decoration: underline;
  pointer-events: auto;
  cursor: pointer;
}
.dz-routes {
  margin: 0.8rem auto 0;
  display: grid;
  gap: 0.35rem;
  width: max-content;
  max-width: 100%;
  text-align: left;
  pointer-events: none;
}
.dz-route {
  display: grid;
  grid-template-columns: 118px 1fr;
  gap: 0.6rem;
  align-items: baseline;
  font-size: 0.74rem;
  color: rgba(255,255,255,0.4);
  white-space: nowrap;
}
.dz-route__label {
  font-size: 0.7rem;
  letter-spacing: 0.03em;
  color: rgba(255,255,255,0.55);
}
.dz-route__label--ready {
  color: var(--c-success);
}

/* Selected-file groups */
.pending-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.group-head {
  margin: 0.35rem 0.25rem -0.1rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255,255,255,0.55);
}

/* Error */
.upload-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.5rem;
  font-size: 0.85rem;
  color: #fb7f5c;
}

/* Upload list */
.upload-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.upload-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.07);
  transition: all 0.2s;
}
.upload-item--uploading { border-color: rgba(96, 165, 250, 0.3); }
.upload-item--processing { border-color: rgba(251, 191, 36, 0.3); }
.upload-item--done { border-color: rgba(242, 207, 122, 0.3); }
.upload-item--failed { border-color: rgba(239, 68, 68, 0.3); }

.upload-item__icon {
  display: flex;
  flex-shrink: 0;
  color: rgba(255,255,255,0.5);
}
.upload-item--pending {
  flex-direction: column;
  align-items: stretch;
  gap: 0.4rem;
  border-color: rgba(226, 62, 87, 0.25);
}
.upload-item--pending .upload-item__icon { color: #e23e57; }
.upload-item--uploading .upload-item__icon { color: #60a5fa; }
.upload-item--processing .upload-item__icon { color: #fbbf24; }

.upload-item__info {
  flex: 1;
  min-width: 0;
}
.upload-item__name {
  font-size: 0.875rem;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upload-item__status-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.2rem;
}
.upload-item__error {
  font-size: 0.75rem;
  color: #fb7f5c;
}
.upload-item__phase-msg {
  font-size: 0.7rem;
  color: rgba(255,255,255,0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 30ch;
}

.upload-item__progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.progress-track {
  position: relative;
  width: 80px;
  height: 4px;
  background: rgba(255,255,255,0.1);
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: #e23e57;
  border-radius: 2px;
  transition: width 0.3s ease;
}
.progress-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(226,62,87,0.4) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: shimmerSlide 1.2s linear infinite;
}
@keyframes shimmerSlide {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.progress-pct {
  font-size: 0.75rem;
  color: rgba(255,255,255,0.4);
  min-width: 2.5rem;
  text-align: right;
}

/* Pending file metadata entry */
.upload-item__fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.field-sep {
  color: rgba(255,255,255,0.25);
  flex-shrink: 0;
}
.meta-input {
  flex: 1;
  min-width: 0;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 0.375rem;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  color: rgba(255,255,255,0.9);
  outline: none;
  transition: border-color 0.2s;
}
.meta-input::placeholder {
  color: rgba(255,255,255,0.3);
}
.meta-input:focus {
  border-color: rgba(226, 62, 87, 0.5);
}
.pending-filename {
  margin: 0;
  min-width: 0;
  font-size: 0.7rem;
  color: rgba(255,255,255,0.3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-main {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 22px;
}
.row-lyrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.row-panel {
  padding-left: calc(20px + 0.75rem);
  padding-right: calc(32px + 0.75rem);
}
.row-warn {
  margin: 0;
  padding-left: calc(20px + 0.75rem);
  font-size: 0.72rem;
  line-height: 1.4;
  color: rgba(251, 191, 36, 0.7);
}
.lyr-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.68rem;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid var(--border-subtle);
  background: var(--bg-glass);
  color: var(--text-muted);
}
.lyr-chip--have {
  background: var(--c-success-bg);
  color: var(--c-success);
  border-color: var(--c-success-border);
}
.lyr-chip--lrclib {
  background: var(--c-info-bg);
  color: var(--c-info);
  border-color: var(--c-info-border);
}
.btn-cancel {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 0.375rem;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.4);
}
.btn-cancel:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #fb7f5c;
}

.upload-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.upload-footer > .toggle-opt:first-child {
  margin-right: auto;
}
.toggle-opt {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  color: rgba(255,255,255,0.6);
  cursor: pointer;
}
.toggle-opt input {
  accent-color: #e23e57;
}
.toggle-opt--select {
  gap: 0.4rem;
}
.model-select {
  font-size: 0.72rem;
  padding: 0.15rem 0.35rem;
  border-radius: 0.3rem;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.8);
  cursor: pointer;
  outline: none;
}
.model-select:focus {
  border-color: rgba(226, 62, 87, 0.4);
}
/* The popup list is drawn by the OS, not by this stylesheet — without an
   explicit dark background the options render as black-on-black wherever the
   UA paints the list from the control's own colours. */
.model-select option {
  background: #1a1c20;
  color: rgba(255,255,255,0.9);
}
.btn-paste-toggle {
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  border-radius: 0.3rem;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  transition: all 0.15s;
}
.btn-paste-toggle:hover {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.8);
}
.btn-paste-toggle--active {
  border-color: rgba(226, 62, 87, 0.4);
  color: #e23e57;
}
.lyrics-box {
  box-sizing: border-box;
  width: 100%;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 0.4rem;
  color: rgba(255,255,255,0.9);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  padding: 0.5rem;
  resize: vertical;
  outline: none;
}
.lyrics-box:focus {
  border-color: rgba(226, 62, 87, 0.4);
}
.lyrics-box::placeholder {
  color: rgba(255,255,255,0.25);
}
.btn-paste-toggle:focus-visible,
.btn-cancel:focus-visible {
  outline: 2px solid rgba(226, 62, 87, 0.7);
  outline-offset: 2px;
}

@media (max-width: 560px) {
  .row-meta { flex-wrap: wrap; }
  .row-lyrics { margin-left: 0; }
  .dz-route { white-space: normal; grid-template-columns: 1fr; gap: 0.1rem; }
  .row-panel, .row-warn { padding-left: 0; padding-right: 0; }
}
</style>
