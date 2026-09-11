<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div ref="root" class="lt-lane" tabindex="0" @keydown="onKeydown">
    <!-- transport / word actions bar -->
    <div class="lt-bar">
      <button class="lt-btn" :title="playing ? 'Pause (Space)' : 'Play (Space)'" @click="$emit('toggle-play')">
        {{ playing ? '⏸' : '▶' }}
      </button>
      <label class="flex cursor-pointer select-none items-center gap-1 text-xs text-gray-400">
        <input
          type="checkbox"
          class="accent-primary"
          :checked="loopEnabled"
          @change="$emit('update:loopEnabled', $event.target.checked)"
        />
        loop line
      </label>
      <span class="font-mono text-xs text-gray-400">{{ fmt(currentTime) }}</span>
      <span class="text-xs text-gray-500">line {{ lineIdx + 1 }}/{{ doc.lines.length }} · {{ fmt(win.t0) }}–{{ fmt(win.t1) }}</span>

      <div class="grow"></div>

      <template v-if="selected != null && line[selected]">
        <span class="max-w-[10rem] truncate font-mono text-xs text-primary">“{{ line[selected].text }}”</span>
        <span class="font-mono text-[11px] text-gray-500">
          {{ fmt(line[selected].start) }} → {{ fmt(line[selected].end) }}
        </span>
        <button class="lt-btn" :disabled="selected === 0" title="Split line before this word (Enter)" @click="splitBeforeSelected">
          ⤓ split
        </button>
        <button class="lt-btn" title="Rename word (double-click)" @click="beginEdit(selected)">✎</button>
        <button class="lt-btn" title="Delete word (Del)" @click="deleteSelected">✕</button>
      </template>
      <span v-else class="text-[11px] text-gray-600">
        drag word edges to retime · drag body to move · dbl-click to rename · click background to seek · drag empty space to add a word
      </span>
    </div>

    <!-- the track: spectrogram + overlays -->
    <div ref="track" class="lt-track" @pointerdown="onTrackPointerDown">
      <canvas ref="canvas" class="absolute inset-0 h-full w-full"></canvas>

      <!-- time ruler -->
      <div
        v-for="tick in ticks"
        :key="tick.t"
        class="pointer-events-none absolute inset-y-0 border-l border-white/10"
        :style="{ left: pct(tick.t) + '%' }"
      >
        <span class="absolute left-0.5 top-0 font-mono text-[9px] text-gray-500">{{ tick.label }}</span>
      </div>

      <!-- neighbour-line ghosts (context, not editable) -->
      <div
        v-for="(g, i) in ghosts"
        :key="'g' + i"
        class="lt-ghost"
        :style="blockStyle(g)"
      >
        <span class="lt-label">{{ g.text }}</span>
      </div>

      <!-- word blocks -->
      <div
        v-for="(w, i) in laneWords"
        :key="i"
        class="lt-word"
        :class="{ 'is-selected': selected === i, 'is-interpolated': w.interpolated }"
        :style="blockStyle(w)"
        @pointerdown.stop="startDrag($event, i, 'move')"
        @click.stop="onBlockClick(i)"
        @dblclick.stop="beginEdit(i)"
      >
        <div class="lt-handle lt-handle-l" @pointerdown.stop="startDrag($event, i, 'start')"></div>
        <span class="lt-label">{{ w.text }}</span>
        <div class="lt-handle lt-handle-r" @pointerdown.stop="startDrag($event, i, 'end')"></div>
        <input
          v-if="editingIdx === i"
          ref="editInput"
          v-model="editText"
          class="lt-edit"
          @pointerdown.stop
          @click.stop
          @dblclick.stop
          @keydown.enter.stop.prevent="commitEdit"
          @keydown.esc.stop.prevent="cancelEdit"
          @blur="cancelEdit"
        />
      </div>

      <!-- new-word draft (drag out a span on empty space, then type) -->
      <div v-if="newWord" class="lt-word lt-new" :style="blockStyle(newWord)">
        <span v-if="newWord.phase === 'drag'" class="lt-label">+ word</span>
        <input
          v-if="newWord.phase === 'type'"
          ref="newInput"
          v-model="newWord.text"
          class="lt-edit"
          placeholder="word…"
          @pointerdown.stop
          @click.stop
          @dblclick.stop
          @keydown.enter.stop.prevent="commitNewWord"
          @keydown.esc.stop.prevent="cancelNewWord"
          @blur="cancelNewWord"
        />
      </div>

      <!-- playhead -->
      <div v-if="playheadPct != null" class="lt-playhead" :style="{ left: playheadPct + '%' }"></div>

      <div v-if="!samples" class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span class="rounded bg-black/40 px-2 py-1 text-xs text-gray-500">
          {{ audioNote || 'no audio — pick a stem to see the spectrogram' }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'

import { computeSpectrogram, drawSpectrogram } from '@/editor/spectrogram.js'

const props = defineProps({
  doc: { type: Object, required: true },
  lineIdx: { type: Number, required: true },
  samples: { type: Object, default: null }, // Float32Array (mono PCM)
  sampleRate: { type: Number, default: 44100 },
  currentTime: { type: Number, default: 0 },
  playing: { type: Boolean, default: false },
  loopEnabled: { type: Boolean, default: false },
  audioNote: { type: String, default: '' }, // e.g. "decoding audio…"
})

const emit = defineEmits(['op', 'seek', 'toggle-play', 'update:loopEnabled'])

const root = ref(null)
const track = ref(null)
const canvas = ref(null)

const MIN_WORD_DUR = 0.04

const line = computed(() => props.doc?.lines?.[props.lineIdx] ?? [])

// ─── window (line extent + padding, rounded so small nudges don't reflow) ───
const win = computed(() => {
  const times = line.value.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
  if (!times.length) return { t0: 0, t1: 5 }
  const s = Math.min(...times.map((w) => w.start))
  const e = Math.max(...times.map((w) => w.end))
  const pad = Math.min(3, Math.max(1, (e - s) * 0.25))
  return {
    t0: Math.max(0, Math.floor((s - pad) * 2) / 2),
    t1: Math.ceil((e + pad) * 2) / 2,
  }
})
const span = computed(() => Math.max(win.value.t1 - win.value.t0, 1e-3))

function pct(t) {
  return Math.min(100, Math.max(0, ((t - win.value.t0) / span.value) * 100))
}

// ─── selection / draft ──────────────────────────────────────────────────────
const selected = ref(null)
const draft = ref(null) // {idx, start, end} while dragging

const laneWords = computed(() =>
  line.value.map((w, i) =>
    draft.value && draft.value.idx === i ? { ...w, start: draft.value.start, end: draft.value.end } : w,
  ),
)

const ghosts = computed(() => {
  const out = []
  for (const li of [props.lineIdx - 1, props.lineIdx + 1]) {
    const l = props.doc?.lines?.[li]
    if (!l) continue
    for (const w of l) {
      if (Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > win.value.t0 && w.start < win.value.t1) {
        out.push(w)
      }
    }
  }
  return out
})

const ticks = computed(() => {
  const step = [0.25, 0.5, 1, 2, 5, 10].find((s) => span.value / s <= 16) ?? 30
  const out = []
  for (let t = Math.ceil(win.value.t0 / step) * step; t < win.value.t1; t += step) {
    out.push({ t, label: fmt(t) })
  }
  return out
})

const playheadPct = computed(() => {
  const t = props.currentTime
  if (t < win.value.t0 || t > win.value.t1) return null
  return pct(t)
})

function blockStyle(w) {
  const left = pct(w.start)
  const width = Math.max(0.25, pct(w.end) - left)
  return { left: `${left}%`, width: `${width}%` }
}

// Clamp selection when the doc changes under us (undo, merges elsewhere).
watch(
  () => [props.doc, props.lineIdx],
  () => {
    cancelEdit()
    draft.value = null
    newWord.value = null
    trackDrag = null
    if (selected.value != null && selected.value >= line.value.length) {
      selected.value = line.value.length ? line.value.length - 1 : null
    }
  },
)

// ─── dragging ───────────────────────────────────────────────────────────────
let dragState = null
let justDragged = false

function startDrag(e, idx, mode) {
  if (editingIdx.value !== null) return
  root.value?.focus()
  selected.value = idx
  const w = line.value[idx]
  if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) return
  dragState = { mode, idx, x0: e.clientX, orig: { start: w.start, end: w.end }, moved: false }
  e.currentTarget.setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag, { once: true })
}

