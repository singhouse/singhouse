<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="flex min-h-0 grow flex-col">
    <!-- ── Toolbar ─────────────────────────────────────────────────────── -->
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <!-- audio stem picker -->
      <select
        v-if="stemOptions.length"
        v-model="audioStem"
        class="wb-select !max-w-[10rem]"
        title="Which stem plays under the lane"
      >
        <option value="">🔇 silent</option>
        <option v-for="o in stemOptions" :key="o.key" :value="o.key">🔊 {{ o.label }}</option>
      </select>
      <span v-if="player.loading.value" class="text-xs text-amber-300">decoding audio…</span>
      <span v-else-if="player.error.value" class="text-xs text-red-400">audio: {{ player.error.value }}</span>

      <div class="grow"></div>

      <template v-if="doc">
        <button
          class="wb-btn"
          :class="showPlayer && '!border-primary !text-primary'"
          title="Toggle the live canvas player preview"
          @click="showPlayer = !showPlayer"
        >
          ▤ Player
        </button>
        <button class="wb-btn" :disabled="!canUndo" title="Ctrl+Z" @click="undo">⟲ Undo</button>
        <button class="wb-btn" :disabled="!canRedo" title="Ctrl+Shift+Z" @click="redo">⟳ Redo</button>
        <span class="sv" :class="`sv--${saveStatus}`" aria-live="polite">{{ saveStatusText }}</span>

        <!-- validation badge -->
        <button
          class="rounded px-2 py-1 text-xs font-medium"
          :class="validation.errors.length
            ? 'bg-red-900/60 text-red-300'
            : validation.warnings.length
              ? 'bg-amber-900/60 text-amber-300'
              : 'bg-emerald-900/60 text-emerald-300'"
          @click="showIssues = !showIssues"
        >
          {{ validation.errors.length ? `${validation.errors.length} errors` : '✓ valid' }}{{ validation.warnings.length ? ` · ${validation.warnings.length} warn` : '' }}
        </button>

        <button class="wb-btn" @click="saveSessionFile">Export session</button>
        <button
          v-if="canSave"
          class="wb-btn !border-primary !text-primary disabled:!border-gray-600 disabled:!text-gray-500"
          :disabled="!dirty || validation.errors.length > 0 || saving"
          :title="validation.errors.length ? 'Fix validation errors first' : `Creates a new lyrics set from your edits and makes it the lyrics used for performances. Set #${setId} is kept unchanged.`"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save as new set and make active' }}
        </button>
      </template>
    </header>

    <div v-if="saveFailed" class="wb-failbox" role="alert">
      <div>
        <b>Save failed — nothing was changed.</b>
        {{ activeSetId ? `The active set is still #${activeSetId}, and your` : 'Your' }}
        {{ changesText(opCount) }} {{ opCount === 1 ? 'is' : 'are' }} still open here.
      </div>
      <div class="wb-failbox__why">Reason: {{ saveError }}.</div>
      <div class="wb-failbox__acts">
        <button
          class="wb-btn !border-primary !text-primary"
          :disabled="validation.errors.length > 0 || saving"
          @click="save"
        >Retry save</button>
        <button class="wb-btn" @click="saveSessionFile">Export session file (backup)</button>
      </div>
    </div>
    <p v-else-if="notice" class="mb-2 rounded bg-dark-600 px-3 py-2 text-sm" :class="noticeIsError ? 'text-red-300' : 'text-emerald-300'">
      {{ notice }}
    </p>

    <!-- validation issue list -->
    <div v-if="showIssues && doc" class="mb-2 max-h-40 shrink-0 overflow-y-auto rounded border border-dark-500 bg-dark-800 p-2 text-xs">
      <p v-if="!validation.errors.length && !validation.warnings.length" class="text-gray-500">No issues.</p>
      <p v-for="(iss, i) in [...validation.errors, ...validation.warnings]" :key="i" class="font-mono">
        <span :class="i < validation.errors.length ? 'text-red-400' : 'text-amber-400'">{{ iss.code }}</span>
        <span class="text-gray-500"> {{ iss.path }} </span>{{ iss.message }}
      </p>
    </div>

    <template v-if="doc">
      <div class="flex min-h-0 grow gap-3">
        <!-- line selector -->
        <section class="min-h-0 min-w-0 grow overflow-y-auto rounded-lg border border-dark-500 bg-dark-800">
          <div
            v-for="(l, i) in doc.lines"
            :key="i"
            :ref="(el) => (rowEls[i] = el)"
            class="ll-row"
            :class="{ 'is-active': i === selectedLine }"
            @click="selectLine(i)"
          >
            <span class="w-8 shrink-0 text-right font-mono text-[11px] text-gray-500">{{ i + 1 }}</span>
            <span class="w-28 shrink-0 font-mono text-[11px] text-gray-500">{{ lineRange(l) }}</span>
            <span class="truncate text-sm">{{ lineText(l) }}</span>
            <span
              v-if="lineIssues[i]"
              class="shrink-0 rounded px-1 text-[10px]"
              :class="lineIssues[i].errors ? 'bg-red-900/60 text-red-300' : 'bg-amber-900/60 text-amber-300'"
              :title="`${lineIssues[i].errors} errors, ${lineIssues[i].warnings} warnings on this line`"
              @click.stop="showIssues = true"
            >
              {{ lineIssues[i].errors || lineIssues[i].warnings }}
            </span>
            <span class="grow"></span>
            <button
              v-if="i > 0"
              class="ll-action"
              title="Merge this line into the previous one"
              @click.stop="mergeUp(i)"
            >
              ⤴ merge up
            </button>
          </div>
        </section>

        <!-- live canvas player preview (togglable) — the same KaraokeStage
             renderer the show uses, fed the edited doc re-parsed per op. -->
        <section
          v-if="showPlayer"
          class="flex w-2/5 max-w-2xl shrink-0 flex-col overflow-hidden rounded-lg border border-dark-500 bg-black"
        >
          <div class="min-h-0 grow">
            <KaraokeStage
              :model="stageModel"
              :current-time="previewTime"
              :playing="playing"
              visualizer="none"
            />
          </div>
          <p class="border-t border-dark-500 p-1.5 text-center text-[10px] text-gray-600">
            live canvas stage — the renderer the show uses
          </p>
        </section>
      </div>

      <!-- full-width single-line timing lane -->
      <section class="mt-3 shrink-0">
        <LineTimingLane
          :doc="doc"
          :line-idx="selectedLine"
          :samples="samples"
          :sample-rate="sampleRate"
          :current-time="previewTime"
          :playing="playing"
          v-model:loop-enabled="loopLine"
          :audio-note="audioNote"
          @op="apply"
          @seek="seek"
          @toggle-play="togglePlay"
        />
      </section>
    </template>
  </div>
