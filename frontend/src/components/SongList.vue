<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div ref="rootEl" class="song-list" :class="{ 'song-list--col-resizing': colResizing }">
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
          <span :id="titleTextId" class="song-list__title-text">Library</span>
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

      <!-- Browse the library by song or by artist. -->
      <div class="lib-modes" role="group" aria-label="Browse by">
        <button
          type="button"
          class="lib-mode"
          :aria-pressed="browseMode === 'songs' ? 'true' : 'false'"
          @click="setBrowseMode('songs')"
        >Songs</button>
        <button
          type="button"
          class="lib-mode"
          :aria-pressed="browseMode === 'artists' ? 'true' : 'false'"
          @click="setBrowseMode('artists')"
        >Artists</button>
      </div>

      <div class="search-row">
        <div class="search-field">
          <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            v-model="searchModel"
            class="search-input"
            type="search"
            :placeholder="searchPlaceholder"
            :aria-label="searchLabel"
          />
          <button
            v-if="searchModel"
            class="search-clear"
            aria-label="Clear search"
            @click="clearSearch"
          >×</button>
        </div>

        <!-- Status filter and sort. The button shows an active state while a
             status other than All is chosen. -->
        <PopoverMenu align="end" label="Filter">
          <template #trigger="{ toggle, attrs, open }">
            <button
              type="button"
              class="filter-btn"
              :class="{ 'filter-btn--set': store.statusFilter !== 'all', 'filter-btn--open': open }"
              title="Filter"
              aria-label="Filter"
              v-bind="attrs"
              @click="toggle"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
            </button>
          </template>
          <div class="filter-menu" role="radiogroup" aria-label="Status" @keydown="onFilterKeydown">
            <button
              v-for="f in filters"
              :key="f.value"
              type="button"
              role="radio"
              class="ui-menu__item filter-menu__item"
              :data-filter="f.value"
              :aria-checked="store.statusFilter === f.value ? 'true' : 'false'"
              :tabindex="store.statusFilter === f.value ? 0 : -1"
              @click="store.statusFilter = f.value"
            >
              <span class="filter-menu__radio" aria-hidden="true" />
              <span class="filter-menu__label">{{ f.label }}</span>
              <span class="filter-menu__count">{{ f.count }}</span>
            </button>
          </div>
          <hr class="ui-menu__sep" />
          <label class="filter-menu__sort">
            <span>Sort</span>
            <select
              class="sort-select"
              aria-label="Sort library"
              :value="sortKey"
              @change="setSort($event.target.value)"
            >
              <option v-for="opt in SORT_OPTIONS" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
            </select>
          </label>
        </PopoverMenu>
      </div>
    </div>

    <!-- Artists: the artist index, one button per artist. -->
    <div v-if="browseMode === 'artists' && selectedArtist === null" class="song-list__body">
      <div v-if="store.loading && !store.songs.length">
        <div v-for="i in 3" :key="i" class="song-skeleton shimmer" />
      </div>
      <div v-else-if="!artistIndex.length" class="song-list__empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <p>{{ !store.songs.length && !store.uploads.length ? 'Add files to get started' : 'No matching artists' }}</p>
      </div>
      <ul v-else class="artist-list" aria-label="Artists">
        <li v-for="a in artistIndex" :key="a.artist">
          <button
            type="button"
            class="artist-row"
            :data-artist="a.artist"
            @click="openArtist(a.artist)"
          >
            <span class="artist-row__name">{{ a.artist || 'Unknown Artist' }}</span>
            <span class="artist-row__count">{{ a.count }} {{ a.count === 1 ? 'song' : 'songs' }}</span>
            <svg class="artist-row__chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </li>
      </ul>
    </div>

    <template v-else>
    <!-- Drilled into one artist: the way back, then that artist's songs. -->
    <div v-if="inArtist" class="artist-crumb">
      <button ref="artistBackEl" type="button" class="artist-crumb__back" @click="backToArtists">← All artists</button>
      <span class="artist-crumb__name">{{ selectedArtist || 'Unknown Artist' }}</span>
    </div>

    <!-- Loading skeleton -->
    <div v-if="tableLoading" class="song-list__body">
      <div v-for="i in 3" :key="i" class="song-skeleton shimmer" />
    </div>

    <!-- Empty state — only when local list is empty -->
    <div
      v-else-if="!tableRows.length && (inArtist || !store.uploads.length)"
      class="song-list__empty"
    >
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
      <p>{{ !inArtist && store.songs.length === 0 ? 'Add files to get started' : 'No songs match this filter' }}</p>
    </div>

    <!-- Song table. The list never scrolls sideways: when the panel is
         narrower than the chosen columns need, rows fall back to a compact
         two-line layout (title over artist) with the same actions button. -->
    <div v-else class="song-list__body">
      <!-- A grid with one roving Tab stop: the arrow keys move between rows,
           Enter or Space loads a ready song, Delete asks to remove it, and →
           steps into the row's ⋯ button. -->
      <div class="lib-table" role="grid" :aria-labelledby="titleTextId">
        <!-- Sortable header; separators between columns drag their widths. -->
        <div v-if="!compact" ref="headEl" class="lib-head" role="row" :style="gridStyle">
          <span class="lib-cell lib-cell--dot" role="columnheader"><span class="sr-only">Status</span></span>
          <button
            v-for="(col, i) in visibleColumns"
            :key="col.key"
            class="lib-th"
            :class="[`lib-th--${col.key}`, { 'lib-th--sorted': sortKey === col.key }]"
            role="columnheader"
            :aria-sort="sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
            :title="`Sort by ${col.label}`"
            @click="onHeaderClick(col.key)"
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
            <span
              v-if="i < visibleColumns.length - 1"
              class="lib-th__resize"
              :data-col="col.key"
              aria-hidden="true"
              @pointerdown.stop.prevent="startColResize($event, i)"
              @click.stop
            />
          </button>
          <span class="lib-cell lib-cell--more" role="columnheader"><span class="sr-only">Actions</span></span>
        </div>

        <TransitionGroup name="list">
          <div
            v-for="song in sortedSongs"
            :key="song.id"
            class="song-item"
            role="row"
            :data-song-id="song.id"
            :tabindex="song.id === rovingId ? 0 : -1"
            :style="compact ? null : gridStyle"
            :class="{
              'song-item--compact': compact,
              'song-item--active': store.currentSong?.id === song.id,
              'song-item--disabled': song.status !== 'ready',
              'song-item--draggable': song.status === 'ready'
            }"
            :draggable="song.status === 'ready'"
            @dragstart="onDragStart($event, song)"
            @click="song.status === 'ready' && store.loadSong(song)"
            @focusin="activeRowId = song.id"
            @keydown="onRowKeydown($event, song)"
          >
            <div class="lib-cell lib-cell--dot" role="gridcell">
              <span class="song-item__dot" :class="`dot--${song.status}`" />
            </div>

            <div v-if="compact || isVisible('title')" class="lib-cell lib-cell--title" role="gridcell">
              <p class="song-item__title">
                <template v-if="store.currentSong?.id === song.id">
                  <svg
                    class="song-item__playing"
                    width="10" height="10" viewBox="0 0 24 24"
                    fill="var(--c-primary)" aria-hidden="true"
                  ><polygon points="5,3 19,12 5,21"/></svg>
                  <span class="sr-only">Now playing: </span>
                </template>
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
                     title, not the row menu: the whole reason to show it here
                     is that the panel may be closed or pointed at a different
                     song. -->
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
              <p
                v-if="song.status === 'processing' && song.phase"
                class="song-item__sub"
                :title="statusLineText(song)"
              >
                <span class="song-item__phase">{{ phaseLabel(song.phase) }}</span>
                <span v-if="song.progress != null" class="song-item__phase-pct">
                  · {{ song.progress }}%
                </span>
                <span v-else-if="song.message" class="song-item__phase-msg">
                  · {{ song.message }}
                </span>
                <span v-if="staleMinutes(song) != null" class="song-item__phase-msg song-item__stale">
                  · last update {{ staleMinutes(song) }} min ago
                </span>
              </p>
              <p v-else-if="compact" class="song-item__line2">{{ song.artist || 'Unknown Artist' }}</p>
            </div>

            <template v-if="compact">
              <div
                class="song-item__meta"
                role="gridcell"
                :class="{ 'song-item__meta--time': song.status === 'ready' && !!song.duration }"
              >
                <Badge v-if="song.status === 'failed'" variant="failed">Failed</Badge>
                <span v-else-if="song.status === 'ready' && song.duration" class="song-item__duration">
                  {{ formatDuration(song.duration) }}
                </span>
              </div>
            </template>
            <template v-else>
              <div v-if="isVisible('artist')" class="lib-cell lib-cell--artist" role="gridcell">
                <span class="song-item__artist">{{ song.artist || 'Unknown Artist' }}</span>
              </div>

              <div v-if="isVisible('duration')" class="lib-cell lib-cell--duration" role="gridcell">
                <span class="song-item__duration">{{ formatDuration(song.duration) }}</span>
              </div>

              <div v-if="isVisible('added')" class="lib-cell lib-cell--added" role="gridcell">
                <span class="song-item__added">{{ formatDate(song.created_at) }}</span>
              </div>

              <div v-if="isVisible('status')" class="lib-cell lib-cell--status" role="gridcell">
                <Badge v-if="song.status !== 'ready' && song.status !== 'done'" :variant="song.status">
                  <span v-if="song.status === 'processing'" class="spinner inline-spinner" />
                  {{ song.status === 'processing' && song.phase ? phaseLabel(song.phase) : song.status }}
                </Badge>
                <span v-else class="song-item__status-ok">ready</span>
              </div>
            </template>

            <!-- The row's one always-visible action: a menu holding Song
                 tools, Export and Delete. Song tools is offered for EVERY
                 status: a processing song's progress and a failed song's error
                 (and its retry) are the two states that most need a way in,
                 and neither can be loaded onto the deck to reach a mixer. -->
            <div class="lib-cell lib-cell--more" role="gridcell" @click.stop>
              <PopoverMenu role="menu" align="end" :label="`Actions for ${songName(song)}`">
                <template #trigger="{ toggle, attrs, open }">
                  <button
                    type="button"
                    class="more-btn"
                    :class="{ 'more-btn--open': open }"
                    :tabindex="song.id === rovingId ? 0 : -1"
                    title="Song actions"
                    :aria-label="`Actions for ${songName(song)}`"
                    v-bind="attrs"
                    @click="toggle"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.7"/>
                      <circle cx="12" cy="12" r="1.7"/>
                      <circle cx="19" cy="12" r="1.7"/>
                    </svg>
                  </button>
                </template>
                <template #default="{ close }">
                  <p class="ui-menu__section">{{ songName(song) }}</p>
                  <button
                    type="button"
                    role="menuitem"
                    class="ui-menu__item row-menu__tools"
                    @click="close(); songTools.toggle(song.id)"
                  >
                    <span class="ui-menu__icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/>
                        <circle cx="16" cy="6" r="2"/>
                        <circle cx="10" cy="12" r="2"/>
                        <circle cx="18" cy="18" r="2"/>
                      </svg>
                    </span>Song tools…
                  </button>
                  <button
                    v-if="features.cdgExportEnabled && song.status === 'ready'"
                    type="button"
                    role="menuitem"
                    class="ui-menu__item row-menu__export"
                    @click="close(); exportTarget = song"
                  >
                    <span class="ui-menu__icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 15V4"/>
                        <polyline points="7 9 12 4 17 9"/>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      </svg>
                    </span>Export CD+G…
                  </button>
                  <hr class="ui-menu__sep" />
                  <button
                    type="button"
                    role="menuitem"
                    class="ui-menu__item ui-menu__item--danger row-menu__delete"
                    @click="close(); deleteTarget = song"
                  >
                    <span class="ui-menu__icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14H6L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4h6v2"/>
                      </svg>
                    </span>Delete song…
                  </button>
                </template>
              </PopoverMenu>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </div>
    </template>

    <!-- Extension mount: an installed package may register a panel component
         under the 'library-panel' slot to render beneath the local list.
         Core registers none, so this renders nothing in a stock build. -->
    <component
      :is="libraryPanel"
      v-if="libraryPanel && browseMode === 'songs'"
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
      :busy="deleting"
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
import { ref, computed, watch, nextTick, onMounted, onUnmounted, useId } from 'vue'
import { useSongsStore, JOB_KIND_LABELS } from '@/stores/songs'
import { useSongToolsStore } from '@/stores/songTools'
import { useFeaturesStore } from '@/stores/features'
import { parseServerTs, formatServerDate } from '@/utils/serverTime'
import Badge from '@/components/ui/Badge.vue'
import Modal from '@/components/ui/Modal.vue'
import PopoverMenu from '@/components/ui/PopoverMenu.vue'
import SongExportModal from '@/components/SongExportModal.vue'
import { getSlot } from '@/plugins/slots'

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
const deleting = ref(false)
const exportTarget = ref(null)
const searchInput = ref(store.searchQuery || '')

