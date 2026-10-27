<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="queue-panel">
    <!-- Header -->
    <div class="queue-panel__header">
      <h2 class="queue-panel__title">
        🎤 Up Next
        <span v-if="queue.count" class="queue-panel__count">{{ queue.count }}</span>
      </h2>
      <div class="queue-panel__header-actions">
        <!-- Undo the last ▶ Sing: the dequeued entry goes back on top and
             the deck goes back to what it held before. History lives in
             this browser only (useUndoStack). -->
        <UndoButton
          class="queue-panel__undo"
          :disabled="!undoable || inFlight === 'sing'"
          :busy="inFlight === 'undo'"
          :label="undoLabel"
          @click="onUndo"
        />
        <!-- Play history belongs to this basic queue: a registered queue
             provider replaces this whole panel (and brings its own history,
             if any), so the button needs no gate of its own. -->
        <button
          class="queue-panel__history"
          title="Play history"
          @click="historyOpen = true"
        >
          🕘 History
        </button>
        <button
          v-if="queue.count"
          class="queue-panel__clear"
          title="Remove every entry from the queue"
          @click="onClear"
        >
          Clear
        </button>
      </div>
    </div>

    <!-- Add row: optional singer name + a library pick -->
    <div class="queue-panel__add">
      <input
        v-model="singerName"
        class="queue-panel__singer"
        type="text"
        maxlength="80"
        placeholder="Who's singing? (optional)"
        aria-label="Singer name"
      />
      <!-- Bright line: the queue points at the host's own library — never "any song". -->
      <SongPicker
        :busy="adding"
        mode="host"
        placeholder="Search your library"
        @pick="onPick"
      />
      <p v-if="pickHint" class="queue-panel__hint">{{ pickHint }}</p>
    </div>

    <p v-if="queue.error" class="queue-panel__error">{{ queue.error }}</p>

    <!-- Entries -->
    <ul v-if="queue.entries.length" class="queue-panel__list">
      <li
        v-for="(entry, i) in queue.entries"
        :key="entry.id"
        class="queue-entry"
        :class="{ 'queue-entry--next': i === 0 }"
      >
        <span class="queue-entry__pos">{{ i + 1 }}</span>
        <div class="queue-entry__meta">
          <div class="queue-entry__singer">{{ entry.singer_name || '—' }}</div>
          <div class="queue-entry__song">{{ entry.artist }} — {{ entry.title }}</div>
        </div>
        <div class="queue-entry__actions">
          <button
            class="queue-entry__btn queue-entry__btn--sing"
            :disabled="inFlight !== null"
            title="Load this song into the player and remove it from the queue"
            @click="onSing(entry)"
          >
            ▶ Sing
          </button>
          <button
            class="queue-entry__btn"
            :disabled="i === 0"
            title="Move up"
            @click="queue.moveUp(entry.id)"
          >
            ▲
          </button>
          <button
            class="queue-entry__btn"
            :disabled="i === queue.entries.length - 1"
            title="Move down"
            @click="queue.moveDown(entry.id)"
          >
            ▼
          </button>
          <button
            class="queue-entry__btn queue-entry__btn--remove"
            title="Remove from queue"
            @click="queue.remove(entry.id)"
          >
            ✕
          </button>
        </div>
      </li>
    </ul>
    <p v-else-if="queue.fetchedOnce" class="queue-panel__empty">
      The queue is empty — add a song from your library above.
    </p>

    <!-- Play-history modal. Rendered lazily so the list only fetches when
         opened. -->
    <Modal :visible="historyOpen" size="lg" @close="historyOpen = false">
      <HistoryModal v-if="historyOpen" />
    </Modal>
  </div>
</template>

<script setup>
// BasicManualQueue panel — what HostShell's bottom pane mounts when no
// queue provider is installed. Manual order, free-text singer names,
// dequeue-on-play. No fairness, shows, or guest self-service.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import SongPicker from '@/components/SongPicker.vue'
import HistoryModal from '@/components/HistoryModal.vue'
import Modal from '@/components/ui/Modal.vue'
import UndoButton from '@/components/ui/UndoButton.vue'
import { useQueueStore } from '@/stores/queue'
import { useSongsStore } from '@/stores/songs'
import { useHistoryStore } from '@/stores/history'
import { usePlayGuard } from '@/composables/usePlayGuard'
import { useUndoStack } from '@/composables/useUndoStack'

