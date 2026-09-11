<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div
    ref="rootRef"
    class="regroup-editor select-none outline-none"
    tabindex="0"
    @keydown="onKeydown"
  >
    <p class="mb-2 text-xs text-gray-500">
      Click a gap → <kbd>Enter</kbd> splits · caret at line start + <kbd>Backspace</kbd> merges up ·
      double-click a word to edit · <kbd>Delete</kbd> removes selected word · <kbd>i</kbd> inserts at caret
    </p>

    <div
      v-for="(line, li) in doc.lines"
      :key="li"
      class="re-line group flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-dark-700/50"
    >
      <span class="w-20 shrink-0 text-right font-mono text-[10px] text-gray-500">
        {{ li + 1 }} · {{ fmtTime(line[0]?.start) }}
      </span>

      <div class="flex flex-wrap items-center">
        <template v-for="(w, wi) in line" :key="`${li}-${wi}`">
          <!-- gap before word wi; gap 0 doubles as the merge-up handle -->
          <span
            class="re-gap"
            :class="{ 'is-caret': isCaret(li, wi), 'is-merge': wi === 0 && li > 0 }"
            :title="wi === 0 ? (li > 0 ? 'Backspace: merge into previous line' : '') : 'Enter: split here'"
            @click.stop="setCaret(li, wi)"
          ></span>

          <input
            v-if="isEditing(li, wi)"
            ref="editInputRef"
            v-model="editDraft"
            class="re-edit-input"
            :style="{ width: `${Math.max(editDraft.length, 2) + 1}ch` }"
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="cancelEdit"
            @click.stop
          />
          <span
            v-else
            class="re-chip"
            :class="{
              'is-selected': isSelected(li, wi),
              'is-interpolated': w.interpolated,
              'is-filler': isFiller(w.text),
            }"
            :title="`${fmtTime(w.start)} – ${fmtTime(w.end)}${w.interpolated ? ' (interpolated)' : ''}`"
            @click.stop="selectWord(li, wi, w)"
            @dblclick.stop="startEdit(li, wi, w)"
          >{{ w.text }}</span>
        </template>

        <!-- trailing gap (caret position line.length): insert point, no split -->
        <span
          class="re-gap"
          :class="{ 'is-caret': isCaret(li, line.length) }"
          @click.stop="setCaret(li, line.length)"
        ></span>

        <input
          v-if="inserting && inserting.lineIdx === li"
          ref="insertInputRef"
          v-model="insertDraft"
          class="re-edit-input"
          placeholder="new word"
          :style="{ width: `${Math.max(insertDraft.length, 8) + 1}ch` }"
          @keydown.enter.prevent="commitInsert"
          @keydown.esc.prevent="cancelInsert"
          @blur="cancelInsert"
          @click.stop
        />
      </div>
    </div>
  </div>
</template>

<script setup>
// Thin keyboard/mouse layer over the pure ops: every mutation leaves this
// component as an emitted op object; the parent owns the session (apply,
// undo/redo) and passes the resulting doc back down.

import { nextTick, ref, watch } from 'vue'

const props = defineProps({
  doc: { type: Object, required: true }, // canonical editor doc (model.js)
})
const emit = defineEmits(['op', 'seek', 'undo', 'redo'])

const rootRef = ref(null)
const editInputRef = ref(null)
const insertInputRef = ref(null)

// caret sits in a gap: before word `gapIdx` of line `lineIdx` (0..line.length)
const caret = ref(null) // {lineIdx, gapIdx}
const selected = ref(null) // {lineIdx, wordIdx}
const editing = ref(null) // {lineIdx, wordIdx}
const editDraft = ref('')
const inserting = ref(null) // {lineIdx, gapIdx}
const insertDraft = ref('')

const isFiller = (text) => text === '[*]' || text === '.'
const isCaret = (li, gi) => caret.value?.lineIdx === li && caret.value?.gapIdx === gi
const isSelected = (li, wi) => selected.value?.lineIdx === li && selected.value?.wordIdx === wi
const isEditing = (li, wi) => editing.value?.lineIdx === li && editing.value?.wordIdx === wi

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1)
  return `${m}:${String(s).padStart(4, '0')}`
}

// Doc changed under us (op applied, undo, new doc loaded): clamp stale refs.
watch(
  () => props.doc,
  (doc) => {
    const clampLine = (li) => Math.min(li, doc.lines.length - 1)
    if (caret.value) {
      const li = clampLine(caret.value.lineIdx)
      caret.value = { lineIdx: li, gapIdx: Math.min(caret.value.gapIdx, doc.lines[li].length) }
    }
    if (selected.value) {
      const li = clampLine(selected.value.lineIdx)
      const wi = Math.min(selected.value.wordIdx, doc.lines[li].length - 1)
      selected.value = { lineIdx: li, wordIdx: wi }
    }
    editing.value = null
    inserting.value = null
  },
)

function setCaret(lineIdx, gapIdx) {
  caret.value = { lineIdx, gapIdx }
  selected.value = null
  rootRef.value?.focus()
}

function selectWord(lineIdx, wordIdx, word) {
  selected.value = { lineIdx, wordIdx }
  caret.value = { lineIdx, gapIdx: wordIdx + 1 }
  emit('seek', word.start)
  rootRef.value?.focus()
}

function startEdit(lineIdx, wordIdx, word) {
  editing.value = { lineIdx, wordIdx }
  editDraft.value = word.text
  nextTick(() => editInputRef.value?.[0]?.focus?.() ?? editInputRef.value?.focus?.())
}