let searchTimer = null
watch(searchInput, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    // The Songs search narrows the library only while Songs view is showing.
    if (browseMode.value !== 'songs') return
    if ((val || '') !== (store.searchQuery || '')) {
      store.fetchSongs({ search: val || '' })
    }
  }, 250)
})
onUnmounted(() => { if (searchTimer) clearTimeout(searchTimer) })

// ─── Songs | Artists ────────────────────────────────────────────────────────
// 'songs' is the full library table. 'artists' is the artist index, and
// picking an artist drills into the same table for that artist's songs. Each
// view keeps its own search text.
const browseMode = ref('songs')
const selectedArtist = ref(null)      // null = the artist index
const artistQuery = ref('')
const drillQuery = ref('')
const artistBackEl = ref(null)
const inArtist = computed(() => browseMode.value === 'artists' && selectedArtist.value !== null)

const searchModel = computed({
  get() {
    if (browseMode.value === 'songs') return searchInput.value
    return selectedArtist.value === null ? artistQuery.value : drillQuery.value
  },
  set(v) {
    if (browseMode.value === 'songs') searchInput.value = v
    else if (selectedArtist.value === null) artistQuery.value = v
    else drillQuery.value = v
  },
})
const searchPlaceholder = computed(() => {
  if (browseMode.value === 'songs') return 'Search title, artist, or filename…'
  return selectedArtist.value === null ? 'Search artists' : 'Search this artist’s songs'
})
const searchLabel = computed(() =>
  browseMode.value === 'songs' ? 'Search library' : searchPlaceholder.value,
)

