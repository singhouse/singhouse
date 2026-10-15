<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="song-list">
    <!-- Header / Filter bar -->
    <div class="song-list__header">
      <!-- The sidebar's one header row. The shell fills `lead` (brand mark /
           status), `actions` (its own menus) and `trail` (collapse); the
           title, count and the library ⋯ menu are the list's own. -->
      <div class="song-list__bar">
        <slot name="lead" />
        <h2 class="song-list__title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <span class="song-list__title-text">Library</span>
          <Badge v-if="store.songs.length" variant="synced" class="song-list__count">{{ store.songs.length }}</Badge>
        </h2>
        <span class="song-list__spacer" />
        <slot name="actions" />

        <!-- Library ⋯ menu. "Columns…" swaps the panel to the column chooser
             in place rather than stacking a second popover on the first. -->
        <PopoverMenu
          :role="menuView === 'columns' ? 'dialog' : 'menu'"
          align="end"
          :label="menuView === 'columns' ? 'Columns' : 'Library actions'"
          @close="menuView = 'menu'"
        >
          <template #trigger="{ toggle, attrs, open }">
            <button
              type="button"
              class="lib-menu__btn"
              :class="{ 'lib-menu__btn--open': open }"
              title="Library actions"
              aria-label="Library actions"
              v-bind="attrs"
              @click="toggle"
            >⋯</button>
          </template>
          <template #default="{ close }">
            <div v-if="menuView === 'columns'" ref="colPopEl" class="col-menu__pop">
              <p class="col-menu__heading">Columns</p>
              <label
                v-for="col in COLUMNS"
                :key="col.key"
                class="col-menu__item"
                :class="{ 'col-menu__item--locked': col.locked }"
              >
                <input
                  type="checkbox"
                  :checked="isVisible(col.key)"
                  :disabled="col.locked"
                  @change="toggleColumn(col.key)"
                />
                <span>{{ col.label }}</span>
                <span v-if="col.locked" class="col-menu__lock">always</span>
              </label>
            </div>
            <template v-else>
              <button type="button" role="menuitem" class="ui-menu__item" @click="close(); store.fetchSongs()">
                <span class="ui-menu__icon" aria-hidden="true">↺</span>Refresh library
              </button>
              <button type="button" role="menuitem" class="ui-menu__item lib-menu__columns" @click="showColumns">
                <span class="ui-menu__icon" aria-hidden="true">▥</span>Columns…
              </button>
              <template v-if="extraItems.length">
                <hr class="ui-menu__sep" />
                <button
                  v-for="item in extraItems"
                  :key="item.id"
                  type="button"
                  role="menuitem"
                  class="ui-menu__item"
                  :title="item.title || undefined"
                  @click="close(); openItem(item)"
                >
                  <span class="ui-menu__icon" aria-hidden="true">{{ item.icon || '' }}</span>{{ item.label }}
                </button>
              </template>
            </template>
          </template>
        </PopoverMenu>
        <slot name="trail" />
      </div>
      <slot name="notice" />

      <div class="search-row">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/>
          <path d="M21 21l-4.35-4.35"/>
        </svg>
        <input
          v-model="searchInput"
          class="search-input"
          type="search"
          placeholder="Search title, artist, or filename…"
          aria-label="Search library"
        />
        <button
          v-if="searchInput"
          class="search-clear"
          aria-label="Clear search"
          @click="clearSearch"
        >×</button>
      </div>

      <div class="filter-tabs">
        <button
          v-for="f in filters"
          :key="f.value"
          class="filter-tab"
          :class="{ 'filter-tab--active': store.statusFilter === f.value }"
          @click="store.statusFilter = f.value"
        >
          {{ f.label }}
          <span v-if="f.count !== undefined" class="filter-count">{{ f.count }}</span>
        </button>
      </div>
    </div>

    <!-- Loading skeleton -->
    <div v-if="store.loading" class="song-list__body">
      <div v-for="i in 3" :key="i" class="song-skeleton shimmer" />
    </div>

    <!-- Empty state — only when local list is empty -->
    <div
      v-else-if="!store.filteredSongs.length && !store.uploads.length"
      class="song-list__empty"
    >
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
      <p>{{ store.songs.length === 0 ? 'Upload songs to get started' : 'No songs match this filter' }}</p>
    </div>

    <!-- Song table -->
    <div v-else class="song-list__body">
      <div class="lib-table">
        <!-- Sortable header -->
        <div class="lib-head" role="row" :style="gridStyle">
          <span class="lib-cell lib-cell--dot" />
          <button
            v-for="col in visibleColumns"
            :key="col.key"
            class="lib-th"
            :class="[`lib-th--${col.key}`, { 'lib-th--sorted': sortKey === col.key }]"
            role="columnheader"
            :aria-sort="sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
            :title="`Sort by ${col.label}`"
            @click="toggleSort(col.key)"
          >
            <span class="lib-th__label">{{ col.label }}</span>
            <svg
              v-if="sortKey === col.key"
              class="lib-th__caret"
              width="10" height="10" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="3"
            >
              <polyline :points="sortDir === 'asc' ? '6 15 12 9 18 15' : '6 9 12 15 18 9'"/>
            </svg>
          </button>
          <span class="lib-cell lib-cell--actions" />
        </div>

        <TransitionGroup name="list">
          <div
            v-for="song in sortedSongs"
            :key="song.id"
            class="song-item"
            role="row"
            :style="gridStyle"
            :class="{
              'song-item--active': store.currentSong?.id === song.id,
              'song-item--disabled': song.status !== 'ready',
              'song-item--draggable': song.status === 'ready'
            }"
            :draggable="song.status === 'ready'"
            @dragstart="onDragStart($event, song)"
            @click="song.status === 'ready' && usePlayGuard().guard(() => store.loadSong(song), { kind: 'load', title: song.title || song.filename })"
          >
            <div class="lib-cell lib-cell--dot">
              <span class="song-item__dot" :class="`dot--${song.status}`" />
            </div>

            <div v-if="isVisible('title')" class="lib-cell lib-cell--title">
              <p class="song-item__title">
                <!-- Songs that came in with their own karaoke video play a
                     picture on the projector instead of the canvas lyrics.
                     Marked inline with the title so it survives whatever
                     columns the host has switched off. -->
                <svg
                  v-if="song.has_video"
                  class="song-item__video-mark"
                  width="11" height="11" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2"
                  role="img" aria-label="Has video"
                ><title>Has video</title>
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="M7 4v16M17 4v16M2 12h20"/>
                </svg>{{ song.title || song.filename || 'Unknown Title' }}
                <!-- A job the host started from Song tools. Rides with the
                     title, not the hover-revealed actions: the whole reason to
                     show it here is that the panel may be closed or pointed at
                     a different song. -->
                <span
                  v-if="jobMark(song.id)"
                  class="song-item__job"
                  :class="{ 'song-item__job--failed': !jobMark(song.id).running }"
                  :title="jobMark(song.id).title"
                >
                  <span v-if="jobMark(song.id).running" class="spinner inline-spinner" />
                  <span v-else aria-hidden="true">✗</span>
                  <span class="sr-only">{{ jobMark(song.id).title }}</span>
                </span>
              </p>
              <!-- Ingest progress rides under the title so it stays visible
                   no matter which columns the host has switched off. -->
              <p v-if="song.status === 'processing' && song.phase" class="song-item__sub">
                <span class="song-item__phase">{{ phaseLabel(song.phase) }}</span>
                <span v-if="song.progress != null" class="song-item__phase-pct">
                  · {{ song.progress }}%
                </span>
                <span v-else-if="song.message" class="song-item__phase-msg">
                  · {{ song.message }}
                </span>
              </p>
            </div>

            <div v-if="isVisible('artist')" class="lib-cell lib-cell--artist">
              <span class="song-item__artist">{{ song.artist || 'Unknown Artist' }}</span>
            </div>

            <div v-if="isVisible('duration')" class="lib-cell lib-cell--duration">
              <span class="song-item__duration">{{ formatDuration(song.duration) }}</span>
            </div>

            <div v-if="isVisible('added')" class="lib-cell lib-cell--added">
              <span class="song-item__added">{{ formatDate(song.created_at) }}</span>
            </div>

            <div v-if="isVisible('status')" class="lib-cell lib-cell--status">
              <Badge v-if="song.status !== 'ready' && song.status !== 'done'" :variant="song.status">
                <span v-if="song.status === 'processing'" class="spinner inline-spinner" />
                {{ song.status === 'processing' && song.phase ? phaseLabel(song.phase) : song.status }}
              </Badge>
              <span v-else class="song-item__status-ok">ready</span>
            </div>

            <div class="lib-cell lib-cell--actions song-item__actions" @click.stop>
              <button
                v-if="store.currentSong?.id === song.id"
                class="action-btn action-btn--active"
                title="Now playing"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--c-primary)">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </button>
              <button
                v-if="features.cdgExportEnabled && song.status === 'ready'"
                class="action-btn action-btn--export"
                title="Export CD+G"
                aria-label="Export CD+G"
                @click="exportTarget = song"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 15V4"/>
                  <polyline points="7 9 12 4 17 9"/>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                </svg>
              </button>
              <!-- Offered for EVERY status: a processing song's progress and
                   a failed song's error (and its retry) are the two states
                   that most need a way in, and neither can be loaded onto the
                   deck to reach a mixer. -->
              <button
                class="action-btn action-btn--tools"
                :class="{ 'action-btn--active': songTools.songId === song.id }"
                title="Song tools"
                aria-label="Song tools"
                @click="songTools.toggle(song.id)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.6"/>
                  <circle cx="12" cy="12" r="1.6"/>
                  <circle cx="19" cy="12" r="1.6"/>
                </svg>
              </button>
              <button
                class="action-btn action-btn--delete"
                title="Delete song"
                aria-label="Delete song"
                @click="deleteTarget = song"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14H6L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                  <path d="M9 6V4h6v2"/>
                </svg>
              </button>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </div>

    <!-- Extension mount: an installed package may register a panel component
         under the 'library-panel' slot to render beneath the local list.
         Core registers none, so this renders nothing in a stock build. -->
    <component
      :is="libraryPanel"
      v-if="libraryPanel"
      :query="searchInput"
      @library-changed="store.fetchSongs({ search: searchInput || '' })"
    />

    <!-- Confirm delete dialog -->
    <Modal
      :visible="!!deleteTarget"
      title="Delete Song?"
      :message="deleteTarget ? `${deleteTarget.title || deleteTarget.filename} will be permanently removed including all stems.` : ''"
      confirmLabel="Delete"
      confirmVariant="danger"
      @close="deleteTarget = null"
      @confirm="doDelete"
    />

    <!-- Single-song CD+G / MP3+G export dialog -->
    <SongExportModal :song="exportTarget" @close="exportTarget = null" />

    <!-- A 'library-menu' item's surface. Mounted only while open, so an
         item's component fetches nothing until the host asks for it. -->
    <Modal
      :visible="!!activeItem"
      :size="activeItem?.size || 'lg'"
      @close="activeItem = null"
    >
      <div v-if="activeItem" class="lib-item-modal">
        <h2 v-if="activeItem.title" class="lib-item-modal__title">{{ activeItem.title }}</h2>
        <component :is="activeItem.component" />
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useSongsStore, JOB_KIND_LABELS } from '@/stores/songs'
import { useSongToolsStore } from '@/stores/songTools'
import { useFeaturesStore } from '@/stores/features'
import { parseServerTs, formatServerDate } from '@/utils/serverTime'
import Badge from '@/components/ui/Badge.vue'
import Modal from '@/components/ui/Modal.vue'
import PopoverMenu from '@/components/ui/PopoverMenu.vue'
import SongExportModal from '@/components/SongExportModal.vue'
import { getSlot } from '@/plugins/slots'
import { usePlayGuard } from '@/composables/usePlayGuard'

