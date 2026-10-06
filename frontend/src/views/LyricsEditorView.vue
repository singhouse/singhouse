<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="flex h-screen flex-col overflow-hidden bg-dark-900 p-4 text-gray-100">
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <router-link
        to="/"
        class="rounded border border-dark-500 bg-dark-800 px-2 py-1 text-xs text-gray-300 hover:border-primary hover:text-primary"
        title="Back to the host view"
      >← Library</router-link>
      <h1 class="text-lg font-semibold text-primary">Lyrics Editor</h1>
      <span v-if="song" class="truncate text-sm text-gray-300">
        {{ song.artist }} — {{ song.title }}
      </span>

      <!-- set switcher -->
      <select
        v-if="sets.length"
        ref="setSelect"
        :value="setId ?? 0"
        class="ed-select"
        title="Which lyrics set to edit"
        @change="switchSet($event)"
      >
        <option :value="0" disabled>Pick lyrics set…</option>
        <option v-for="ls in sets" :key="ls.id" :value="ls.id" :disabled="!ls.has_word_sync">
          #{{ ls.id }} {{ ls.source }}{{ ls.label ? ` · ${ls.label}` : '' }}{{ ls.is_active ? ' · active' : '' }}{{ ls.has_word_sync ? '' : ' (no word sync)' }}
        </option>
      </select>

      <button
        v-if="setId"
        class="ed-btn"
        :disabled="busy"
        title="Duplicate this set and edit the copy (original stays untouched and active)"
        @click="duplicateSet"
      >⧉ Duplicate set</button>

      <!-- With no active set there is nothing for this workbench to be the
           right tool for: the way forward is a version to edit, and that is
           what Song tools makes. -->
      <button
        v-if="!hasActiveSet && songId"
        class="ed-btn"
        title="Lyrics versions, re-fit, re-split and metadata for this song"
        @click="openTools"
      >⚙ Song tools</button>
    </header>

    <p v-if="notice" class="mb-2 rounded bg-dark-600 px-3 py-2 text-sm" :class="noticeIsError ? 'text-red-300' : 'text-emerald-300'">
      {{ notice }}
    </p>

    <div v-if="loading" class="mt-24 text-center text-gray-500">
      <p class="text-xl">Loading…</p>
    </div>

    <EditorWorkbench
      v-else-if="wordSync"
      ref="workbench"
      :word-sync="wordSync"
      :song-id="songId"
      :set-id="setId"
      :set-label="setLabel"
      :active-set-id="activeSetId"
      @saved="onSaved"
    />

    <div v-else class="mt-24 text-center text-gray-500">
      <p class="text-xl">This song has no editable lyrics set.</p>
      <p class="mt-2 text-sm">
        Only sets with word-level sync can be edited here — make one in Song
        tools first, with “Listen again” or by pasting lyrics.
      </p>
      <button v-if="songId" class="ed-btn mt-4" @click="openTools">⚙ Open Song tools</button>
    </div>

    <!-- Same panel the library shows, docked to the right of the workbench.
         Fixed rather than a flex sibling: this view fills the viewport and its
         columns are the editor's own. -->
    <aside v-if="tools.songId" class="ed-tools">
      <SongToolsPanel
        :key="tools.songId"
        :song-id="tools.songId"
        :initial-tab="tools.tab"
        @close="closeTools"
      />
    </aside>

    <Modal :visible="guard.open" :closable="false" size="md">
      <div
        ref="guardEl"
        class="guard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-guard-title"
        aria-describedby="unsaved-guard-desc"
      >
        <div class="guard__header">
          <h3 id="unsaved-guard-title">{{ guard.failed ? 'Couldn’t save your lyric edits' : guardTitle }}</h3>
          <button
            class="guard__close"
            aria-label="Keep editing"
            title="Keep editing (Esc)"
            :disabled="guard.busy"
            @click="keepEditing"
          >&times;</button>
        </div>
        <div id="unsaved-guard-desc" class="guard__body">
          <template v-if="guard.failed">
            <div class="guard__err" role="alert">
              <b>Save failed — you’re still in the editor.</b>
              Reason: {{ guard.error }}. Nothing was changed: {{ activeSetId ? `the active set is still #${activeSetId} and your` : 'your' }}
              {{ changesText(guard.changes) }} {{ guard.changes === 1 ? 'is' : 'are' }} still open.
            </div>
            <p>
              Retry, keep editing, or
              <button class="guard__link" @click="exportBackup">export the session file</button>
              as a backup before deciding.
            </p>
          </template>
          <p v-else>
            You have <b>{{ changesText(guard.changes) }}</b> not yet saved in set {{ currentSetName }}. {{ guardLead }}
          </p>
          <ul class="guard__opts">
            <li>
              <b>Save as new set and make active</b> — creates a new set from your edits; it becomes
              the lyrics used when <i>{{ song?.title }}</i> is performed. Set #{{ guard.setId }} is kept.
            </li>
            <li><b>Discard edits</b> — {{ guardDiscardText }}</li>
            <li><b>Keep editing</b> — stay here (Esc).</li>
          </ul>
        </div>
        <div class="guard__footer">
          <Button ref="keepButton" variant="ghost" :disabled="guard.busy" @click="keepEditing">Keep editing</Button>
          <span class="grow"></span>
          <Button variant="default" :disabled="guard.busy" @click="discardEdits">Discard edits</Button>
          <Button
            variant="primary"
            :disabled="guard.busy || guardSaveBlocked"
            :title="guardSaveBlocked ? 'Fix validation errors first' : undefined"
            @click="saveAndContinue"
          >{{ guard.busy ? 'Saving…' : guard.failed ? 'Retry save' : 'Save as new set and make active' }}</Button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<script setup>