function onDragMove(e) {
  if (!dragState) return
  const width = track.value?.clientWidth || 1
  const dt = ((e.clientX - dragState.x0) / width) * span.value
  if (Math.abs(e.clientX - dragState.x0) > 2) dragState.moved = true
  const { mode, idx, orig } = dragState
  let { start, end } = orig
  if (mode === 'move') {
    start = Math.max(0, orig.start + dt)
    end = start + (orig.end - orig.start)
  } else if (mode === 'start') {
    start = Math.min(Math.max(0, orig.start + dt), orig.end - MIN_WORD_DUR)
  } else {
    end = Math.max(orig.start + MIN_WORD_DUR, orig.end + dt)
  }
  draft.value = { idx, start, end }
}

function endDrag() {
  window.removeEventListener('pointermove', onDragMove)
  const d = draft.value
  const s = dragState
  justDragged = Boolean(s?.moved)
  dragState = null
  draft.value = null
  if (!d || !s?.moved) return
  const startDelta = d.start - s.orig.start
  const endDelta = d.end - s.orig.end
  if (Math.abs(startDelta) < 1e-4 && Math.abs(endDelta) < 1e-4) return
  emit('op', { type: 'nudgeWord', lineIdx: props.lineIdx, wordIdx: s.idx, startDelta, endDelta })
}