const libraryPanel = getSlot('library-panel')

// Extra entries for the library ⋯ menu. An installed package may register an
// ARRAY under 'library-menu', each item:
//
//   id         string      — stable key
//   label      string      — menu text
//   icon       string?     — a glyph shown before the label
//   title      string?     — tooltip, and the heading of the modal it opens
//   size       string?     — Modal size ('sm' | 'md' | 'lg'; default 'lg')
//   component  Component   — mounted inside a core Modal when picked
//   visible    () => bool? — evaluated at render time; omitted = always shown.
//                            Called during render, so it may read stores.
//
// Core registers none, so the menu is just Refresh + Columns in a stock build.
const libraryMenu = getSlot('library-menu')
const extraItems = computed(() =>
  (Array.isArray(libraryMenu) ? libraryMenu : []).filter(i => !i.visible || i.visible()),
)
const activeItem = ref(null)
function openItem(item) { activeItem.value = item }

const store = useSongsStore()
const songTools = useSongToolsStore()
const features = useFeaturesStore()
const deleteTarget = ref(null)
const exportTarget = ref(null)
const searchInput = ref(store.searchQuery || '')

let searchTimer = null
watch(searchInput, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if ((val || '') !== (store.searchQuery || '')) {
      store.fetchSongs({ search: val || '' })
    }
  }, 250)
})
onUnmounted(() => { if (searchTimer) clearTimeout(searchTimer) })

