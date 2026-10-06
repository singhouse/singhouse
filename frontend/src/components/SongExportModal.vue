<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <Modal
    :visible="!!song"
    size="md"
    :closable="false"
    @close="onClose"
  >
    <div class="modal__header">
      <h3>Export</h3>
      <button
        v-if="!busy"
        class="modal__close"
        aria-label="Close"
        @click="onClose"
      >
        &times;
      </button>
    </div>

    <div
      v-if="savedPath"
      class="modal__body"
    >
      <span
        class="export-saved"
        :title="savedPath"
      >{{ savedPath }}</span>
    </div>

    <div
      v-else
      class="modal__body"
    >
      <div class="export-form">
        <span class="export-form__song">{{ songLabel }}</span>

        <fieldset
          class="export-group"
          :disabled="busy"
        >
          <legend>Format</legend>
          <div class="export-opts">
            <label
              v-for="opt in FORMATS"
              :key="opt.value"
              class="export-opt"
            >
              <input
                v-model="format"
                type="radio"
                name="export-format"
                :value="opt.value"
              >
              <span class="export-opt__text"><b>{{ opt.label }}</b><span>{{ opt.detail }}</span></span>
            </label>
          </div>
        </fieldset>

        <fieldset
          class="export-group"
          :disabled="busy"
        >
          <legend>Audio</legend>
          <div class="export-opts">
            <label
              v-for="opt in AUDIO"
              :key="opt.value"
              class="export-opt"
            >
              <input
                v-model="audio"
                type="radio"
                name="export-audio"
                :value="opt.value"
              >
              <span class="export-opt__text"><b>{{ opt.label }}</b><span>{{ opt.detail }}</span></span>
            </label>
          </div>
        </fieldset>

        <div class="export-field">
          <span class="export-field__label">Save to</span>
          <span class="export-path">
            <input
              class="export-path__input"
              type="text"
              readonly
              :value="folderLabel"
              :title="folderTitle"
              aria-label="Save to folder"
            >
            <Button
              v-if="desktop"
              variant="ghost"
              class="export-path__browse"
              :disabled="busy"
              @click="chooseFolder"
            >Browse…</Button>
          </span>
        </div>

        <span
          v-if="error"
          class="export-error"
        >{{ error }}</span>
      </div>
    </div>

    <div class="modal__footer">
      <template v-if="savedPath">
        <Button
          variant="primary"
          @click="onClose"
        >
          Done
        </Button>
      </template>
      <template v-else>
        <label class="toggle-opt export-defaults">
          <input
            v-model="saveDefaults"
            type="checkbox"
            :disabled="busy"
          >
          <span>Save as defaults</span>
        </label>
        <Button
          variant="ghost"
          :disabled="busy"
          @click="onClose"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          class="export-confirm"
          :disabled="busy || !formatAvailable"
          :title="formatAvailable ? undefined : 'Video export is not available yet'"
          @click="doExport"
        >
          {{ busy ? 'Exporting…' : 'Export' }}
        </Button>
      </template>
    </div>
  </Modal>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import Modal from '@/components/ui/Modal.vue'
import Button from '@/components/ui/Button.vue'
import { exportApi } from '@/api/client'

const props = defineProps({
  song: { type: Object, default: null },
})

const emit = defineEmits(['close'])

// `available` is false until the format's renderer exists; the card stays
// selectable so the remembered choice survives.
const FORMATS = [
  { value: 'video', label: 'Video', detail: '720p MP4', available: false },
  { value: 'mp3g', label: 'MP3+G (.zip)', detail: 'For traditional karaoke software', available: true },
]
const AUDIO = [
  { value: 'karaoke', label: 'Karaoke mix', detail: 'Instrumental and backing vocals' },
  { value: 'instrumental', label: 'Instrumental', detail: 'Instrumental only' },
]
const DEFAULTS_KEY = 'karaoke:exportDefaults'
const BROWSER_FOLDER = "Where your browser saves files"