// Production word-timing editor. Deep-linkable:
//   /songs/:songId/lyrics-editor          → edit the active (or first) set with word sync
//   /songs/:songId/lyrics-editor/:setId   → edit that set
// Saving creates a NEW manual set (activated) and the editor moves onto it, so
// repeated saves chain provenance instead of compounding "edited from edited
// from…" labels. "Duplicate set" copies via the backend and opens the copy.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'

import { lyricsSetsApi, songApi } from '@/api/client'
import { BRAND_NAME } from '@/brand.js'
import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'
import SongToolsPanel from '@/components/SongToolsPanel.vue'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'
import { useSongToolsStore } from '@/stores/songTools'

const route = useRoute()
const router = useRouter()
const tools = useSongToolsStore()

const songId = ref(null)
const song = ref(null)
const sets = ref([])

const setId = ref(null)
const setLabel = ref('')
const wordSync = ref(null)

const loading = ref(true)
const busy = ref(false)
const notice = ref('')
const noticeIsError = ref(false)

function flash(msg, isError = false) {
  notice.value = msg
  noticeIsError.value = isError
}

const hasActiveSet = computed(() => sets.value.some(ls => ls.is_active))
const activeSetId = computed(() => sets.value.find((ls) => ls.is_active)?.id ?? null)

// The pointer is global and this view is one of three places that can move it.
// It deliberately does NOT close the panel on the way out: the host who opened
// Song tools in the library and then stepped into the workbench would come
// back to it shut, having closed nothing. Whoever opened it closes it.
function openTools() {
  if (songId.value) tools.open(songId.value)
}

// The panel can have activated, deleted or re-paged a set while it was open,
// so the switcher and the loaded set are re-read on the way out.
async function closeTools() {
  tools.close()
  if (!songId.value) return
  try {
    await refreshSets()
  } catch (err) {
    flash(`Could not refresh the set list: ${err.message}`, true)
  }
}

async function refreshSets() {
  const res = await lyricsSetsApi.list(songId.value)
  sets.value = res.data
}