// The artist views read the whole library, so the Songs search text stays in
// its box but is lifted from the library while they show, and put back on
// return.
function setBrowseMode(mode) {
  if (browseMode.value === mode) return
  browseMode.value = mode
  selectedArtist.value = null
  drillQuery.value = ''
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  const wanted = mode === 'songs' ? (searchInput.value || '') : ''
  if (wanted !== (store.searchQuery || '')) store.fetchSongs({ search: wanted })
}

async function openArtist(artist) {
  selectedArtist.value = artist
  drillQuery.value = ''
  activeRowId.value = null
  // The artist's button is gone; keep focus in the panel.
  await nextTick()
  artistBackEl.value?.focus()
}

async function backToArtists() {
  const artist = selectedArtist.value
  selectedArtist.value = null
  drillQuery.value = ''
  await nextTick()
  const rows = rootEl.value?.querySelectorAll('.artist-row') || []
  const back = [...rows].find(el => el.dataset.artist === artist)
  ;(back || rows[0])?.focus()
}

// Search in the artist views runs over the loaded library: case, accents and
// punctuation are ignored and the words may come in any order.
function fold(text) {
  return (text || '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '').replace(/\p{P}/gu, '')
}
function matchesQuery(query, ...fields) {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const folded = fields.map(f => fold(f).replace(/\s+/g, ''))
  return words.every(w => folded.some(f => f.includes(w)))
}

// The artist index, built from the library itself: every status counts, the
// active status filter applies, and an empty artist name is its own entry
// (shown as Unknown Artist, listed last).
const artistIndex = computed(() => {
  const counts = new Map()
  for (const song of store.filteredSongs) {
    const name = song.artist || ''
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts]
    .filter(([name]) => matchesQuery(artistQuery.value, name || 'Unknown Artist'))
    .sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
    .map(([artist, count]) => ({ artist, count }))
})

function clearSearch() {
  searchModel.value = ''
}

// The rows the table shows: the library, or one artist's songs. Both read
// the library list, so deletes and processing updates reach either view.
const tableRows = computed(() => {
  if (!inArtist.value) return store.filteredSongs
  return store.filteredSongs.filter(s =>
    (s.artist || '') === selectedArtist.value
    && matchesQuery(drillQuery.value, s.title, s.filename),
  )
})
const tableLoading = computed(() => store.loading)

// Status radios inside the filter popover: one Tab stop, the arrow keys move
// and choose, as native radios do.
function onFilterKeydown(e) {
  const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
  if (!(e.key in keys)) return
  e.preventDefault()
  const group = e.currentTarget
  const list = filters.value.map(f => f.value)
  const i = list.indexOf(store.statusFilter)
  const next = list[(i + keys[e.key] + list.length) % list.length]
  store.statusFilter = next
  nextTick(() => group?.querySelector(`[data-filter="${next}"]`)?.focus())
}

const filters = computed(() => [
  { value: 'all',        label: 'All',        count: store.songs.length },
  { value: 'ready',      label: 'Ready',      count: store.songs.filter(s => s.status === 'ready').length },
  { value: 'processing', label: 'Processing', count: store.songs.filter(s => s.status === 'processing').length },
  { value: 'failed',     label: 'Failed',     count: store.songs.filter(s => s.status === 'failed').length }
])

// ─── Columns ────────────────────────────────────────────────────────────────
// Title is locked visible: it is the row's identity, and a library with every
// label switched off is not a useful view. Title always flexes to take the
// remaining room. Artist flexes too until the host drags its width; the other
// columns are fixed at `width` px (also draggable). `min` is the narrowest a
// column renders and what the fit check below counts for a flexing column.
const COLUMNS = [
  { key: 'title',    label: 'Title',  min: 120, flex: '2fr', locked: true },
  { key: 'artist',   label: 'Artist', min: 90,  flex: '1fr', resizeMin: 60 },
  { key: 'duration', label: 'Time',   min: 40,  width: 52 },
  { key: 'added',    label: 'Added',  min: 56,  width: 74 },
  { key: 'status',   label: 'Status', min: 56,  width: 80 },
]
const MAX_COL_WIDTH = 480

const COLUMNS_KEY = 'karaoke:libraryColumns'
const COLUMN_WIDTHS_KEY = 'karaoke:libraryColumnWidths'
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

// ─── Column widths ──────────────────────────────────────────────────────────
// Dragged widths in px, keyed by column. Title has none: it flexes.
function resizeMin(col) { return col.resizeMin ?? col.min }
function clampColWidth(col, w) {
  return Math.round(Math.min(MAX_COL_WIDTH, Math.max(resizeMin(col), w)))
}

function loadWidths() {
  const out = {}
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY))
    if (raw && typeof raw === 'object') {
      for (const col of COLUMNS) {
        const w = Number(raw[col.key])
        if (!col.locked && Number.isFinite(w) && w > 0) out[col.key] = clampColWidth(col, w)
      }
    }
  } catch { /* fall through to defaults */ }
  return out
}