function onBlockClick(i) {
  if (justDragged) {
    justDragged = false
    return
  }
  selected.value = i
  const w = line.value[i]
  if (w && Number.isFinite(w.start)) emit('seek', Math.max(0, w.start - 0.3))
}

// ─── background: click = seek, drag on empty space = draw a new word ────────
const newWord = ref(null) // {start, end, phase: 'drag'|'type', text}
const newInput = ref(null)
let trackDrag = null // {t0: anchor time, x0, bounds?, creating}

function timeAtPointer(e) {
  const rect = track.value?.getBoundingClientRect()
  if (!rect || !rect.width) return null
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  return win.value.t0 + frac * span.value
}

/** Empty-gap bounds around time `t` within this line, or null when `t` is
 * inside an existing word (no room to draw). */
function gapBoundsAt(t) {
  let lo = win.value.t0
  let hi = win.value.t1
  for (const w of line.value) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    if (w.start < t && w.end > t) return null
    if (w.end <= t) lo = Math.max(lo, w.end)
    if (w.start >= t) hi = Math.min(hi, w.start)
  }
  return hi - lo >= MIN_WORD_DUR ? [lo, hi] : null
}

function onTrackPointerDown(e) {
  if (e.target.closest('.lt-word')) return
  root.value?.focus()
  const t = timeAtPointer(e)
  if (t == null) return
  emit('seek', t)
  trackDrag = { t0: t, x0: e.clientX, creating: false }
  window.addEventListener('pointermove', onTrackDragMove)
  window.addEventListener('pointerup', endTrackDrag, { once: true })
}