const queue = useQueueStore()
const songs = useSongsStore()
const history = useHistoryStore()
const { guard } = usePlayGuard()
// Core's own key; a queue provider that replaces this panel keeps its own.
const undo = useUndoStack('queue')
// One action at a time across ▶ Sing and Undo ('sing' | 'undo' | null): an
// undo must never interleave with a Sing (or another Sing), or it could
// reverse a half-recorded action and reload the wrong deck song.
const inFlight = ref(null)

// This panel owns its own poll lifecycle: the shell mounts whichever queue
// panel the assembly ships and knows nothing about either one's endpoints.
// The store ref-counts, so a second surface still shares one timer.
onMounted(() => queue.startPolling())
onBeforeUnmount(() => queue.stopPolling())

const singerName = ref('')
const adding = ref(false)
const pickHint = ref(null)
const historyOpen = ref(false)

async function onPick(text, songId) {
  // Freehand text has no library row to point at (queue_entries FKs songs.id).
  if (songId == null) {
    pickHint.value = 'Pick a song from your library to queue it.'
    return
  }
  pickHint.value = null
  adding.value = true
  try {
    // Keep the typed name on failure (store surfaces the error) so the host
    // doesn't retype it after a blip.
    const ok = await queue.add(songId, singerName.value.trim() || null)
    if (ok) singerName.value = ''
  } finally {
    adding.value = false
  }
}

function songSnapshot(song) {
  if (!song || song.id == null) return null
  return { id: song.id, title: song.title || '', artist: song.artist || '' }
}

// What the deck was last asked to load by a Sing or an Undo. songs.loadSong
// only sets currentSong once its fetch returns, so a quick Sing-Sing would
// otherwise snapshot the song from before the first Sing. Cleared once that
// load settles, after which currentSong is authoritative again (a library
// load made in between is picked up from there).
let deckIntent = null

function deckSong() {
  return deckIntent ?? songSnapshot(songs.currentSong)
}

function loadDeck(snapshot) {
  deckIntent = snapshot
  const done = Promise.resolve(songs.loadSong({ id: snapshot.id }))
  done
    .finally(() => {
      if (deckIntent === snapshot) deckIntent = null
    })
    .catch(() => {})
  return done
}

const isIdOrNull = (v) => v == null || Number.isInteger(v)

// This panel's records. Other kinds on the stack are skipped, never touched.
function isSing(record) {
  return !!record && record.kind === 'queue.sing'
}

// The only shape of Sing record this panel will act on. A malformed one is
// dropped instead of blocking the older ones below it.
function isSingRecord(record) {
  if (!isSing(record)) return false
  const { entry, historyId, previousPlay, previousSong } = record
  if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.song_id)) return false
  if (!isIdOrNull(historyId)) return false
  if (previousPlay != null) {
    if (typeof previousPlay !== 'object') return false
    if (!isIdOrNull(previousPlay.historyId) || !isIdOrNull(previousPlay.songId)) return false
  }
  if (previousSong != null && (typeof previousSong !== 'object' || !Number.isInteger(previousSong.id))) {
    return false
  }
  return true
}

// Whether a song can still be loaded, judged from the library list only
// when it holds the whole library (loaded, not narrowed by a search);
// otherwise assume it can and let the load itself fail.
function inLibrary(songId) {
  const list = songs.songs
  if (!Array.isArray(list) || !list.length || songs.searchQuery) return true
  return list.some((s) => s.id === songId)
}

// A 4xx means this request can never succeed (song gone, record malformed),
// except auth, timeout and rate limiting, which a retry can get past.
function dropsRecord(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && ![401, 408, 429].includes(status)
}