const colWidths = ref(loadWidths())

function saveWidths() {
  try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(colWidths.value)) } catch { /* non-fatal */ }
}

function colPx(col) {
  return colWidths.value[col.key] ?? col.width ?? null
}

function colTrack(col) {
  const px = colPx(col)
  return px != null ? `${px}px` : `minmax(${col.min}px, ${col.flex})`
}

const MORE_TRACK = 28
const DOT_TRACK = 14
const GRID_GAP = 8            // .song-item gap: 0.5rem
const ROW_CHROME = 22         // row padding (2 × 0.6rem) + 1px borders
const SCROLLBAR = 8           // the vertical scrollbar (6px webkit, thin in Firefox)

const gridStyle = computed(() => ({
  gridTemplateColumns: [
    `${DOT_TRACK}px`, ...visibleColumns.value.map(colTrack), `${MORE_TRACK}px`,
  ].join(' '),
}))

// The narrowest list that shows the chosen columns without clipping.
function colFitPx(col) { return colPx(col) ?? col.min }
const columnsFitWidth = computed(() => {
  const cols = visibleColumns.value
  const tracks = cols.reduce((sum, c) => sum + colFitPx(c), 0)
  return ROW_CHROME + SCROLLBAR + DOT_TRACK + tracks + MORE_TRACK + GRID_GAP * (cols.length + 1)
})