/** Load one set into the editor and reflect it in the URL. */
async function openSet(lid, { replaceUrl = true } = {}) {
  if (!lid) return
  try {
    const res = await lyricsSetsApi.get(songId.value, lid)
    const ls = res.data
    if (!ls.word_sync) {
      flash(`Set #${lid} has no word-level sync to edit.`, true)
      return
    }
    setId.value = ls.id
    setLabel.value = ls.label || ls.source
    wordSync.value = ls.word_sync
    flash('')
    if (replaceUrl && Number(route.params.setId) !== ls.id) {
      router.replace({ params: { ...route.params, setId: String(ls.id) } })
    }
  } catch (err) {
    flash(`Could not load set #${lid}: ${err.message}`, true)
  }
}

/** Which set to open when the URL doesn't say: active if editable, else the
 *  first (newest last in list order) set that has word sync. */
function defaultSetId() {
  const editable = sets.value.filter((ls) => ls.has_word_sync)
  return (editable.find((ls) => ls.is_active) ?? editable[editable.length - 1])?.id ?? null
}

async function loadFromRoute() {
  loading.value = true
  try {
    songId.value = Number(route.params.songId)
    const [songRes] = await Promise.all([songApi.get(songId.value), refreshSets()])
    song.value = songRes.data
    const requested = Number(route.params.setId) || defaultSetId()
    if (requested) await openSet(requested)
  } catch (err) {
    flash(`Could not load song: ${err.message}`, true)
  } finally {
    loading.value = false
  }
}

// React to external navigation (back/forward, links from the sets modal).
// Our own router.replace calls are no-ops here because setId already matches.
watch(
  () => [route.params.songId, route.params.setId],
  ([sid, lid]) => {
    if (route.name !== 'lyrics-editor') return
    if (Number(sid) !== songId.value) loadFromRoute()
    else if (Number(lid) && Number(lid) !== setId.value) openSet(Number(lid), { replaceUrl: false })
  },
  { immediate: true },
)

async function onSaved(newSet) {
  // A save started from the unsaved-edits prompt continues that prompt's own
  // action instead.
  if (guard.open) return
  await refreshSets()
  // Continue editing the freshly saved set so the next save chains from it.
  await openSet(newSet.id)
  flash(`Saved as new active set #${newSet.id} ("${newSet.label}"). Now editing the saved set.`)
}

async function duplicateSet() {
  if (!setId.value || busy.value) return
  let outcome = null
  if (editorDirty.value) {
    outcome = await confirmUnsaved('dup')
    if (!outcome) return
    if (outcome.saved) {
      await refreshSets()
      await openSet(outcome.saved.id)
    }
  }
  busy.value = true
  try {
    const res = await lyricsSetsApi.copy(songId.value, setId.value)
    await refreshSets()
    await openSet(res.data.id)
    flash(`${outcome ? `${outcome.message} ` : ''}Duplicated into set #${res.data.id} ("${res.data.label}") — now editing the copy.`)
  } catch (err) {
    flash(`Copy failed: ${err.message}`, true)
  } finally {
    busy.value = false
  }
}

// ─── unsaved edits ──────────────────────────────────────────────────────────
// Unsaved state comes from the workbench's session (its op log), so undoing
// back to zero edits needs no prompt. Anything that would replace the loaded
// doc asks first: Save, Discard, or Keep editing.
const workbench = ref(null)
const setSelect = ref(null)
const keepButton = ref(null)
const guardEl = ref(null)

const editorDirty = computed(() => workbench.value?.dirty === true)

const changesText = (n) => (n === 1 ? '1 change' : `${n} changes`)

const setName = (ls) => `#${ls.id} ${ls.source}${ls.label ? ` · ${ls.label}` : ''}`

const guard = reactive({
  open: false,
  kind: '',
  target: null,
  setId: null,
  changes: 0,
  busy: false,
  failed: false,
  error: '',
})
let settleGuard = null
let guardReturnFocus = null

const currentSetName = computed(() => {
  const ls = sets.value.find((s) => s.id === guard.setId)
  return ls ? setName(ls) : `#${guard.setId}`
})