function onSing(entry) {
  // An Undo in flight wins; checking before the guard also keeps this click
  // from cancelling the Undo's open confirmation.
  if (inFlight.value) return Promise.resolve(false)
  // Loading over a playing song asks first; a cancel leaves the entry queued.
  return guard(async () => {
    // Re-checked after the confirmation: an Undo may have started meanwhile.
    if (inFlight.value) {
      queue.error = 'Not loaded: an undo was in progress. Press ▶ Sing again.'
      return
    }
    inFlight.value = 'sing'
    try {
      // What the deck held before this Sing — and which play row was waiting
      // for its natural end — so an undo can put both back.
      const previousSong = deckSong()
      const previousPlay = {
        historyId: history.currentHistoryId ?? null,
        songId: history.currentPlaySongId ?? null,
      }
      // Dequeue-on-play: load the deck, then the row is gone (delete is the
      // model's "played" signal — there is no status column).
      loadDeck({ id: entry.song_id, title: entry.title || '', artist: entry.artist || '' })
      // Record the play from the entry's snapshot singer name. recordPlay never
      // throws, so a history-write blip cannot block the load or the dequeue.
      const recorded = history.recordPlay(entry.song_id, entry.singer_name || null)
      const dequeued = await queue.dequeue(entry.id)
      // recordPlay never rejects; null means the record failed (no row).
      const historyId = (await recorded) ?? null
      if (!dequeued.ok) {
        // Nothing was dequeued, so nothing is undoable. On a 404 the entry
        // was already gone (another tab or a double click sang it, and that
        // Sing wrote its own row), so take this duplicate row back (only if
        // still incomplete). Any other failure leaves the entry queued but
        // the song is on the deck, so its row stays: it records a real play.
        if (dequeued.status === 404 && historyId != null) {
          await history.undoPlay(historyId, null, { songId: entry.song_id })
        }
        return
      }
      undo.push({
        kind: 'queue.sing',
        entry: {
          song_id: entry.song_id,
          singer_name: entry.singer_name || null,
          title: entry.title || '',
          artist: entry.artist || '',
        },
        previousSong,
        historyId,
        previousPlay,
      })
    } finally {
      inFlight.value = null
    }
  }, { kind: 'load', title: entry.title || '' })
}

// The newest Sing record; records of other kinds are skipped.
const undoTop = computed(() => {
  const list = undo.entries.value
  for (let i = list.length - 1; i >= 0; i--) if (isSing(list[i])) return list[i]
  return null
})
// The button's enabled state and its label come from the same check.
const undoable = computed(() => isSingRecord(undoTop.value) && undo.isLive(undoTop.value))

// Malformed Sing records are dropped as soon as they appear.
watch(() => undo.entries.value, (list) => {
  for (const r of list) if (isSing(r) && !isSingRecord(r)) undo.remove(r.id)
}, { immediate: true })

const undoLabel = computed(() => {
  if (!undoable.value) return 'Nothing to undo'
  const top = undoTop.value
  const who = top.entry.singer_name ? `${top.entry.singer_name}, ` : ''
  let text = `Undo Sing — put ${who}${top.entry.title || 'that song'} back on top of the queue`
  if (top.previousSong && undo.isOwn(top)) text += ` and reload ${top.previousSong.title || 'the previous song'}`
  return text
})