// The widest `col` can be while the columns still fit the measured list.
// Unmeasured lists impose no limit beyond MAX_COL_WIDTH.
function maxFittingWidth(col) {
  if (!(listWidth.value > 0)) return MAX_COL_WIDTH
  return listWidth.value - (columnsFitWidth.value - colFitPx(col))
}

// A width saved on a wider panel must not lock this one into compact rows:
// on the first measure, shrink oversize saved widths (right to left) until
// the columns fit, but never below what the column would take by default.
// In memory only; the saved preference is untouched until the next drag.
function fitSavedWidths() {
  const next = { ...colWidths.value }
  for (const col of [...visibleColumns.value].reverse()) {
    const w = next[col.key]
    if (w == null) continue
    const excess = columnsFitWidth.value - listWidth.value
    if (excess <= 0) break
    const floor = Math.min(w, col.width ?? col.min)
    next[col.key] = Math.max(floor, w - excess)
    colWidths.value = { ...next }
  }
}

// Separator i sits on the right edge of visible column i. Dragging it moves
// that edge: a fixed column grows with the pointer; the flexing title instead
// gives its room to (or takes it from) the column to its right.
const headEl = ref(null)
let colDrag = null
let colDragEndedAt = -Infinity
const colResizing = ref(false)
// The layout in force when a drag started; held until it ends so a drag
// never flips the list between columns and compact rows.
const heldCompact = ref(null)

function measuredWidth(key) {
  const el = headEl.value?.querySelector(`.lib-th--${key}`)
  return el ? el.getBoundingClientRect().width : 0
}

function startColResize(e, i) {
  const cols = visibleColumns.value
  const left = cols[i]
  const target = left.locked ? cols[i + 1] : left
  if (!target) return
  const start = colPx(target) ?? Math.max(target.min, measuredWidth(target.key))
  colDrag = { col: target, sign: target === left ? 1 : -1, startX: e.clientX, start, moved: false }
  heldCompact.value = compact.value
  colResizing.value = true
  window.addEventListener('pointermove', onColResizeMove)
  window.addEventListener('pointerup', stopColResize)
}

function onColResizeMove(e) {
  if (!colDrag) return
  const dx = e.clientX - colDrag.startX
  if (dx !== 0) colDrag.moved = true
  const col = colDrag.col
  const wanted = clampColWidth(col, colDrag.start + colDrag.sign * dx)
  // Never wider than the list leaves room for; never under the column's floor.
  const w = Math.max(resizeMin(col), Math.min(wanted, Math.floor(maxFittingWidth(col))))
  colWidths.value = { ...colWidths.value, [col.key]: w }
}

function stopColResize() {
  window.removeEventListener('pointermove', onColResizeMove)
  window.removeEventListener('pointerup', stopColResize)
  // A drag that ends over a header must not also count as a sort click.
  if (colDrag?.moved) {
    colDragEndedAt = performance.now()
    saveWidths()
  }
  colDrag = null
  heldCompact.value = null
  colResizing.value = false
}