function clearSearch() {
  searchInput.value = ''
}

const filters = computed(() => [
  { value: 'all',        label: 'All',        count: store.songs.length },
  { value: 'ready',      label: 'Ready',      count: store.songs.filter(s => s.status === 'ready').length },
  { value: 'processing', label: 'Processing', count: store.songs.filter(s => s.status === 'processing').length },
  { value: 'failed',     label: 'Failed',     count: store.songs.filter(s => s.status === 'failed').length }
])

// ─── Columns ────────────────────────────────────────────────────────────────
// `width` feeds the grid template. Title is locked visible: it is the row's
// identity, and a library with every label switched off is not a useful view.
const COLUMNS = [
  { key: 'title',    label: 'Title',    width: 'minmax(120px, 2fr)', locked: true },
  { key: 'artist',   label: 'Artist',   width: 'minmax(90px, 1fr)' },
  { key: 'duration', label: 'Time',     width: '52px' },
  { key: 'added',    label: 'Added',    width: '74px' },
  { key: 'status',   label: 'Status',   width: '80px' },
]

const COLUMNS_KEY = 'karaoke:libraryColumns'
const SORT_KEY = 'karaoke:librarySort'
const DEFAULT_VISIBLE = ['title', 'artist', 'duration']

function loadVisible() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMNS_KEY))
    if (Array.isArray(raw)) {
      // Drop unknown keys so a stale saved set can't resurrect a removed
      // column, and force the locked ones back on.
      const known = raw.filter(k => COLUMNS.some(c => c.key === k))
      const locked = COLUMNS.filter(c => c.locked).map(c => c.key)
      return Array.from(new Set([...known, ...locked]))
    }
  } catch { /* fall through to defaults */ }
  return [...DEFAULT_VISIBLE]
}