</template>

<script setup>
// EditorWorkbench — the full word-timing editing surface (line selector +
// canvas-player preview + spectrogram timing lane + transport + save), shared
// by the production editor view and the dev-only lab. The parent supplies the
// raw word_sync doc and (when it came from the API) the song/set identity that
// makes saving possible; fixtures pass songId only so stems still play.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { lyricsSetsApi, songApi } from '@/api/client'
import LineTimingLane from '@/components/editor/LineTimingLane.vue'
import { useEditorSession } from '@/composables/useEditorSession'
import { useStemPlayer } from '@/composables/useStemPlayer'
import { docToLrc, docToPlain } from '@/editor/export.js'
import { docExtent, serializeDoc } from '@/editor/model.js'
import { normalizeWordSync } from '@/stage/adapter.mjs'
import { applyVoiceLayout } from '@/utils/voiceLayout.js'
import KaraokeStage from '@/stage/KaraokeStage.vue'

const props = defineProps({
  /** Raw word_sync payload to edit (either dialect). */
  wordSync: { type: Object, required: true },
  /** Song the doc belongs to — enables stem audio under the lane. */
  songId: { type: Number, default: null },
  /** Set the doc came from — enables "Save as new set". */
  setId: { type: Number, default: null },
  /** Human label of the source set, used in the saved set's label. */
  setLabel: { type: String, default: '' },
  /** The song's currently active set, named when a save fails. */
  activeSetId: { type: Number, default: null },
})