onUnmounted(() => {
  window.removeEventListener('pointermove', onColResizeMove)
  window.removeEventListener('pointerup', stopColResize)
})

function onHeaderClick(key) {
  if (performance.now() - colDragEndedAt < 300) return
  toggleSort(key)
}

// ─── Layout ─────────────────────────────────────────────────────────────────
// The panel is user-resizable, so the layout follows the list's own measured
// width rather than the viewport. Unmeasured (or hidden, width 0) keeps the
// columns.
const rootEl = ref(null)
const listWidth = ref(0)
let resizeObs = null

const compact = computed(() => {
  if (heldCompact.value !== null) return heldCompact.value
  return listWidth.value > 0 && listWidth.value < columnsFitWidth.value
})

let savedWidthsFitted = false
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !rootEl.value) return
  resizeObs = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (!entry) return
    listWidth.value = entry.contentRect?.width ?? 0
    if (!savedWidthsFitted && listWidth.value > 0) {
      savedWidthsFitted = true
      fitSavedWidths()
    }
  })
  resizeObs.observe(rootEl.value)
})
onUnmounted(() => { resizeObs?.disconnect(); resizeObs = null })

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

// The sort choice in the filter popover; column headers also sort.
const SORT_OPTIONS = [
  { key: 'added',    label: 'Date added' },
  { key: 'title',    label: 'Title' },
  { key: 'artist',   label: 'Artist' },
  { key: 'duration', label: 'Time' },
  { key: 'status',   label: 'Status' },
]

function setSort(key) {
  if (key === sortKey.value || !SORT_OPTIONS.some(o => o.key === key)) return
  toggleSort(key)
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
  const rows = [...tableRows.value]
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

// A processing row whose stage has not moved for STALE_AFTER_MIN minutes gets
// its age appended, so a slow stage can be told from a dead one. One shared
// clock re-renders the age between polls.
const STALE_AFTER_MIN = 2
const now = ref(Date.now())
let nowTimer = null
onMounted(() => { nowTimer = setInterval(() => { now.value = Date.now() }, 30_000) })
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); nowTimer = null })

function staleMinutes(song) {
  if (song.status !== 'processing') return null
  const at = store.jobLastChangeAt(song.id)
  if (at == null) return null
  const mins = Math.floor((now.value - at) / 60_000)
  return mins >= STALE_AFTER_MIN ? mins : null
}

// The status line truncates at narrow widths and the age is its last part,
// so the whole line also rides on its title.
function statusLineText(song) {
  let text = phaseLabel(song.phase)
  if (song.progress != null) text += ` · ${song.progress}%`
  else if (song.message) text += ` · ${song.message}`
  const mins = staleMinutes(song)
  if (mins != null) text += ` · last update ${mins} min ago`
  return text
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

function songName(song) {
  return song.title || song.filename || 'Unknown Title'
}

async function doDelete() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  const at = sortedSongs.value.findIndex(s => s.id === target.id)
  const deletedRow = rowEl(target.id)
  deleting.value = true
  try {
    await store.deleteSong(target.id)
  } finally {
    deleting.value = false
  }
  deleteTarget.value = null
  // The confirm hands focus back to the row it was opened from. If that row
  // is gone (or only still leaving, during the list transition), the next
  // row (or the new last one) takes it.
  await nextTick()
  if (sortedSongs.value.some(s => s.id === target.id)) return
  const rows = sortedSongs.value
  if (!rows.length) return
  const active = document.activeElement
  const lost = !active || active === document.body || !active.isConnected
    || (deletedRow && deletedRow.contains(active))
  if (!lost) return
  focusRow(rows[Math.min(Math.max(at, 0), rows.length - 1)].id)
}

// ─── Keyboard ───────────────────────────────────────────────────────────────
// One row at a time is the list's Tab stop. It follows focus, and falls back
// to the loaded song, then the first row, whenever the list no longer holds it
// (search, a status tab, a sort or a delete).
const titleTextId = `song-list-title-${useId()}`
const activeRowId = ref(null)
const rovingId = computed(() => {
  const rows = sortedSongs.value
  if (rows.some(s => s.id === activeRowId.value)) return activeRowId.value
  const current = store.currentSong?.id
  if (current != null && rows.some(s => s.id === current)) return current
  return rows[0]?.id ?? null
})

function rowEl(id) {
  return rootEl.value?.querySelector(`.song-item[data-song-id="${id}"]`) || null
}

