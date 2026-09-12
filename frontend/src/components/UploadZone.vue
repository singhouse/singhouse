<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="upload-zone-wrapper">
    <!-- Drop Zone -->
    <div
      class="drop-zone"
      role="button"
      aria-label="Upload an audio file or a karaoke video"
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
        accept=".mp3,.flac,.wav,.ogg,.m4a,.mp4,.webm,.mov,.mkv,audio/*,video/*"
        multiple
        class="hidden"
        @change="onFileSelect"
      />

      <div class="drop-zone__content">
        <!-- Animated Icon -->
        <div class="drop-zone__icon" :class="{ 'drop-zone__icon--pulse': isDragging }">
          <svg v-if="!isDragging" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <svg v-else width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e23e57" stroke-width="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>

        <div class="drop-zone__text">
          <p class="drop-zone__title">
            {{ isDragging ? 'Drop to upload' : 'Drop audio or video files here' }}
          </p>
          <p class="drop-zone__sub">
            or <span class="drop-zone__link">click to browse</span>
          </p>
          <p class="drop-zone__formats">MP3 · FLAC · WAV · M4A · OGG · up to 500MB</p>
          <p class="drop-zone__formats">
            or a karaoke video from your library — MP4 · WebM · MOV · MKV · up to 2GB
          </p>
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

    <!-- Pending files (metadata entry before upload) -->
    <TransitionGroup name="list" tag="div" class="upload-list">
      <div
        v-for="pending in pendingFiles"
        :key="pending.id"
        class="upload-item upload-item--pending"
      >
        <div class="upload-item__icon">
          <!-- Film frame for a karaoke video, note for audio — the host can see
               at a glance which of the two ingest paths a pending file takes. -->
          <svg v-if="pending.isVideo" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
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
              @keydown.enter="submitPending(pending)"
            />
            <span class="field-sep">—</span>
            <input
              v-model="pending.title"
              class="meta-input"
              type="text"
              placeholder="Title"
              @keydown.enter="submitPending(pending)"
            />
          </div>
          <p class="pending-filename">{{ pending.file.name }}</p>
        </div>
        <div class="pending-actions">
          <button class="btn-upload" :disabled="pending.submitting" @click="submitPending(pending)" title="Upload">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            </svg>
          </button>
          <button class="btn-cancel" @click="removePending(pending.id)" title="Cancel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
    </TransitionGroup>

    <!-- Ingest options (shown when AUDIO files are pending). They drive
         transcription and alignment, which a karaoke video has no use for —
         its lyrics are already in the picture — so a video-only batch hides
         them, and submitPending never sends them for a video. -->
    <div v-if="pendingAudioCount" class="ingest-options">
      <div class="ingest-options__toggles">
        <label class="toggle-opt toggle-opt--select" :title="karaokeModelHint">
          <span>Backing vocals</span>
          <select v-model="optKaraokeModel" class="model-select">
            <option v-for="m in KARAOKE_MODELS" :key="m.id" :value="m.id">
              {{ m.label }}
            </option>
          </select>
        </label>
        <label class="toggle-opt">
          <input type="checkbox" v-model="optLlmCorrection" />
          <span>LLM correction</span>
        </label>
        <label class="toggle-opt">
          <input type="checkbox" v-model="optLlmPaging" />
          <span>LLM paging</span>
        </label>
        <button
          class="btn-paste-toggle"
          @click="pasteOpen = !pasteOpen"
          :class="{ 'btn-paste-toggle--active': pasteOpen || optLyrics.trim() }"
        >
          {{ pasteOpen ? 'Hide lyrics' : 'Paste lyrics' }}
        </button>
      </div>
      <p class="ingest-options__hint">
        When third-party lyrics lookup is enabled, plain lyrics guide timing from
        your audio. Pasted lyrics take priority. Without a match, generation uses audio only.
      </p>
      <textarea
        v-show="pasteOpen"
        v-model="optLyrics"
        class="ingest-options__lyrics"
        placeholder="Paste reference lyrics to anchor alignment…"
        spellcheck="false"
        rows="4"
      ></textarea>
    </div>

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
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useSongsStore } from '@/stores/songs'
import { isRoutableUpload, routeUpload, validateUpload } from '@/utils/uploadRouting'
import { prepareHeart } from '@/composables/useHeartSetup'
import Badge from '@/components/ui/Badge.vue'
import { KARAOKE_MODELS, DEFAULT_KARAOKE_MODEL } from '@/utils/karaokeModels'