const bridge = globalThis.window?.karaokeDesktop
const desktop = bridge?.isDesktop === true && typeof bridge.exportSong === 'function' ? bridge : null

const format = ref('video')
const audio = ref('karaoke')
const folder = ref({ path: '', label: '' })
const saveDefaults = ref(false)
const busy = ref(false)
const error = ref('')
const savedPath = ref('')
let openGeneration = 0

const songLabel = computed(() =>
  props.song ? (props.song.title || props.song.filename || 'Untitled') : ''
)
const formatAvailable = computed(() => FORMATS.find(f => f.value === format.value)?.available === true)
// The host sends both the folder and its display form; neither is ever sent
// back.
const folderLabel = computed(() => (desktop ? folder.value.label : BROWSER_FOLDER))
const folderTitle = computed(() => (desktop ? folder.value.path : BROWSER_FOLDER))

function applyDefaults(value) {
  if (FORMATS.some(f => f.value === value?.format)) format.value = value.format
  if (AUDIO.some(a => a.value === value?.audio)) audio.value = value.audio
  if (desktop && typeof value?.folder === 'string') {
    folder.value = { path: value.folder, label: typeof value.label === 'string' ? value.label : value.folder }
  }
}

function readBrowserDefaults() {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY)) } catch { return null }
}

// Electron prefixes errors thrown in the main process; show only the reason.
function bridgeMessage(e) {
  return String(e?.message || '').replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

// Re-arm the form each time the modal opens for a song.
watch(
  () => props.song,
  async (song) => {
    if (!song) return
    const generation = ++openGeneration
    format.value = 'video'
    audio.value = 'karaoke'
    folder.value = { path: '', label: '' }
    saveDefaults.value = false
    error.value = ''
    savedPath.value = ''
    busy.value = false
    if (!desktop) {
      applyDefaults(readBrowserDefaults())
      return
    }
    try {
      const value = await desktop.getExportDefaults()
      if (generation === openGeneration) applyDefaults(value)
    } catch (e) {
      if (generation === openGeneration) error.value = bridgeMessage(e) || 'Could not load export defaults'
    }
  },
  { immediate: true },
)

async function chooseFolder() {
  if (busy.value || !desktop) return
  error.value = ''
  try {
    const chosen = await desktop.chooseExportFolder()
    applyDefaults({ folder: chosen?.folder, label: chosen?.label })
  } catch (e) {
    error.value = bridgeMessage(e) || 'Could not choose a folder'
  }
}

// Called only after the file was saved. The export itself succeeded, so a
// failure to remember the choice is not reported as an export failure.
async function persistDefaults(value) {
  try {
    if (desktop) await desktop.saveExportDefaults(value)
    else localStorage.setItem(DEFAULTS_KEY, JSON.stringify(value))
  } catch { /* non-fatal */ }
}

// Prefer the RFC 5987 encoded form, then the plain quoted one; fall back to a
// name built from the song id when the header is absent or unparseable.
function filenameFromDisposition(value, fallback) {
  if (value) {
    const star = /filename\*=utf-8''([^;]+)/i.exec(value)
    if (star) {
      try { return decodeURIComponent(star[1].trim()) } catch { /* fall through */ }
    }
    const quoted = /filename="([^"]+)"/.exec(value)
    if (quoted) return quoted[1]
    const bare = /filename=([^;]+)/.exec(value)
    if (bare) return bare[1].trim()
  }
  return fallback
}

// A failed blob request carries its JSON detail inside a Blob. The client
// normally decodes this, but read it here too in case a raw axios error
// shape ever reaches us.
async function describeFailure(e) {
  const body = e?.response?.data
  if (typeof Blob !== 'undefined' && body instanceof Blob && typeof body.text === 'function') {
    try {
      const parsed = JSON.parse(await body.text())
      if (parsed?.detail) return { status: e.response.status, message: parsed.detail }
    } catch { /* fall through */ }
  }
  const status = e?.status ?? e?.response?.status
  return { status, message: e?.message || '' }
}