async function focusRow(id) {
  activeRowId.value = id
  await nextTick()
  const el = rowEl(id)
  if (!el) return
  el.focus()
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

function moveRow(song, to) {
  const rows = sortedSongs.value
  if (!rows.length) return
  const i = rows.findIndex(s => s.id === song.id)
  const next = to === 'first' ? 0
    : to === 'last' ? rows.length - 1
    : Math.min(rows.length - 1, Math.max(0, i + to))
  focusRow(rows[next].id)
}

function onRowKeydown(e, song) {
  const row = e.currentTarget
  if (e.target === row) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveRow(song, 1); break
      case 'ArrowUp': e.preventDefault(); moveRow(song, -1); break
      case 'Home': e.preventDefault(); moveRow(song, 'first'); break
      case 'End': e.preventDefault(); moveRow(song, 'last'); break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (song.status === 'ready') store.loadSong(song)
        break
      case 'Delete': e.preventDefault(); deleteTarget.value = song; break
      case 'ArrowRight': e.preventDefault(); row.querySelector('.more-btn')?.focus(); break
    }
    return
  }
  // From the row's ⋯ button: ← back to the row, ↑/↓ on to the next rows.
  if (!e.target.classList?.contains('more-btn')) return
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); row.focus(); break
    case 'ArrowDown': e.preventDefault(); moveRow(song, 1); break
    case 'ArrowUp': e.preventDefault(); moveRow(song, -1); break
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
.song-list { display: flex; flex-direction: column; height: 100%; overflow: hidden; container: lib / inline-size; }
.song-list--col-resizing { cursor: col-resize; user-select: none; }
.song-list--col-resizing * { cursor: col-resize !important; }
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
/* At the narrowest panels the word gives way rather than reading "LIBR…";
   the icon and count stay, and the name stays for screen readers. */
@container lib (max-width: 300px) {
  .song-list__title-text {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
}
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

/* ── Songs | Artists ────────────────────────────────────────────────────── */
.lib-modes {
  display: flex; gap: 2px; padding: 2px; margin-bottom: 0.4rem;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 0.4rem;
}
.lib-mode {
  flex: 1; height: 24px; border: 1px solid transparent; border-radius: 0.3rem;
  background: none; color: rgba(255,255,255,0.45);
  font-family: inherit; font-size: 0.75rem; font-weight: 500;
  cursor: pointer; transition: all 0.15s;
}
.lib-mode:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.05); }
.lib-mode[aria-pressed="true"] {
  color: var(--c-primary); background: var(--c-primary-bg);
  border-color: var(--c-primary-border); font-weight: 600;
}
.lib-mode:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }

.search-row { display: flex; align-items: center; gap: 0.35rem; }
.search-field { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
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

/* ── Filter popover ─────────────────────────────────────────────────────── */
.filter-btn {
  position: relative; flex: none;
  width: 31px; height: 31px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 0.4rem; color: var(--text-secondary);
  cursor: pointer; transition: all 0.15s;
}
.filter-btn:hover { background: var(--bg-glass-hover); color: white; }
.filter-btn--open,
.filter-btn--set { color: var(--c-primary); background: var(--c-primary-bg); border-color: var(--c-primary-border); }
.filter-btn--set::after {
  content: ""; position: absolute; top: 4px; right: 4px;
  width: 5px; height: 5px; border-radius: 50%; background: var(--c-primary);
}
.filter-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
.filter-menu__radio {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 1px solid rgba(255,255,255,0.3);
  display: inline-flex; align-items: center; justify-content: center;
}
.filter-menu__item[aria-checked="true"] .filter-menu__radio { border-color: var(--c-primary); }
.filter-menu__item[aria-checked="true"] .filter-menu__radio::after {
  content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--c-primary);
}
.filter-menu__item[aria-checked="true"] .filter-menu__label { color: white; }
.filter-menu__count {
  margin-left: auto; padding-left: 1rem;
  font-size: 0.72rem; color: var(--text-muted); font-variant-numeric: tabular-nums;
}
.filter-menu__sort {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.3rem 0.6rem; font-size: 0.78rem; color: var(--text-secondary);
}

/* ── Artists ────────────────────────────────────────────────────────────── */
.artist-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.artist-row {
  width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto 12px;
  align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem;
  background: rgba(255,255,255,0.03); border: 1px solid transparent; border-radius: 0.5rem;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}