const visible = ref(loadVisible())

function isVisible(key) {
  return visible.value.includes(key)
}

function toggleColumn(key) {
  const col = COLUMNS.find(c => c.key === key)
  if (!col || col.locked) return
  visible.value = isVisible(key)
    ? visible.value.filter(k => k !== key)
    : [...visible.value, key]
}

watch(visible, (v) => {
  try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(v)) } catch { /* non-fatal */ }
}, { deep: true })

// Render columns in declared order, not click order.
const visibleColumns = computed(() => COLUMNS.filter(c => isVisible(c.key)))

const gridStyle = computed(() => ({
  // Actions track fits four 24px buttons plus the row's 0.25rem gaps.
  gridTemplateColumns: ['14px', ...visibleColumns.value.map(c => c.width), '112px'].join(' '),
}))

// ─── Library menu ──────────────────────────────────────────────────────────
// 'menu' | 'columns' — which face the ⋯ popover shows; reset on close.
const menuView = ref('menu')
const colPopEl = ref(null)
// The face swap happens inside an open popover, so its own open-time focus
// does not run again: hand focus to the first checkbox the host can change.
async function showColumns() {
  menuView.value = 'columns'
  await nextTick()
  colPopEl.value?.querySelector('input[type="checkbox"]:not(:disabled)')?.focus()
}
onMounted(() => {
  features.load()   // cached after the first call; gates the export action
})

// ─── Sorting ────────────────────────────────────────────────────────────────
// Default matches what the server already returns (created_at DESC), so a
// host who never touches a header sees the order they saw before.
function loadSort() {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY))
    if (raw && COLUMNS.some(c => c.key === raw.key) && (raw.dir === 'asc' || raw.dir === 'desc')) {
      return raw
    }
  } catch { /* fall through to defaults */ }
  return { key: 'added', dir: 'desc' }
}

const savedSort = loadSort()
const sortKey = ref(savedSort.key)
const sortDir = ref(savedSort.dir)

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Text reads best A→Z; time and recency read best largest-first.
    sortDir.value = (key === 'title' || key === 'artist' || key === 'status') ? 'asc' : 'desc'
  }
}

watch([sortKey, sortDir], () => {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ key: sortKey.value, dir: sortDir.value }))
  } catch { /* non-fatal */ }
})