function onTrackDragMove(e) {
  if (!trackDrag) return
  if (!trackDrag.creating) {
    if (Math.abs(e.clientX - trackDrag.x0) <= 4) return
    const bounds = gapBoundsAt(trackDrag.t0)
    if (!bounds) return // anchored on/too close to an existing word
    trackDrag.creating = true
    trackDrag.bounds = bounds
  }
  const t = timeAtPointer(e)
  if (t == null) return
  const [lo, hi] = trackDrag.bounds
  const start = Math.min(Math.max(Math.min(trackDrag.t0, t), lo), hi)
  const end = Math.min(Math.max(Math.max(trackDrag.t0, t), lo), hi)
  newWord.value = { start, end, phase: 'drag', text: '' }
}

function endTrackDrag() {
  window.removeEventListener('pointermove', onTrackDragMove)
  const created = trackDrag?.creating
  trackDrag = null
  if (!created || !newWord.value) return
  if (newWord.value.end - newWord.value.start < MIN_WORD_DUR) {
    newWord.value = null
    return
  }
  newWord.value = { ...newWord.value, phase: 'type' }
  selected.value = null
  nextTick(() => {
    const el = Array.isArray(newInput.value) ? newInput.value[0] : newInput.value
    el?.focus()
  })
}

function commitNewWord() {
  const nw = newWord.value
  newWord.value = null
  const text = nw?.text?.trim()
  if (!nw || !text) return
  let idx = line.value.findIndex((w) => Number.isFinite(w.start) && w.start >= nw.end - 1e-6)
  if (idx === -1) idx = line.value.length
  emit('op', {
    type: 'insertWord',
    lineIdx: props.lineIdx,
    wordIdx: idx,
    text,
    start: nw.start,
    end: nw.end,
  })
}

function cancelNewWord() {
  newWord.value = null
}

// ─── inline word rename ─────────────────────────────────────────────────────
const editingIdx = ref(null)
const editText = ref('')
const editInput = ref(null)

function beginEdit(i) {
  selected.value = i
  editingIdx.value = i
  editText.value = line.value[i]?.text ?? ''
  nextTick(() => {
    const el = Array.isArray(editInput.value) ? editInput.value[0] : editInput.value
    el?.focus()
    el?.select()
  })
}

function commitEdit() {
  const i = editingIdx.value
  const text = editText.value.trim()
  editingIdx.value = null
  if (i == null || !text || text === line.value[i]?.text) return
  emit('op', { type: 'editWordText', lineIdx: props.lineIdx, wordIdx: i, text })
}

function cancelEdit() {
  editingIdx.value = null
}

// ─── word-level actions ─────────────────────────────────────────────────────
function splitBeforeSelected() {
  if (selected.value == null || selected.value < 1) return
  emit('op', { type: 'splitLine', lineIdx: props.lineIdx, wordIdx: selected.value })
}

function deleteSelected() {
  if (selected.value == null) return
  emit('op', { type: 'deleteWords', lineIdx: props.lineIdx, fromWordIdx: selected.value })
}

function onKeydown(e) {
  if (editingIdx.value !== null || newWord.value?.phase === 'type') return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      splitBeforeSelected()
      break
    case 'Delete':
      e.preventDefault()
      deleteSelected()
      break
    case 'ArrowLeft':
      if (line.value.length) {
        e.preventDefault()
        selected.value = selected.value == null ? line.value.length - 1 : Math.max(0, selected.value - 1)
      }
      break
    case 'ArrowRight':
      if (line.value.length) {
        e.preventDefault()
        selected.value = selected.value == null ? 0 : Math.min(line.value.length - 1, selected.value + 1)
      }
      break
    case 'Escape':
      selected.value = null
      break
  }
}

// ─── spectrogram rendering ──────────────────────────────────────────────────
const trackSize = ref({ w: 0, h: 0 })
let resizeObs = null

onMounted(() => {
  resizeObs = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect
    if (r) trackSize.value = { w: r.width, h: r.height }
  })
  if (track.value) resizeObs.observe(track.value)
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointermove', onTrackDragMove)
})