function commitEdit() {
  if (!editing.value) return
  const { lineIdx, wordIdx } = editing.value
  const text = editDraft.value.trim()
  const current = props.doc.lines[lineIdx]?.[wordIdx]?.text
  editing.value = null
  if (text && text !== current) emit('op', { type: 'editWordText', lineIdx, wordIdx, text })
}

function cancelEdit() {
  editing.value = null
}

function startInsert() {
  if (!caret.value) return
  inserting.value = { ...caret.value }
  insertDraft.value = ''
  nextTick(() => insertInputRef.value?.[0]?.focus?.() ?? insertInputRef.value?.focus?.())
}

function commitInsert() {
  if (!inserting.value) return
  const { lineIdx, gapIdx } = inserting.value
  const text = insertDraft.value.trim()
  inserting.value = null
  if (text) emit('op', { type: 'insertWord', lineIdx, wordIdx: gapIdx, text })
}

function cancelInsert() {
  inserting.value = null
}

function moveCaret(dLine, dGap) {
  if (!caret.value) {
    caret.value = { lineIdx: 0, gapIdx: 0 }
    return
  }
  let { lineIdx, gapIdx } = caret.value
  if (dGap) {
    gapIdx += dGap
    if (gapIdx < 0 && lineIdx > 0) {
      lineIdx -= 1
      gapIdx = props.doc.lines[lineIdx].length
    } else if (gapIdx > props.doc.lines[lineIdx].length && lineIdx < props.doc.lines.length - 1) {
      lineIdx += 1
      gapIdx = 0
    }
    gapIdx = Math.max(0, Math.min(gapIdx, props.doc.lines[lineIdx].length))
  }
  if (dLine) {
    lineIdx = Math.max(0, Math.min(lineIdx + dLine, props.doc.lines.length - 1))
    gapIdx = Math.min(gapIdx, props.doc.lines[lineIdx].length)
  }
  caret.value = { lineIdx, gapIdx }
  selected.value = null
}

function onKeydown(e) {
  if (editing.value || inserting.value) return // inputs handle their own keys

  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    emit(e.shiftKey ? 'redo' : 'undo')
    return
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    emit('redo')
    return
  }

  switch (e.key) {
    case 'Enter': {
      const c = caret.value
      if (c && c.gapIdx > 0 && c.gapIdx < props.doc.lines[c.lineIdx].length) {
        e.preventDefault()
        emit('op', { type: 'splitLine', lineIdx: c.lineIdx, wordIdx: c.gapIdx })
        caret.value = { lineIdx: c.lineIdx + 1, gapIdx: 0 }
      }
      break
    }
    case 'Backspace': {
      const c = caret.value
      if (c && c.gapIdx === 0 && c.lineIdx > 0) {
        e.preventDefault()
        const prevLen = props.doc.lines[c.lineIdx - 1].length
        emit('op', { type: 'mergeLines', lineIdx: c.lineIdx - 1 })
        caret.value = { lineIdx: c.lineIdx - 1, gapIdx: prevLen }
      }
      break
    }
    case 'Delete': {
      const s = selected.value
      if (s) {
        e.preventDefault()
        emit('op', { type: 'deleteWords', lineIdx: s.lineIdx, fromWordIdx: s.wordIdx })
        selected.value = null
      }
      break
    }
    case 'F2': {
      const s = selected.value
      if (s) {
        e.preventDefault()
        startEdit(s.lineIdx, s.wordIdx, props.doc.lines[s.lineIdx][s.wordIdx])
      }
      break
    }
    case 'i':
      e.preventDefault()
      startInsert()
      break
    case 'ArrowLeft':
      e.preventDefault()
      moveCaret(0, -1)
      break
    case 'ArrowRight':
      e.preventDefault()
      moveCaret(0, 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      moveCaret(-1, 0)
      break
    case 'ArrowDown':
      e.preventDefault()
      moveCaret(1, 0)
      break
    case 'Escape':
      selected.value = null
      caret.value = null
      break
  }
}
</script>

<style scoped>
.re-gap {
  display: inline-block;
  width: 7px;
  height: 1.4em;
  margin: 0 1px;
  border-radius: 2px;
  cursor: pointer;
  vertical-align: middle;
}
.re-gap:hover {
  background: rgba(226, 62, 87, 0.35);
}
.re-gap.is-caret {
  background: #e23e57;
  animation: caret-blink 1.1s steps(1) infinite;
}
.re-gap.is-merge:hover {
  background: rgba(247, 231, 200, 0.5);
}
@keyframes caret-blink {
  50% {
    opacity: 0.25;
  }
}

.re-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
  font-size: 0.85rem;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}
.re-chip:hover {
  border-color: rgba(226, 62, 87, 0.6);
}
.re-chip.is-selected {
  background: rgba(226, 62, 87, 0.2);
  border-color: #e23e57;
}
.re-chip.is-interpolated {
  border-color: rgba(245, 158, 11, 0.6);
  background: rgba(245, 158, 11, 0.1);
}
.re-chip.is-filler {
  opacity: 0.35;
  font-style: italic;
}

.re-edit-input {
  background: #141821;
  border: 1px solid #e23e57;
  border-radius: 5px;
  color: #fff;
  font-size: 0.85rem;
  padding: 1px 6px;
  outline: none;
}

kbd {
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-bottom-width: 2px;
  border-radius: 3px;
  font-size: 0.7rem;
  background: rgba(255, 255, 255, 0.05);
}
</style>