const emit = defineEmits(['saved'])

// ─── session ────────────────────────────────────────────────────────────────
const {
  load, apply, undo, redo, exportSession, trackSave,
  doc, canUndo, canRedo, dirty, opCount, validation, lastError, saveState, saveError,
} = useEditorSession()

const notice = ref('')
const noticeIsError = ref(false)
const showIssues = ref(false)

// Live canvas preview pane (right of the line list); sticky across reloads.
const showPlayer = ref(localStorage.getItem('editor.showPlayer') !== '0')
watch(showPlayer, (v) => localStorage.setItem('editor.showPlayer', v ? '1' : '0'))

const serialized = computed(() => (doc.value ? serializeDoc(doc.value) : null))

// Edited doc → renderer model, re-derived per op. A doc mid-edit can be
// transiently unparseable; the stage just shows its backdrop until it isn't.
const stageModel = computed(() => {
  if (!serialized.value) return null
  try {
    return applyVoiceLayout(normalizeWordSync(serialized.value), serialized.value)
  } catch {
    return null
  }
})

const canSave = computed(() => !!props.songId && !!props.setId)

function flash(msg, isError = false) {
  notice.value = msg
  noticeIsError.value = isError
}

// Surface ops rejected by the core (stale indices etc.) instead of failing silently.
watch(lastError, (e) => {
  if (e) flash(`Edit rejected: ${e}`, true)
})

// ─── line selection ─────────────────────────────────────────────────────────
const selectedLine = ref(0)
const rowEls = []

watch(doc, (d) => {
  if (!d) return
  if (selectedLine.value >= d.lines.length) selectedLine.value = d.lines.length - 1
})

watch(selectedLine, (i) => {
  rowEls[i]?.scrollIntoView({ block: 'nearest' })
})

function selectLine(i) {
  selectedLine.value = i
  const first = doc.value?.lines?.[i]?.find((w) => Number.isFinite(w.start))
  if (first) seek(Math.max(0, first.start - 0.3))
}

function mergeUp(i) {
  apply({ type: 'mergeLines', lineIdx: i - 1 })
  selectedLine.value = i - 1
}

const lineText = (l) => l.map((w) => w.text).join(' ')

function lineRange(l) {
  const times = l.filter((w) => Number.isFinite(w.start))
  if (!times.length) return '–'
  return `${fmt(times[0].start)}–${fmt(times[times.length - 1].end)}`
}

// Validation issues bucketed per line ("lines[3][2]..." paths).
const lineIssues = computed(() => {
  const out = {}
  const add = (iss, kind) => {
    const m = /^lines\[(\d+)\]/.exec(iss.path || '')
    if (!m) return
    const i = Number(m[1])
    out[i] = out[i] || { errors: 0, warnings: 0 }
    out[i][kind]++
  }
  validation.value.errors.forEach((i) => add(i, 'errors'))
  validation.value.warnings.forEach((i) => add(i, 'warnings'))
  return out
})

// ─── audio (decoded stem buffer → playback + spectrogram) ───────────────────
const STEM_PREF = ['lead_vocals', 'backing_vocals', 'karaoke', 'instrumental']
const STEM_LABELS = {
  lead_vocals: 'Lead vocals',
  backing_vocals: 'Backing vocals',
  karaoke: 'Karaoke mix',
  instrumental: 'Instrumental',
}

const player = useStemPlayer()
const audioStems = ref({}) // {stemKey: url} for the loaded doc's song
const audioStem = ref('') // picked stem key; '' = silent

const stemOptions = computed(() =>
  Object.keys(audioStems.value)
    .sort((a, b) => STEM_PREF.indexOf(a) - STEM_PREF.indexOf(b))
    .map((key) => ({ key, label: STEM_LABELS[key] ?? key })),
)

const samples = computed(() => (player.buffer.value ? player.monoSamples() : null))
const sampleRate = computed(() => player.buffer.value?.sampleRate ?? 44100)
const audioNote = computed(() =>
  player.loading.value ? 'decoding audio…' : player.error.value ? `audio failed: ${player.error.value}` : '',
)

