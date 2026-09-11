<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="history-modal">
    <!-- Title -->
    <div class="history-modal__title">
      <span class="title-icon">🕘</span>
      <h2>Play history</h2>
    </div>

    <!-- Controls: search + retention -->
    <div class="history-modal__controls">
      <input
        v-model="history.search"
        class="history-modal__search"
        type="text"
        placeholder="Search title, artist, or singer"
        aria-label="Search play history"
        @input="onSearchInput"
      />
      <label class="history-modal__retention" title="Old plays are trimmed automatically to keep the local database tidy.">
        <span class="history-modal__retention-label">Auto-delete plays older than</span>
        <input
          v-model.number="retention"
          class="history-modal__retention-input"
          type="number"
          min="0"
          max="36500"
          step="1"
          aria-label="Retention days"
          @change="onRetentionChange"
        />
        <span class="history-modal__retention-label">days</span>
      </label>
    </div>
    <p class="history-modal__hint">0 = keep forever.</p>

    <p v-if="history.error" class="history-modal__error">{{ history.error }}</p>

    <!-- List (newest first) -->
    <ul v-if="history.entries.length" class="history-list">
      <li v-for="row in history.entries" :key="row.id" class="history-row">
        <div class="history-row__when">{{ formatWhen(row.played_at) }}</div>
        <div class="history-row__meta">
          <div class="history-row__singer">{{ row.singer_name || '—' }}</div>
          <div class="history-row__song">{{ row.artist }} — {{ row.title }}</div>
        </div>
        <span
          class="history-row__status"
          :class="row.completed ? 'history-row__status--done' : 'history-row__status--pending'"
          :title="row.completed ? 'Played to the end' : 'Did not finish'"
        >{{ row.completed ? '✓' : '⋯ in progress' }}</span>
        <button
          class="history-row__remove"
          title="Remove this entry"
          aria-label="Remove entry"
          @click="history.remove(row.id)"
        >✕</button>
      </li>
    </ul>

    <p v-else-if="history.fetchedOnce" class="history-modal__empty">
      No plays recorded yet.
    </p>

    <!-- Footer -->
    <div v-if="history.entries.length" class="history-modal__footer">
      <button class="history-modal__clear" @click="onClear">Clear all</button>
    </div>
  </div>
</template>

<script setup>
// Flat play-history view. Core-only surface: the 🕘 button that mounts it
// is gated on the absence of a queue provider, and /api/history exists only in
// the single-host build. This is the host's OWN library history — no venues,
// no shows, no tiers. Retention is plain DB hygiene, never a paid feature.
import { onMounted, ref, watch } from 'vue'
import { useHistoryStore } from '@/stores/history'

const history = useHistoryStore()

// Local seed for the retention input so typing doesn't fire a write per digit;
// the PUT lands on change/blur. Kept in sync if the store value shifts.
const retention = ref(history.retentionDays)
watch(() => history.retentionDays, v => { retention.value = v })

onMounted(async () => {
  await history.fetchSettings()
  retention.value = history.retentionDays
  history.fetchList()
})

// Light debounce so each keystroke doesn't hit the API; the store reads
// history.search itself (v-model above), so this only schedules the refetch.
let searchTimer = null
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => history.fetchList(), 250)
}

const MAX_RETENTION_DAYS = 36500  // mirrors the backend ceiling (~100y)
function onRetentionChange() {
  const n = Number(retention.value)
  if (!Number.isFinite(n) || n < 0) {
    retention.value = history.retentionDays
    return
  }
  history.setRetention(Math.min(Math.floor(n), MAX_RETENTION_DAYS))
}

function onClear() {
  if (window.confirm('Clear the entire play history?')) history.clear()
}

function formatWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
</script>

<style scoped>
.history-modal {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 0;
}

.history-modal__title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.25rem;
}
.history-modal__title h2 {
  font-size: 1.05rem;
  font-weight: 700;
  color: white;
  letter-spacing: -0.01em;
  margin: 0;
}
.history-modal__title .title-icon { font-size: 1.2rem; }

.history-modal__controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.history-modal__search {
  flex: 1;
  min-width: 12rem;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: white;
  padding: 0.45rem 0.65rem;
  font-size: 0.85rem;
}
.history-modal__search:focus {
  outline: none;
  border-color: rgba(226, 62, 87, 0.4);
}

.history-modal__retention {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.55);
}
.history-modal__retention-input {
  width: 4rem;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: white;
  padding: 0.3rem 0.45rem;
  font-size: 0.8rem;
}
.history-modal__retention-input:focus {
  outline: none;
  border-color: rgba(226, 62, 87, 0.4);
}

.history-modal__hint {
  margin: 0;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.4);
}

.history-modal__error {
  margin: 0;
  font-size: 0.78rem;
  color: #fca5a5;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 55vh;
  overflow-y: auto;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
}

.history-row__when {
  flex-shrink: 0;
  width: 6.5rem;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.45);
}

.history-row__meta {
  flex: 1;
  min-width: 0;
}
.history-row__singer {
  font-size: 0.85rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-row__song {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-row__status {
  flex-shrink: 0;
  font-size: 0.72rem;
  white-space: nowrap;
}
.history-row__status--done { color: #f2cf7a; }
.history-row__status--pending { color: rgba(255, 255, 255, 0.4); }

.history-row__remove {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.history-row__remove:hover {
  border-color: rgba(248, 113, 113, 0.55);
  color: #fca5a5;
}

.history-modal__empty {
  margin: 0.5rem 0;
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.4);
}

.history-modal__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.25rem;
}
.history-modal__clear {
  background: transparent;
  border: 1px solid rgba(248, 113, 113, 0.35);
  color: #fca5a5;
  border-radius: 6px;
  padding: 0.3rem 0.8rem;
  font-size: 0.78rem;
  cursor: pointer;
}
.history-modal__clear:hover {
  background: rgba(248, 113, 113, 0.12);
}
</style>