watchEffect(() => {
  const c = canvas.value
  const { w, h } = trackSize.value
  if (!c || !w || !h) return
  const dpr = window.devicePixelRatio || 1
  c.width = Math.max(1, Math.floor(w * dpr))
  c.height = Math.max(1, Math.floor(h * dpr))
  if (!props.samples) {
    const ctx = c.getContext('2d')
    ctx?.clearRect(0, 0, c.width, c.height)
    return
  }
  const spec = computeSpectrogram(props.samples, props.sampleRate, {
    t0: win.value.t0,
    t1: win.value.t1,
    maxFrames: Math.min(1600, Math.max(400, Math.floor(w))),
  })
  drawSpectrogram(c, spec)
})

function fmt(sec) {
  if (!Number.isFinite(sec)) return '–'
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}
</script>

<style scoped>
.lt-lane {
  outline: none;
  border: 1px solid #2a3040;
  border-radius: 0.5rem;
  background: #0a0a20;
  overflow: hidden;
}
.lt-lane:focus-within,
.lt-lane:focus {
  border-color: #3a3a70;
}
.lt-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border-bottom: 1px solid #2a3040;
  padding: 0.35rem 0.6rem;
}
.lt-btn {
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.15rem 0.5rem;
  font-size: 0.75rem;
  color: #d1d5db;
}
.lt-btn:hover:not(:disabled) {
  border-color: #e23e57;
}
.lt-btn:disabled {
  opacity: 0.4;
}
.lt-track {
  position: relative;
  height: 11rem;
  background: #08081a;
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.lt-ghost {
  position: absolute;
  top: 12%;
  bottom: 12%;
  pointer-events: none;
  border-radius: 0.25rem;
  border: 1px dashed rgba(156, 163, 175, 0.35);
  background: rgba(156, 163, 175, 0.08);
  overflow: hidden;
}
.lt-ghost .lt-label {
  color: rgba(156, 163, 175, 0.55);
}
.lt-word {
  position: absolute;
  top: 6%;
  bottom: 6%;
  border-radius: 0.25rem;
  border: 1px solid rgba(226, 62, 87, 0.55);
  background: rgba(226, 62, 87, 0.1);
  cursor: grab;
  overflow: visible;
}
.lt-word:hover {
  background: rgba(226, 62, 87, 0.18);
}
.lt-word.is-selected {
  border-color: #e23e57;
  background: rgba(226, 62, 87, 0.22);
  box-shadow: 0 0 0 1px rgba(226, 62, 87, 0.6);
  z-index: 2;
}
.lt-word.is-interpolated {
  border-color: rgba(251, 191, 36, 0.7);
  background: rgba(251, 191, 36, 0.12);
}
.lt-word.lt-new {
  border-style: dashed;
  border-color: rgba(247, 231, 200, 0.85);
  background: rgba(247, 231, 200, 0.18);
  cursor: default;
  z-index: 2;
}
.lt-label {
  position: absolute;
  top: 2px;
  left: 4px;
  right: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  font-size: 11px;
  color: #e5f9ff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
.lt-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  cursor: ew-resize;
  z-index: 1;
}
.lt-handle-l {
  left: -4px;
}
.lt-handle-r {
  right: -4px;
}
.lt-handle::after {
  content: '';
  position: absolute;
  top: 15%;
  bottom: 15%;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: rgba(226, 62, 87, 0.5);
  opacity: 0;
}
.lt-word:hover .lt-handle::after,
.lt-word.is-selected .lt-handle::after {
  opacity: 1;
}
.lt-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(235, 253, 255, 0.9);
  box-shadow: 0 0 4px rgba(226, 62, 87, 0.9);
  pointer-events: none;
  z-index: 3;
}
.lt-edit {
  position: absolute;
  inset: auto 2px 2px 2px;
  z-index: 4;
  border-radius: 0.25rem;
  border: 1px solid #e23e57;
  background: #141821;
  padding: 1px 4px;
  font-size: 11px;
  color: #e5e7eb;
  min-width: 3rem;
}
</style>