const store = useSongsStore()

const isDragging = ref(false)
const validationError = ref('')
const fileInput = ref(null)
const pendingFiles = ref([])

const optKaraokeModel = ref(DEFAULT_KARAOKE_MODEL)
const optLlmCorrection = ref(false)
const optLlmPaging = ref(false)
const optLyrics = ref('')
const pasteOpen = ref(false)
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

// Drives the ingest-options panel: transcription settings are meaningless for
// a video-only batch, so they only appear once an audio file is waiting.
const pendingAudioCount = computed(() => pendingFiles.value.filter(p => !p.isVideo).length)

const karaokeModelHint = computed(
  () => KARAOKE_MODELS.find(m => m.id === optKaraokeModel.value)?.hint || ''
)

function phaseLabel(upload) {
  if (upload.status === 'failed') return 'Failed'
  if (upload.status === 'done') return 'Ready'
  if (upload.status === 'uploading') return 'Uploading'
  return PHASE_LABELS[upload.phase] || PHASE_LABELS.processing
}

function onDragOver(e) {
  dragCounter++
  isDragging.value = true
}

function onDragLeave(e) {
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
  // Reset input so same file can be re-uploaded
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
  // rather than letting the server refuse it after the upload.
  const usableFiles = files.filter(isRoutableUpload)

  if (usableFiles.length === 0) {
    validationError.value = 'Please drop audio files (MP3, FLAC, WAV, M4A) or a karaoke video (MP4, WebM, MOV, MKV)'
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
    pendingFiles.value.push({
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      artist,
      title,
      isVideo: routeUpload(file) === 'video',
    })
  }
}

async function submitPending(pending) {
  if (pending.submitting || !pendingFiles.value.includes(pending)) return
  // A karaoke video already carries its lyrics; the transcription options
  // below belong to the audio path only and are not sent for one.
  if (pending.isVideo) {
    store.importVideoSong(pending.file, pending.artist, pending.title)
    removePending(pending.id)
    return
  }
  pending.submitting = true
  try {
    await prepareHeart()
    if (!pendingFiles.value.includes(pending)) return
    const opts = {}
  // Only a non-default pick is sent: the server owns what "default" means, and
  // it is configurable there (KARAOKE_MODEL), so echoing our own idea of it
  // would quietly override an operator's setting.
    if (optKaraokeModel.value !== DEFAULT_KARAOKE_MODEL) {
      opts.karaokeModel = optKaraokeModel.value
    }
    if (optLlmCorrection.value) opts.llmCorrection = true
    if (optLlmPaging.value) opts.llmPaging = true
    if (optLyrics.value.trim()) opts.plainLyrics = optLyrics.value.trim()
    store.uploadSong(pending.file, pending.artist, pending.title, opts)
    removePending(pending.id)
  } catch (error) {
    validationError.value = error.message
  } finally {
    pending.submitting = false
  }
}

function removePending(id) {
  pendingFiles.value = pendingFiles.value.filter(p => p.id !== id)
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
  padding: 2rem;
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
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  pointer-events: none;
}

.drop-zone__icon {
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

.drop-zone__text {
  text-align: center;
}
.drop-zone__title {
  font-size: 1.1rem;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
  margin-bottom: 0.25rem;
}
.drop-zone__sub {
  font-size: 0.875rem;
  color: rgba(255,255,255,0.45);
}
.drop-zone__link {
  color: #e23e57;
  text-decoration: underline;
  pointer-events: auto;
  cursor: pointer;
}
.drop-zone__formats {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: rgba(255,255,255,0.3);
  letter-spacing: 0.05em;
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
  flex-shrink: 0;
  color: rgba(255,255,255,0.5);
}
.upload-item--pending { border-color: rgba(226, 62, 87, 0.25); }
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
  font-size: 0.7rem;
  color: rgba(255,255,255,0.3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pending-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}
.btn-upload, .btn-cancel {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 0.375rem;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-upload {
  background: rgba(226, 62, 87, 0.15);
  color: #e23e57;
}
.btn-upload:hover {
  background: rgba(226, 62, 87, 0.3);
}
.btn-cancel {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.4);
}
.btn-cancel:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #fb7f5c;
}

.ingest-options {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.25rem;
}
.ingest-options__toggles {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
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
.ingest-options__lyrics {
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
.ingest-options__lyrics:focus {
  border-color: rgba(226, 62, 87, 0.4);
}
.ingest-options__lyrics::placeholder {
  color: rgba(255,255,255,0.2);
}
</style>