const guardTitle = computed(() => ({
  back: 'Leave with unsaved lyric edits?',
  switch: 'Switch sets with unsaved lyric edits?',
  dup: 'Duplicate without your unsaved edits?',
  close: `Close ${BRAND_NAME} with unsaved lyric edits?`,
})[guard.kind])

const guardLead = computed(() => {
  const them = guard.changes === 1 ? 'it' : 'them'
  return {
    back: `Leaving the editor now would discard ${them}.`,
    switch: `Opening set #${guard.target} now would discard ${them}.`,
    dup: `⧉ Duplicate copies the saved set #${guard.setId}; it would not include ${guard.changes === 1 ? 'this change' : 'these changes'}.`,
    close: `Closing ${BRAND_NAME} now would discard ${them}.`,
  }[guard.kind]
})

const guardDiscardText = computed(() => ({
  back: `return to the library; set #${guard.setId} stays as it was.`,
  switch: `open set #${guard.target}; set #${guard.setId} stays as it was.`,
  dup: `duplicate the saved set #${guard.setId} and edit the copy.`,
  close: 'quit without saving.',
})[guard.kind])

const guardSaveBlocked = computed(() => (workbench.value?.validation?.errors?.length ?? 0) > 0)

/**
 * Ask what to do with the unsaved edits before `kind` replaces them.
 * Resolves to null for Keep editing, or `{ saved, message }` once the edits
 * were saved (`saved` is the new set) or discarded (`saved` is null). A failed
 * save keeps the prompt open and the action pending.
 */
function confirmUnsaved(kind, { target = null } = {}) {
  // Only one prompt at a time: a newer request replaces the pending one.
  if (guard.open) finishGuard(null)
  guardReturnFocus = document.activeElement
  Object.assign(guard, {
    open: true,
    kind,
    target,
    setId: setId.value,
    changes: workbench.value?.opCount ?? 0,
    busy: false,
    failed: false,
    error: '',
  })
  window.addEventListener('keydown', onGuardKeydown, true)
  nextTick(() => keepButton.value?.$el?.focus())
  return new Promise((resolve) => {
    settleGuard = resolve
  })
}

function finishGuard(outcome) {
  window.removeEventListener('keydown', onGuardKeydown, true)
  guard.open = false
  guard.busy = false
  const settle = settleGuard
  settleGuard = null
  settle?.(outcome)
}

function keepEditing() {
  if (guard.busy) return
  const returnTo = guardReturnFocus
  finishGuard(null)
  if (returnTo?.isConnected) returnTo.focus?.()
}

function discardEdits() {
  if (guard.busy) return
  finishGuard({
    saved: null,
    message: `Discarded ${changesText(guard.changes)} to set #${guard.setId}; it is unchanged.`,
  })
}

async function saveAndContinue() {
  if (guard.busy || !workbench.value) return
  guard.busy = true
  const saved = await workbench.value.save()
  guard.busy = false
  if (!saved) {
    guard.failed = true
    guard.error = workbench.value?.saveError || 'the save did not complete'
    return
  }
  finishGuard({ saved, message: `Saved as new active set #${saved.id} (“${saved.label}”).` })
}

function exportBackup() {
  workbench.value?.saveSessionFile()
}