async function saveInBrowser(song) {
  const res = await exportApi.exportSong(song.id, {
    format: format.value,
    audio: audio.value,
    card: true,
  })

  const fallback = `export-song-${song.id}.zip`
  const disposition = typeof res.headers?.get === 'function'
    ? res.headers.get('content-disposition')
    : res.headers?.['content-disposition']
  const filename = filenameFromDisposition(disposition, fallback)

  // The anchor must be in the document for the programmatic click to
  // navigate everywhere, and the object URL must outlive the click —
  // an immediate revoke can abort the save in some browsers.
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function doExport() {
  if (busy.value || !props.song || !formatAvailable.value) return
  const song = props.song
  busy.value = true
  error.value = ''
  const choice = { format: format.value, audio: audio.value }
  const remember = saveDefaults.value
  try {
    if (desktop) {
      const result = await desktop.exportSong({ songId: song.id, ...choice })
      if (remember) await persistDefaults(choice)
      savedPath.value = result?.path || folderTitle.value
    } else {
      await saveInBrowser(song)
      if (remember) await persistDefaults(choice)
      emit('close')
    }
  } catch (e) {
    if (desktop) {
      const message = bridgeMessage(e)
      error.value = message || 'Export failed'
    } else {
      const { status, message } = await describeFailure(e)
      // A status means the server answered with a detail worth showing
      // verbatim (not ready, no word sync, capability not installed).
      // Anything else is transport-level: name the operation, then whatever
      // axios knows.
      error.value = status && message
        ? message
        : (message ? `Export failed: ${message}` : 'Export failed')
    }
  } finally {
    busy.value = false
  }
}

function onClose() {
  if (busy.value) return
  emit('close')
}
</script>

<style scoped>
.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.modal__header h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: white;
}
.modal__close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0 0.25rem;
  line-height: 1;
}
.modal__close:hover { color: white; }
.modal__body {
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.5;
  margin: 0 0 1.25rem;
}
.modal__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  align-items: center;
}
.export-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.export-form__song {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary, #fff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.export-group {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.export-group legend,
.export-field__label {
  padding: 0;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.4);
}
.export-group legend { margin: 0 0 0.35rem; }
.export-field__label { min-width: 3.2rem; }
.export-opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem;
}
@media (max-width: 520px) {
  .export-opts { grid-template-columns: 1fr; }
}
.export-opt {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
}
.export-opt:hover { background: rgba(255, 255, 255, 0.05); }
.export-opt:has(input:checked) {
  border-color: var(--c-primary-border);
  background: var(--c-primary-bg);
}
.export-group:disabled .export-opt { cursor: default; }
.export-opt input { accent-color: var(--c-primary, #e23e57); margin: 0.2rem 0 0; }
.export-opt__text b {
  display: block;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.88);
  font-weight: 600;
}
.export-opt__text span {
  display: block;
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.35;
}
.export-field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.export-path {
  display: flex;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
}
.export-path__input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.8);
  font-family: inherit;
  font-size: 0.78rem;
  line-height: 1.2;
  padding: 0.3rem 0.45rem;
  text-overflow: ellipsis;
  cursor: default;
}
.export-path__input:focus { outline: none; border-color: var(--c-primary-border); }
.export-path .export-path__browse { padding: 0.3rem 0.65rem; font-size: 0.75rem; }
.export-saved {
  display: block;
  font-size: 0.8rem;
  color: var(--text-primary, #fff);
  overflow-wrap: anywhere;
}
.toggle-opt {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
}
.toggle-opt input { accent-color: var(--c-primary, #e23e57); cursor: inherit; margin: 0; }
.toggle-opt input:disabled { cursor: default; }
.export-defaults { margin-right: auto; }
.export-error {
  font-size: 0.75rem;
  color: var(--c-error, #fb7f5c);
  line-height: 1.4;
}
</style>