// `parseServerTs` / `formatServerDate` are imported: the naive-UTC quirk they
// exist for is not this list's alone, and the Song tools panel shows the same
// timestamps.
function sortValue(song, key) {
  switch (key) {
    case 'title':    return (song.title || song.filename || '').toLowerCase()
    case 'artist':   return (song.artist || '').toLowerCase()
    // `|| null` not `?? null`: a 0 duration is unknown, not a zero-length
    // song, and formatDuration already renders it blank. The two must agree
    // or a blank cell sorts to the top.
    case 'duration': return song.duration || null
    case 'added':    return parseServerTs(song.created_at)
    case 'status':   return (song.status || '').toLowerCase()
    default:         return null
  }
}

function compare(a, b, key) {
  const av = sortValue(a, key)
  const bv = sortValue(b, key)
  // Missing values sort last in BOTH directions — a song with no duration is
  // not "the shortest", it is unknown, and flipping the arrow should not
  // parade the unknowns to the top.
  const aMissing = av === null || av === '' || Number.isNaN(av)
  const bMissing = bv === null || bv === '' || Number.isNaN(bv)
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  let cmp
  if (typeof av === 'string') cmp = av.localeCompare(bv)
  else cmp = av < bv ? -1 : av > bv ? 1 : 0
  return sortDir.value === 'asc' ? cmp : -cmp
}

const sortedSongs = computed(() => {
  const rows = [...store.filteredSongs]
  rows.sort((a, b) => {
    const primary = compare(a, b, sortKey.value)
    if (primary !== 0) return primary
    // Deterministic tiebreak so equal keys never shuffle between renders.
    return (a.id ?? 0) - (b.id ?? 0)
  })
  return rows
})

// ─── Formatting ─────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

const formatDate = formatServerDate

const PHASE_LABELS = {
  uploading: 'Uploading',
  queued: 'Queued',
  // A karaoke video moving through the import route. Without this the row read
  // a raw lowercase `importing` while the upload card said "Importing".
  importing: 'Importing',
  separating: 'Separating stems',
  fetching_lyrics: 'Fetching lyrics',
  transcribing: 'Transcribing',
  aligning: 'Aligning words',
  done: 'Ready',
  failed: 'Failed',
}

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || phase
}

// The row's view of a Song tools job: a spinner while it runs, a ✗ when the
// last one failed, nothing otherwise. Read from the store rather than held
// here, so the mark survives the panel being closed or re-pointed.
function jobMark(songId) {
  const job = store.jobFor(songId)
  if (!job) return null
  const kind = JOB_KIND_LABELS[job.kind] || 'Job'
  if (job.status === 'queued' || job.status === 'running') {
    return { running: true, title: `${kind} — ${job.phase || 'running'}` }
  }
  if (job.status === 'failed') {
    return { running: false, title: `${kind} failed: ${job.error || 'unknown error'}` }
  }
  return null
}

async function doDelete() {
  if (deleteTarget.value) {
    await store.deleteSong(deleteTarget.value.id)
    deleteTarget.value = null
  }
}


// Drag a ready song onto the rotation panel. The payload is also exposed as
// `text/plain` so platforms without our custom MIME (mobile Safari, etc.)
// degrade to plain text rather than firing a no-op drop.
const ROTATION_DRAG_MIME = 'application/x-karaoke-song'
function onDragStart(ev, song) {
  if (song.status !== 'ready') {
    ev.preventDefault()
    return
  }
  const payload = JSON.stringify({
    songId: song.id,
    title: song.title || song.filename || 'Untitled',
    artist: song.artist || '',
  })
  ev.dataTransfer.setData(ROTATION_DRAG_MIME, payload)
  ev.dataTransfer.setData('text/plain', payload)
  ev.dataTransfer.effectAllowed = 'copy'
}
</script>