// Audio follows the SONG, not the doc — switching sets of the same song keeps
// the decoded stem.
watch(
  () => props.songId,
  async (songId) => {
    audioStems.value = {}
    audioStem.value = '' // → watcher below unloads the player
    if (!songId) return
    try {
      const res = await songApi.get(songId)
      const stems = res.data?.stems ?? {}
      const avail = Object.fromEntries(Object.entries(stems).filter(([, url]) => typeof url === 'string' && url))
      if (!Object.keys(avail).length) return
      audioStems.value = avail
      audioStem.value = STEM_PREF.find((k) => avail[k]) ?? Object.keys(avail)[0]
    } catch {
      // Song deleted / not logged in — the lane just stays silent.
    }
  },
  { immediate: true },
)

watch(audioStem, (key) => {
  const wasPlaying = playing.value
  stopPlay()
  const url = audioStems.value[key]
  if (!url) {
    player.unload()
    return
  }
  player.loadUrl(url).then(() => {
    if (!player.buffer.value) return
    player.seek(previewTime.value)
    // The silent clock may have been (re)started while we were decoding.
    if (playing.value) player.play(previewTime.value)
    else if (wasPlaying) togglePlay()
  })
})

// ─── transport ──────────────────────────────────────────────────────────────
const previewTime = ref(0)
const playing = ref(false)
const loopLine = ref(false)
let rafId = null
let lastTick = 0

const extent = computed(() => {
  const docLen = doc.value ? docExtent(doc.value) : 0
  return Math.max(docLen, player.buffer.value?.duration ?? 0)
})

// Loop range = selected line extent with a lead-in/out margin.
const loopRange = computed(() => {
  const l = doc.value?.lines?.[selectedLine.value]
  const times = (l ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
  if (!times.length) return null
  const s = Math.min(...times.map((w) => w.start))
  const e = Math.max(...times.map((w) => w.end))
  return [Math.max(0, s - 0.3), e + 0.25]
})

watch([loopLine, loopRange, player.buffer], () => {
  player.setLoop(loopLine.value && loopRange.value ? loopRange.value : null)
})

// Natural end-of-buffer stops the transport.
watch(player.playing, (v) => {
  if (!v && playing.value && player.buffer.value) {
    playing.value = false
    previewTime.value = player.now()
  }
})

function tick(now) {
  if (!playing.value) return
  if (player.buffer.value) {
    previewTime.value = player.now()
  } else {
    previewTime.value += (now - lastTick) / 1000
    if (loopLine.value && loopRange.value && previewTime.value >= loopRange.value[1]) {
      previewTime.value = loopRange.value[0]
    }
    if (previewTime.value >= extent.value) {
      previewTime.value = extent.value
      playing.value = false
      return
    }
  }
  lastTick = now
  rafId = requestAnimationFrame(tick)
}

function togglePlay() {
  if (playing.value) {
    stopPlay()
    return
  }
  if (previewTime.value >= extent.value) previewTime.value = loopRange.value?.[0] ?? 0
  if (player.buffer.value) player.play(previewTime.value)
  playing.value = true
  lastTick = performance.now()
  rafId = requestAnimationFrame(tick)
}

function stopPlay() {
  playing.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  if (player.buffer.value) player.pause()
}

function seek(t) {
  previewTime.value = Math.max(0, t)
  player.seek(previewTime.value)
}

// ─── global keyboard ────────────────────────────────────────────────────────
function onGlobalKeydown(e) {
  const tag = e.target?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  if (!doc.value) return
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    e.shiftKey ? redo() : undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault()
    redo()
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === ' ') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (selectedLine.value > 0) selectLine(selectedLine.value - 1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (selectedLine.value < doc.value.lines.length - 1) selectLine(selectedLine.value + 1)
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopPlay()
  player.dispose()
})

// ─── doc loading ────────────────────────────────────────────────────────────
// Declared after the transport so the immediate run can reset it safely.
watch(
  () => props.wordSync,
  (ws) => {
    if (!ws) return
    try {
      load(ws)
      selectedLine.value = 0
      previewTime.value = 0
      stopPlay()
      flash('')
    } catch (err) {
      flash(`Could not load doc: ${err.message}`, true)
    }
  },
  { immediate: true },
)