// Undo puts the entry back on top of the queue, not at the position it was
// sung from.
async function onUndo() {
  if (inFlight.value) return
  const top = undo.peek({ where: isSing })
  if (!top) return
  if (!isSingRecord(top)) {
    undo.remove(top.id)
    return
  }
  inFlight.value = 'undo'
  try {
    // Only the tab that made the Sing touches its deck and play pointer; any
    // other tab of the host view still restores the queue entry and drops
    // the play row, but its own deck is left as it is.
    const own = undo.isOwn(top)
    // With no previous song (nothing was on the deck before that Sing), the
    // undone song simply stays on the deck.
    const prev = own && top.previousSong ? top.previousSong : null
    // Already on the deck, or deleted from the library since: nothing to
    // reload, so nothing to confirm.
    const reload = !!prev && prev.id !== deckSong()?.id && inLibrary(prev.id)
    const song = top.entry
    const restore = () => undo.withLock(async () => {
      // Another tab may have undone this record, or pushed a newer one over
      // it, while the confirmation was open or the lock was held elsewhere.
      // Read storage, not memory: its storage event may not have arrived.
      if (undo.peek({ fresh: true, where: isSing })?.id !== top.id) {
        queue.error = 'Nothing undone: the undo history changed in another tab.'
        return
      }
      const res = await queue.restoreToFront(song.song_id, song.singer_name || null)
      if (!res.ok) {
        // A request that can never succeed (song deleted from the library,
        // a malformed record) drops the record so it stops blocking older
        // ones. Anything else keeps it for a retry (the store has surfaced
        // the error). A dropped record leaves the Sing's history row and the
        // deck as they are: only the queue entry could not come back.
        if (dropsRecord(res.status)) undo.remove(top.id)
        return
      }
      undo.remove(top.id)
      // Drop the undone Sing's play row unless it completed (or no longer
      // belongs to that song), and rewind the pending pointer before the
      // previous song is back on the deck.
      if (top.historyId != null) {
        await history.undoPlay(top.historyId, top.previousPlay, { rewind: own, songId: song.song_id })
      }
      if (reload) await loadDeck(prev)
    })
    // Only reloading the previous song replaces what is on the deck; with
    // nothing to reload, the deck is left alone and no confirmation is
    // needed.
    if (reload) {
      await guard(restore, { kind: 'load', title: prev.title || '' })
    } else {
      await restore()
    }
  } finally {
    inFlight.value = null
  }
}

async function onClear() {
  if (!window.confirm('Clear the whole queue?')) return
  // Undoing a Sing into an emptied queue would resurrect entries the host
  // just cleared, so the undo history goes with it.
  if (await queue.clear()) undo.clear()
}
</script>

<style scoped>
.queue-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem 1rem;
  overflow-y: auto;
}

.queue-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.queue-panel__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.queue-panel__count {
  font-size: 0.72rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: rgba(226, 62, 87, 0.15);
  color: #e23e57;
  border: 1px solid rgba(226, 62, 87, 0.4);
}

.queue-panel__header-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.queue-panel__history {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  padding: 0.25rem 0.7rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.queue-panel__history:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

.queue-panel__clear {
  background: transparent;
  border: 1px solid rgba(248, 113, 113, 0.35);
  color: #fca5a5;
  border-radius: 6px;
  padding: 0.25rem 0.7rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.queue-panel__clear:hover {
  background: rgba(248, 113, 113, 0.12);
}

.queue-panel__add {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.queue-panel__singer {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: white;
  padding: 0.45rem 0.65rem;
  font-size: 0.85rem;
}
.queue-panel__singer:focus {
  outline: none;
  border-color: rgba(226, 62, 87, 0.4);
}

.queue-panel__hint,
.queue-panel__error {
  margin: 0;
  font-size: 0.75rem;
  color: #fca5a5;
}

.queue-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.queue-entry {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
}
.queue-entry--next {
  background: rgba(226, 62, 87, 0.08);
  border-color: rgba(226, 62, 87, 0.35);
}

.queue-entry__pos {
  width: 1.4rem;
  text-align: center;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}
.queue-entry--next .queue-entry__pos {
  color: #e23e57;
}

.queue-entry__meta {
  flex: 1;
  min-width: 0;
}
.queue-entry__singer {
  font-size: 0.85rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-entry__song {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-entry__actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.queue-entry__btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.queue-entry__btn:hover:not(:disabled) {
  border-color: rgba(226, 62, 87, 0.4);
  color: white;
}
.queue-entry__btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.queue-entry__btn--sing {
  background: rgba(226, 62, 87, 0.15);
  border-color: rgba(226, 62, 87, 0.4);
  color: #e23e57;
}
.queue-entry__btn--sing:hover {
  background: rgba(226, 62, 87, 0.25);
}
.queue-entry__btn--remove:hover {
  border-color: rgba(248, 113, 113, 0.55);
  color: #fca5a5;
}

.queue-panel__empty {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.4);
}
</style>