// While the prompt is open the editor's own shortcuts stay quiet, Tab stays
// inside it, and Esc means Keep editing.
function onGuardKeydown(e) {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    keepEditing()
  } else if (e.key === 'Tab') {
    const focusable = [...(guardEl.value?.querySelectorAll('button') ?? [])].filter((b) => !b.disabled)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (!guardEl.value.contains(active)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

async function switchSet(e) {
  const target = Number(e.target.value)
  if (editorDirty.value) {
    const outcome = await confirmUnsaved('switch', { target })
    if (!outcome) {
      if (setSelect.value) setSelect.value.value = String(setId.value ?? 0)
      return
    }
    if (outcome.saved) await refreshSets()
    await openSet(target)
    if (setId.value === target) flash(outcome.message)
    return
  }
  await openSet(target)
}

onBeforeRouteLeave(async () => {
  if (!editorDirty.value) return true
  return Boolean(await confirmUnsaved('back'))
})

// Same route, other set or song: back/forward and links from the sets list.
// Our own router.replace after loading a set arrives with setId already moved.
onBeforeRouteUpdate(async (to) => {
  if (!editorDirty.value) return true
  if (Number(to.params.songId) !== songId.value) return Boolean(await confirmUnsaved('back'))
  const lid = Number(to.params.setId)
  if (!lid || lid === setId.value) return true
  const outcome = await confirmUnsaved('switch', { target: lid })
  if (outcome?.saved) await refreshSets()
  return Boolean(outcome)
})

// Browser build: the in-app prompt cannot run during unload, so the browser's
// own confirmation stands in. The desktop host asks through its close guard.
const desktop = typeof window !== 'undefined' ? window.karaokeDesktop : undefined
const desktopGuard = typeof desktop?.setCloseGuard === 'function' && typeof desktop?.onCloseRequested === 'function'

function onBeforeUnload(e) {
  if (desktopGuard || !editorDirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

async function onCloseRequested() {
  let decision = 'proceed'
  if (editorDirty.value) {
    // A save already running from another prompt finishes first.
    decision = guard.busy ? 'cancel' : (await confirmUnsaved('close')) ? 'proceed' : 'cancel'
  }
  try {
    await desktop.answerCloseRequest(decision)
  } catch {
    // The host stopped listening (already closing); nothing to answer.
  }
}

function armDesktopGuard(armed) {
  if (!desktopGuard) return
  Promise.resolve()
    .then(() => desktop.setCloseGuard(armed))
    .catch(() => {})
}

// The window title carries a ● while edits are unsaved.
const DIRTY_MARK = '● '
function markTitle(dirty) {
  const plain = document.title.startsWith(DIRTY_MARK) ? document.title.slice(DIRTY_MARK.length) : document.title
  document.title = dirty ? `${DIRTY_MARK}${plain}` : plain
}

watch(editorDirty, (dirty) => {
  armDesktopGuard(dirty)
  markTitle(dirty)
})

// Re-arm on every edit as well: the host drops the guard if the renderer
// stalls, and the dirty flag alone would not change once it recovers.
watch(() => workbench.value?.opCount ?? 0, (count) => {
  if (count > 0) armDesktopGuard(true)
})

let stopCloseRequests = null
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  if (desktopGuard) stopCloseRequests = desktop.onCloseRequested(onCloseRequested)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onGuardKeydown, true)
  if (typeof stopCloseRequests === 'function') stopCloseRequests()
  armDesktopGuard(false)
  markTitle(false)
})
</script>

<style scoped>
.ed-tools {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(380px, 92vw);
  z-index: 30;
  display: flex;
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
}
.ed-tools > :deep(.tools) { flex: 1; min-width: 0; }

.ed-select {
  max-width: 24rem;
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
  color: #e5e7eb;
}
.ed-btn {
  border-radius: 0.375rem;
  border: 1px solid #2a3040;
  background: #141821;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  color: #d1d5db;
}
.ed-btn:hover:not(:disabled) {
  border-color: #e23e57;
  color: #e23e57;
}
.ed-btn:disabled {
  opacity: 0.4;
}

.guard__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.guard__header h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: white;
}
.guard__close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.25rem;
  cursor: pointer;
}
.guard__close:hover:not(:disabled) { color: white; }
.guard__body {
  font-size: 0.875rem;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 1.25rem;
}
.guard__body p { margin: 0 0 0.6rem; }
.guard__body b { color: white; }
.guard__opts {
  margin: 0;
  padding-left: 1.1rem;
  list-style: disc;
}
.guard__opts li { margin: 0.25rem 0; }
.guard__err {
  margin: 0.2rem 0 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--c-error-border);
  background: var(--c-error-bg);
  padding: 0.6rem 0.75rem;
  color: #fecaca;
}
.guard__link {
  background: none;
  border: 0;
  padding: 0;
  color: #93c5fd;
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}
.guard__footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