.artist-row:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.08); }
.artist-row:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
.artist-row__name {
  font-size: 0.82rem; font-weight: 600; color: var(--text-primary); letter-spacing: -0.015em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.artist-row__count { font-size: 0.75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.artist-row__chev { color: var(--text-muted); }
.artist-crumb { flex-shrink: 0; display: flex; align-items: center; gap: 0.5rem; min-width: 0; margin: 0 0 0.35rem; }
.artist-crumb__back {
  flex: none; padding: 0.2rem 0.5rem; border-radius: 0.4rem;
  font-family: inherit; font-size: 0.72rem; font-weight: 500;
  color: rgba(255,255,255,0.55); background: transparent;
  border: 1px solid rgba(255,255,255,0.1); cursor: pointer;
}
.artist-crumb__back:hover { color: white; background: rgba(255,255,255,0.05); }
.artist-crumb__back:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
.artist-crumb__name {
  min-width: 0; font-size: 0.8rem; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Never sideways: the layout switches to compact rows rather than letting
   the chosen columns out-run the panel. */
.song-list__body { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; scrollbar-width: thin; }
.lib-table { display: flex; flex-direction: column; gap: 0.25rem; }
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
.lib-th { position: relative; overflow: visible; }
.lib-th__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Column separator, centred in the 0.5rem gap after its header. */
.lib-th__resize {
  position: absolute; top: -2px; bottom: -2px; right: calc(-0.25rem - 4px);
  width: 9px; cursor: col-resize; z-index: 1;
  display: flex; justify-content: center;
}
.lib-th__resize::before {
  content: ""; width: 1px; height: 100%;
  background: rgba(255,255,255,0.14); transition: background 0.15s;
}
.lib-th__resize:hover::before { background: rgba(255,255,255,0.6); }
.lib-th__caret { flex-shrink: 0; }
.lib-th--duration, .lib-th--added { justify-content: flex-end; text-align: right; }

/* ── Rows ───────────────────────────────────────────────────────────────── */
.song-item {
  display: grid; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.6rem; border-radius: 0.5rem; cursor: pointer;
  border: 1px solid transparent; transition: background 0.18s, border-color 0.18s;
  background: rgba(255,255,255,0.03); position: relative;
}
.song-item:hover:not(.song-item--disabled),
.song-item:focus-within:not(.song-item--disabled) { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.08); }
.song-item--active { background: var(--c-primary-bg); border-color: var(--c-primary-border); }
.song-item--active .song-item__title { color: var(--c-primary); }
.song-item--disabled { cursor: default; }
.song-item:focus { outline: none; }
.song-item:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
/* Dim what cannot be played, not the actions button that still works. */
.song-item--disabled > .lib-cell:not(.lib-cell--more),
.song-item--disabled > .song-item__meta { opacity: 0.7; }
.song-item--draggable { cursor: grab; }
.song-item--draggable:active { cursor: grabbing; }

.lib-cell { min-width: 0; display: flex; align-items: center; }
.lib-cell--title { flex-direction: column; align-items: flex-start; gap: 0.05rem; }
.lib-cell--dot { justify-content: center; }
.lib-cell--duration, .lib-cell--added { justify-content: flex-end; }
.lib-cell--status { justify-content: flex-start; overflow: hidden; }
.lib-cell--more { justify-content: flex-end; }

.song-item__dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.dot--ready { background: var(--c-success); box-shadow: 0 0 6px rgba(242, 207, 122,0.6); }
.dot--processing { background: var(--c-warning); animation: pulse 1.5s ease-in-out infinite; }
.dot--failed { background: var(--c-error); }
.dot--uploading { background: var(--c-info); }

/* Title and artist run slightly smaller and tighter so more of each fits at
   realistic panel widths. */
.song-item__title,
.song-item__artist,
.song-item__line2 { letter-spacing: -0.015em; }
.song-item__title { width: 100%; margin: 0; font-size: 0.82rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__playing { vertical-align: -1px; margin-right: 0.3rem; }
.song-item__video-mark {
  flex-shrink: 0;
  vertical-align: -1px;
  margin-right: 0.3rem;
  color: var(--text-muted);
}
.song-item--active .song-item__video-mark { color: var(--c-primary); }
.song-item__sub { width: 100%; margin: 0; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__artist { font-size: 0.76rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__phase { color: var(--c-warning); font-weight: 500; }
.song-item__phase-pct { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.song-item__phase-msg { color: var(--text-muted); }
.song-item__duration, .song-item__added { font-size: 0.75rem; font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }
.song-item__status-ok { font-size: 0.72rem; color: var(--c-success); opacity: 0.75; }

/* ── Compact two-line row ───────────────────────────────────────────────── */
.song-item--compact { grid-template-columns: 14px minmax(0, 1fr) auto 28px; padding: 0.4rem 0.35rem 0.4rem 0.6rem; }
.song-item__line2 { width: 100%; margin: 0; font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-item__meta { display: flex; align-items: center; justify-content: flex-end; }
/* The time drops out before the title is squeezed. */
@container lib (max-width: 250px) { .song-item__meta--time { display: none; } }

.sort-select {
  font: inherit; font-size: 0.72rem; color: var(--text-secondary);
  background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm); padding: 0.1rem 0.3rem;
}
.sort-select option { background: #171b25; }

/* ── Row actions button ─────────────────────────────────────────────────── */
.more-btn {
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center; padding: 0;
  background: transparent; border: 1px solid var(--border-subtle);
  color: var(--text-secondary); cursor: pointer; flex-shrink: 0; transition: all 0.15s;
}
.more-btn:hover,
.more-btn--open { background: var(--c-primary-bg); border-color: var(--c-primary-border); color: var(--c-primary); }
.more-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
.song-item--active .more-btn { border-color: var(--c-primary-border); }
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
