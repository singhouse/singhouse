<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <Modal
    :visible="!!song"
    title="Export CD+G"
    :confirmLabel="busy ? 'Exporting…' : 'Export'"
    confirmVariant="primary"
    :closable="!busy"
    @close="onClose"
    @confirm="doExport"
  >
    <span class="export-form">
      <span class="export-form__song">{{ songLabel }}</span>

      <span class="export-field">
        <span class="export-field__label">Format</span>
        <label class="toggle-opt">
          <input type="radio" value="mp3g" v-model="format" :disabled="busy" />
          <span>MP3+G (.zip)</span>
        </label>
        <label class="toggle-opt">
          <input type="radio" value="cdg" v-model="format" :disabled="busy" />
          <span>CD+G only (.cdg)</span>
        </label>
      </span>

      <span v-if="format === 'mp3g'" class="export-field">
        <span class="export-field__label">Audio</span>
        <label class="toggle-opt">
          <input type="radio" value="karaoke" v-model="audio" :disabled="busy" />
          <span>Karaoke mix</span>
        </label>
        <label class="toggle-opt">
          <input type="radio" value="instrumental" v-model="audio" :disabled="busy" />
          <span>Instrumental</span>
        </label>
      </span>

      <span class="export-field">
        <label class="toggle-opt">
          <input
            type="checkbox"
            :checked="cardChecked"
            :disabled="busy || settingsLoading"
            @change="onCardToggle($event.target.checked)"
          />
          <span>Include attribution card</span>
        </label>
      </span>

      <span v-if="error" class="export-error">{{ error }}</span>
    </span>
  </Modal>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import Modal from '@/components/ui/Modal.vue'
import { exportApi } from '@/api/client'

const props = defineProps({
  song: { type: Object, default: null },
})

const emit = defineEmits(['close'])

const format = ref('mp3g')
const audio = ref('karaoke')
const cardChecked = ref(true)
const settingsLoading = ref(false)
const busy = ref(false)
const error = ref('')

const songLabel = computed(() =>
  props.song ? (props.song.title || props.song.filename || 'Untitled') : ''
)

// Re-arm the form each time the modal opens for a song. The attribution-card
// preference is server-side, so it is fetched fresh (checked by default while
// the answer is in flight).
watch(
  () => props.song,
  async (song) => {
    if (!song) return
    format.value = 'mp3g'
    audio.value = 'karaoke'
    error.value = ''
    busy.value = false
    cardChecked.value = true
    settingsLoading.value = true
    try {
      const res = await exportApi.getSettings()
      if (typeof res.data?.attribution_card === 'boolean') {
        cardChecked.value = res.data.attribution_card
      }
    } catch {
      // Leave the checked default; the server applies its stored setting
      // either way, and the export itself never sends an override.
    } finally {
      settingsLoading.value = false
    }
  },
  { immediate: true },
)

// Persist on toggle — optimistic, reverted if the server refuses. The export
// request itself carries no card flag; the stored setting is the authority.
async function onCardToggle(checked) {
  const previous = cardChecked.value
  cardChecked.value = checked
  try {
    await exportApi.setSettings(checked)
  } catch (e) {
    cardChecked.value = previous
    error.value = e?.message ? `Could not save setting: ${e.message}` : 'Could not save setting'
  }
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

async function doExport() {
  if (busy.value || !props.song) return
  busy.value = true
  error.value = ''
  try {
    const res = await exportApi.exportSong(props.song.id, {
      format: format.value,
      audio: format.value === 'mp3g' ? audio.value : undefined,
    })

    const fallback = `export-song-${props.song.id}.${format.value === 'cdg' ? 'cdg' : 'zip'}`
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

    emit('close')
  } catch (e) {
    const { status, message } = await describeFailure(e)
    // A status means the server answered with a detail worth showing verbatim
    // (not ready, no word sync, capability not installed). Anything else is
    // transport-level: name the operation, then whatever axios knows.
    error.value = status && message
      ? message
      : (message ? `Export failed: ${message}` : 'Export failed')
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
.export-field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.export-field__label {
  min-width: 3.2rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.4);
}
.toggle-opt {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
}
.toggle-opt input { accent-color: var(--c-primary, #e23e57); cursor: inherit; }
.toggle-opt input:disabled { cursor: default; }
.export-error {
  font-size: 0.75rem;
  color: var(--c-error, #fb7f5c);
  line-height: 1.4;
}
</style>