<style scoped>
.song-list { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.song-list__header { flex-shrink: 0; padding: 0 0 0.5rem; }
.song-list__bar {
  display: flex; align-items: center; gap: 0.4rem;
  margin-bottom: 0.5rem; min-height: 36px;
}
.song-list__title {
  display: flex; align-items: center; gap: 0.45rem; min-width: 0;
  flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis;
  font-size: 0.8rem; font-weight: 600; color: rgba(255,255,255,0.5);
  text-transform: uppercase; letter-spacing: 0.08em; margin: 0;
  white-space: nowrap;
}
/* At the 300px minimum sidebar the row is over-full: the title text is what
   gives way (ellipsis); the icon, count and every button keep their size. */
.song-list__title svg,
.song-list__count { flex: none; }
.song-list__title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.song-list__spacer { flex: 1; min-width: 0; }

/* ── Library ⋯ menu ─────────────────────────────────────────────────────── */
.lib-menu__btn {
  flex: none;
  width: 30px; height: 30px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  background: none; border: 1px solid transparent;
  color: var(--text-secondary); font-size: 1.1rem; line-height: 1;
  cursor: pointer; transition: all 0.15s;
}
.lib-menu__btn:hover { background: var(--bg-glass-hover); color: white; }
.lib-menu__btn--open { color: var(--c-primary); background: var(--c-primary-bg); border-color: var(--c-primary-border); }
.lib-menu__btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }

/* Core Modal's own `title` prop switches it into confirm mode (Cancel /
   Confirm buttons), so an item's heading is rendered here instead. */
.lib-item-modal__title {
  margin: 0 0 0.75rem;
  font-size: 1.05rem; font-weight: 700; color: white; letter-spacing: -0.01em;
}

/* Column chooser — the ⋯ popover's second face. */
.col-menu__pop { min-width: 150px; }
.col-menu__heading {
  font-size: 0.65rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: rgba(255,255,255,0.35); padding: 0.15rem 0.35rem 0.3rem;
}
.col-menu__item {
  display: flex; align-items: center; gap: 0.45rem;
  padding: 0.3rem 0.35rem; border-radius: 0.3rem;
  font-size: 0.78rem; font-weight: 500; letter-spacing: 0;
  text-transform: none; color: var(--text-primary); cursor: pointer;
}
.col-menu__item:hover { background: rgba(255,255,255,0.06); }
.col-menu__item--locked { cursor: default; color: var(--text-secondary); }
.col-menu__item input { accent-color: var(--c-primary); cursor: inherit; }
.col-menu__lock { margin-left: auto; font-size: 0.65rem; color: var(--text-muted); }

.search-row {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 0.4rem;
}
.search-icon {
  position: absolute;
  left: 0.6rem;
  color: rgba(255,255,255,0.35);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 0.4rem 1.8rem 0.4rem 1.9rem;
  font-size: 0.8rem;
  color: var(--text-primary);
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 0.4rem;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.search-input::placeholder { color: rgba(255,255,255,0.3); }
.search-input:focus {
  background: rgba(255,255,255,0.06);
  border-color: var(--c-primary-border);
}
.search-input::-webkit-search-cancel-button { display: none; }
.search-clear {
  position: absolute;
  right: 0.4rem;
  width: 1.25rem; height: 1.25rem;
  display: flex; align-items: center; justify-content: center;
  font-size: 1rem; line-height: 1;
  color: rgba(255,255,255,0.5);
  background: transparent;
  border: none;
  border-radius: 0.3rem;
  cursor: pointer;
}
.search-clear:hover { color: white; background: rgba(255,255,255,0.08); }

.filter-tabs { display: flex; gap: 0.25rem; }
.filter-tab {
  display: flex; align-items: center; gap: 0.3rem;
  padding: 0.25rem 0.55rem; border-radius: 0.4rem;
  font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.45);
  background: transparent; border: 1px solid transparent;
  cursor: pointer; transition: all 0.15s;
}
.filter-tab:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.05); }
.filter-tab--active { color: var(--c-primary); background: var(--c-primary-bg); border-color: var(--c-primary-border); }
.filter-count { font-size: 0.7rem; opacity: 0.7; }

/* The body scrolls both ways: the sidebar is drag-resizable down to 300px,
   and a host with every column switched on can out-run that width. */
.song-list__body { flex: 1; overflow-y: auto; overflow-x: auto; position: relative; }
.lib-table { display: flex; flex-direction: column; gap: 0.25rem; min-width: min-content; }
.song-list__empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; color: rgba(255,255,255,0.25); font-size: 0.875rem; text-align: center; padding: 2rem; }
.song-skeleton { height: 44px; border-radius: 0.5rem; background: rgba(255,255,255,0.04); }