// ─── export / save ──────────────────────────────────────────────────────────
function saveSessionFile() {
  const record = exportSession()
  if (!record) return
  const blob = new Blob(
    [JSON.stringify({ source: { songId: props.songId, setId: props.setId }, ...record }, null, 1)],
    { type: 'application/json' },
  )
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `editor-session-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

const saving = computed(() => saveState.value === 'saving')
const saveFailed = computed(() => saveState.value === 'failed' && dirty.value)

const changesText = (n) => (n === 1 ? '1 change' : `${n} changes`)

const saveStatus = computed(() => {
  if (saving.value) return 'saving'
  if (saveFailed.value) return 'failed'
  return dirty.value ? 'dirty' : 'clean'
})
const saveStatusText = computed(() => ({
  saving: 'Saving…',
  failed: 'Unsaved — last save failed',
  dirty: `Unsaved changes · ${changesText(opCount.value)}`,
  clean: 'No unsaved changes',
})[saveStatus.value])

/** Save the edits as a new active set. Resolves to the new set, or null when
 *  nothing was saved (the edits stay open). */
async function save() {
  if (!canSave.value || !doc.value || saving.value) return null
  const created = await trackSave(async () => {
    const wordSync = serializeDoc(doc.value)
    wordSync.metadata = {
      ...wordSync.metadata,
      edited_from_set: props.setId,
      editor: 'lyrics-editor',
      editor_ops: opCount.value,
    }
    const res = await lyricsSetsApi.create(props.songId, {
      source: 'manual',
      label: `edited from ${props.setLabel || `#${props.setId}`}`,
      plain_lyrics: docToPlain(doc.value),
      synced_lyrics: docToLrc(doc.value),
      word_sync_json: wordSync,
      metadata_json: wordSync.metadata,
      activate: true,
    })
    return res.data
  })
  if (!created) return null
  flash(`Saved as new active set #${created.id} ("${created.label}"). Original set untouched.`)
  emit('saved', created)
  return created
}

defineExpose({ dirty, opCount, saveState, saveError, validation, save, saveSessionFile })

function fmt(sec) {
  if (!Number.isFinite(sec)) return '–'
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}
</script>

<style scoped>
.wb-select {
  max-width: 20rem;
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
  color: #e5e7eb;
}
.wb-btn {
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  color: #d1d5db;
}
.wb-btn:hover:not(:disabled) {
  border-color: #e23e57;
}
.wb-btn:disabled {
  opacity: 0.4;
}
.sv {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 999px;
  border: 1px solid transparent;
  padding: 0.15rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
}
.sv--clean {
  color: #9ca3af;
  border-color: #2a3040;
}
.sv--dirty {
  color: #fcd34d;
  background: rgba(120, 53, 15, 0.45);
  border-color: rgba(251, 191, 36, 0.45);
}
.sv--failed {
  color: #fca5a5;
  background: rgba(127, 29, 29, 0.45);
  border-color: rgba(252, 165, 165, 0.45);
}
.sv--saving {
  color: #93c5fd;
  border-color: rgba(67, 133, 228, 0.5);
}
.sv--dirty::before,
.sv--failed::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fbbf24;
}
.sv--failed::before {
  background: #f87171;
}
.wb-failbox {
  margin-bottom: 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(252, 165, 165, 0.35);
  background: rgba(127, 29, 29, 0.25);
  padding: 0.6rem 0.75rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #fecaca;
}
.wb-failbox__why {
  margin-top: 0.125rem;
  font-size: 0.75rem;
  color: #fca5a5;
  opacity: 0.8;
}
.wb-failbox__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.ll-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.ll-row:hover {
  background: rgba(226, 62, 87, 0.05);
}
.ll-row.is-active {
  background: rgba(226, 62, 87, 0.1);
  border-left-color: #e23e57;
}
.ll-action {
  border-radius: 0.25rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0 0.4rem;
  font-size: 0.65rem;
  color: #9ca3af;
  opacity: 0;
}
.ll-row:hover .ll-action {
  opacity: 1;
}
.ll-action:hover {
  border-color: #e23e57;
  color: #e23e57;
}
</style>
