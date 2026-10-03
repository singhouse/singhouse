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
import { ref, onMounted, onBeforeUnmount } from 'vue'
import SongPicker from '@/components/SongPicker.vue'
import HistoryModal from '@/components/HistoryModal.vue'
import Modal from '@/components/ui/Modal.vue'
import { useQueueStore } from '@/stores/queue'
import { useSongsStore } from '@/stores/songs'
import { useHistoryStore } from '@/stores/history'

const queue = useQueueStore()
const songs = useSongsStore()
const history = useHistoryStore()

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

function onSing(entry) {
  // Dequeue-on-play: load the deck, then the row is gone (delete is the
  // model's "played" signal — there is no status column).
  songs.loadSong({ id: entry.song_id })
  // Record the play from the entry's snapshot singer name. Fire-and-
  // forget: recordPlay never throws, so a history-write blip cannot block the
  // load or the dequeue below.
  history.recordPlay(entry.song_id, entry.singer_name || null)
  queue.remove(entry.id)
}

function onClear() {
  if (window.confirm('Clear the whole queue?')) queue.clear()
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