/* ── Header row ─────────────────────────────────────────────────────────── */
.lib-head {
  display: grid; align-items: center; gap: 0.5rem;
  position: sticky; top: 0; z-index: 5;
  padding: 0.2rem 0.6rem 0.3rem;
  background: var(--bg-app, #0d0f14);
  /* Rows carry a 1px transparent border; without a matching one here the
     header's grid tracks sit 1px off the rows' — visible on the
     right-aligned Time/Added columns. */
  border: 1px solid transparent;
  border-bottom-color: rgba(255,255,255,0.07);
}
.lib-th {
  display: flex; align-items: center; gap: 0.2rem; min-width: 0;
  padding: 0; background: transparent; border: none; cursor: pointer;
  font-size: 0.65rem; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: rgba(255,255,255,0.35);
  transition: color 0.15s;
}
.lib-th:hover { color: rgba(255,255,255,0.7); }
.lib-th--sorted { color: var(--c-primary); }
.lib-th__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-th__caret { flex-shrink: 0; }
.lib-th--duration, .lib-th--added { justify-content: flex-end; text-align: right; }

/* ── Rows ───────────────────────────────────────────────────────────────── */
.song-item {
  display: grid; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.6rem; border-radius: 0.5rem; cursor: pointer;
  border: 1px solid transparent; transition: background 0.18s, border-color 0.18s;
  background: rgba(255,255,255,0.03); position: relative;
}
.song-item:hover:not(.song-item--disabled) { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.08); }
.song-item--active { background: var(--c-primary-bg); border-color: var(--c-primary-border); }
.song-item--active .song-item__title { color: var(--c-primary); }
.song-item--disabled { cursor: default; opacity: 0.7; }
.song-item--draggable { cursor: grab; }
.song-item--draggable:active { cursor: grabbing; }

.lib-cell { min-width: 0; display: flex; align-items: center; }
.lib-cell--title { flex-direction: column; align-items: flex-start; gap: 0.05rem; }
.lib-cell--dot { justify-content: center; }
.lib-cell--duration, .lib-cell--added { justify-content: flex-end; }
.lib-cell--status { justify-content: flex-start; overflow: hidden; }
.lib-cell--actions { justify-content: flex-end; gap: 0.25rem; }

.song-item__dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.dot--ready { background: var(--c-success); box-shadow: 0 0 6px rgba(242, 207, 122,0.6); }
.dot--processing { background: var(--c-warning); animation: pulse 1.5s ease-in-out infinite; }
.dot--failed { background: var(--c-error); }
.dot--uploading { background: var(--c-info); }

.song-item__title { width: 100%; font-size: 0.875rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__video-mark {
  flex-shrink: 0;
  vertical-align: -1px;
  margin-right: 0.3rem;
  color: var(--text-muted);
}
.song-item--active .song-item__video-mark { color: var(--c-primary); }
.song-item__sub { width: 100%; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__artist { font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__phase { color: var(--c-warning); font-weight: 500; }
.song-item__phase-pct { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.song-item__phase-msg { color: var(--text-muted); }
.song-item__duration, .song-item__added { font-size: 0.75rem; font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }
.song-item__status-ok { font-size: 0.72rem; color: var(--c-success); opacity: 0.75; }

.song-item__actions { opacity: 0; transition: opacity 0.15s; }
.song-item:hover .song-item__actions { opacity: 1; }
.song-item--active .song-item__actions { opacity: 1; }

.action-btn {
  width: 24px; height: 24px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-glass); border: 1px solid var(--border-subtle);
  cursor: pointer; color: var(--text-secondary); transition: all 0.15s;
  flex-shrink: 0;
}
.action-btn:hover { background: var(--bg-glass-active); color: white; }
.action-btn--delete:hover { background: var(--c-error-bg); border-color: var(--c-error-border); color: var(--c-error); }
.action-btn--tools:hover { background: var(--c-primary-bg); border-color: var(--c-primary-border); color: var(--c-primary); }
.action-btn--export:hover { background: var(--c-primary-bg); border-color: var(--c-primary-border); color: var(--c-primary); }
.action-btn--active { background: var(--c-primary-bg); border-color: var(--c-primary-border); cursor: default; }
.action-btn .spinner { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.inline-spinner { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; border: 1px solid currentColor; border-top-color: transparent; }

.song-item__job {
  display: inline-flex;
  align-items: center;
  margin-left: 0.3rem;
  color: var(--c-primary);
  font-size: 0.7rem;
}
.song-item__job--failed { color: var(--c-error); }
.song-item__job .spinner { animation: spin 0.8s linear infinite; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
