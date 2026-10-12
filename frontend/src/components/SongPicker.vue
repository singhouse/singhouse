<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="picker">
    <!--
      The picker is a trigger, not an input. Nearly every user of this is a
      guest on a phone: an inline dropdown under a focused field competed with
      the soft keyboard for the bottom half of the screen, and — worse — it was
      bound to focus, so dismissing the keyboard to read the results was the
      very gesture that destroyed them. Search lives in a sheet instead, whose
      open/closed state nothing but an explicit action can change.
    -->
    <button
      type="button"
      class="picker__trigger"
      :disabled="busy"
      @click="openSheet"
    >
      <span class="picker__trigger-icon" aria-hidden="true">🔍</span>
      <span class="picker__trigger-text">{{ selection || placeholder }}</span>
    </button>

    <Teleport to="body">
      <div v-show="sheetOpen" class="sheet" :style="sheetStyle">
        <div class="sheet__scrim" @click="closeSheet"></div>

        <div
          class="sheet__panel"
          role="dialog"
          aria-modal="true"
          aria-label="Search for a song"
        >
          <div class="sheet__modes" role="group" aria-label="Browse by">
            <button v-for="option in ['Songs', 'Artists']" :key="option" type="button"
              :aria-pressed="browseMode === option" :disabled="singerImporting"
              @click="setBrowseMode(option)">{{ option }}</button>
          </div>
          <div v-if="selectedArtist !== null" class="sheet__modes sheet__artist-heading">
            <button type="button" @click="browseArtist(null, $event)">← All artists</button>
            <strong>{{ selectedArtist || 'Unknown artist' }}</strong>
          </div>
          <div class="sheet__bar">
            <input
              ref="inputRef"
              v-model="query"
              @input="onInput"
              @keydown="onKey"
              @blur="activeIndex = -1"
              class="sheet__input"
              type="search"
              :placeholder="browseMode === 'Artists' ? (selectedArtist === null ? 'Search artists' : 'Search this artist’s songs') : placeholder"
              :aria-label="browseMode === 'Artists' ? (selectedArtist === null ? 'Search artists' : 'Search this artist’s songs') : placeholder"
              :disabled="singerImporting"
              maxlength="200"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              enterkeyhint="search"
              role="combobox"
              aria-autocomplete="list"
              :aria-controls="listId"
              :aria-expanded="results.length > 0"
              :aria-activedescendant="activeIndex >= 0 ? rowId(activeIndex) : null"
            />
            <button type="button" class="sheet__cancel" @click="closeSheet">
              Cancel
            </button>
          </div>

          <ul :id="listId" class="sheet__results" role="listbox" aria-label="Search results">
            <li
              v-for="(r, idx) in results"
              :key="r.key"
              :id="rowId(idx)"
              class="sheet__row"
              :class="{
                'sheet__row--tappable': isRowClickable(r),
                'sheet__row--catalog': r.source === 'catalog',
                'sheet__row--active': idx === activeIndex,
              }"
              :role="rowAction(r) ? 'option' : null"
              :aria-selected="rowAction(r) ? idx === activeIndex : null"
              :tabindex="isRowClickable(r) ? 0 : null"
              @click="onRowClick(r, $event)"
              @keydown.enter="onRowClick(r, $event)"
              @keydown.space.prevent="onRowClick(r, $event)"
            >
              <span
                class="sheet__badge"
                :class="{ 'sheet__badge--catalog': r.source === 'catalog' }"
                :title="r.source === 'catalog' ? `From ${r.providerLabel} catalog` : 'In our catalog'"
              >{{ r.source === 'catalog' ? (r.providerIcon || '🎼') : '📀' }}</span>
              <div class="sheet__meta">
                <div class="sheet__title">{{ r.title }}</div>
                <div class="sheet__artist">
                  <span
                    v-if="r.source === 'catalog' && imports[importKey(r)]?.error"
                    class="sheet__error"
                  >{{ imports[importKey(r)].error }}</span>
                  <span
                    v-else-if="r.source === 'catalog' && imports[importKey(r)]?.status"
                    class="sheet__status"
                  >{{ imports[importKey(r)].status }}</span>
                  <template v-else>{{ r.source === 'artist' ? `${r.count} songs` : r.artist }}</template>
                </div>
              </div>
              <button
                v-if="r.source === 'catalog' && mode === 'host'"
                class="sheet__dl"
                :class="{
                  'sheet__dl--done': imports[importKey(r)]?.done,
                  'sheet__dl--err': imports[importKey(r)]?.error,
                }"
                :disabled="imports[importKey(r)]?.importing || imports[importKey(r)]?.done"
                @click.stop="importFromCatalog(r)"
              >
                <template v-if="imports[importKey(r)]?.done">✓ Imported</template>
                <template v-else-if="imports[importKey(r)]?.importing">…</template>
                <template v-else-if="imports[importKey(r)]?.error">Retry</template>
                <template v-else>Import</template>
              </button>
            </li>

            <!-- role=presentation: a listbox's children must be options, and
                 these are status text, not choices. -->
            <li v-if="searching" role="presentation" class="sheet__note">Searching…</li>
            <li v-else-if="searchError" role="presentation" class="sheet__note sheet__note--err">
              {{ searchError }}
            </li>
            <li v-else-if="!results.length" role="presentation" class="sheet__note">{{ emptyNote }}</li>
          </ul>

          <div v-if="browseMode === 'Artists' && total > pageSize" class="sheet__modes" aria-label="Pagination">
            <button type="button" :disabled="page === 1 || searching" @click="changePage(-1)">Previous</button>
            <span>Page {{ page }} of {{ Math.ceil(total / pageSize) }}</span>
            <button type="button" :disabled="page * pageSize >= total || searching" @click="changePage(1)">Next</button>
          </div>
          <div v-if="showFreehand" class="sheet__foot">
            <button type="button" class="sheet__freehand" @click="submitFreehand">
              ＋ Add “{{ query.trim() }}” as a new request
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onBeforeUnmount, watch, useId } from 'vue'
import { songApi } from '@/api/client'
import { getSlot } from '@/plugins/slots'

const catalog = getSlot('catalog')

const props = defineProps({
  // This is button-face text now, not just a placeholder. Copy here is
  // legally load-bearing — it describes the host's own library, never "any song".
  placeholder: { type: String, default: 'Search the library or type a song title' },
  // Shown on the trigger face in place of `placeholder` once something is
  // picked, so the trigger can double as the pick's display. The sheet's
  // search input always uses `placeholder` — never route picked text there.
  selection: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  // 'host'   — catalog rows show an Import button; tap-to-pick for local rows only
  // 'singer' — catalog rows are tap-to-pick; tap silently imports then picks the local id
  // NB: role-named but behavior-valued — the host rotation add-form mounts
  // 'singer' to get tap-imports-then-pick. Nothing guest-specific (limits,
  // gating, confirmation) may ever hang off this prop; add a new prop instead.
  mode: { type: String, default: 'host' },
})
const emit = defineEmits(['pick'])

const inputRef = ref(null)
const query = ref('')
const browseMode = ref('Songs')
const selectedArtist = ref(null)
const page = ref(1)
const total = ref(0)
const pageSize = 40
const searching = ref(false)
const results = ref([])     // normalized rows
const searchError = ref(null)
const imports = reactive({}) // "provider:externalId" → { importing, status, error, done, localSongId }
const singerImporting = ref(false)
let timer = null
let queryToken = 0

function importKey(r) { return `${r.provider}:${r.externalId}` }

function formatSong(s) { return `${s.artist} — ${s.title}` }

const exactMatch = computed(() => {
  const q = query.value.trim().toLowerCase()
  return results.value.some(r => formatSong(r).toLowerCase() === q)
})

const showFreehand = computed(() =>
  browseMode.value === 'Songs' && !!query.value.trim() && !exactMatch.value && !singerImporting.value
)

const emptyNote = computed(() =>
  browseMode.value === 'Artists' ? 'No matching artists or songs in this library.' : query.value.trim().length < 2
    ? 'Type at least two letters to search.'
    : 'Nothing here matches — add it as a request below.'
)

// ─── The sheet ──────────────────────────────────────────────────────────────

const sheetOpen = ref(false)
// Set from visualViewport while the sheet is open. A `position: fixed` overlay
// does not shrink when the soft keyboard opens — that is the whole reason the
// old dropdown was unreadable — so we size the sheet to the *visual* viewport
// and the results list keeps whatever space the keyboard leaves us.
const viewport = ref(null)
let returnFocusTo = null

const sheetStyle = computed(() =>
  viewport.value
    ? { '--sheet-h': `${viewport.value.h}px`, '--sheet-top': `${viewport.value.top}px` }
    : {}
)

function readViewport() {
  const vv = window.visualViewport
  viewport.value = vv ? { h: vv.height, top: vv.offsetTop } : null
}

function onKeydown(e) {
  if (e.key === 'Escape') closeSheet()
}

async function openSheet() {
  if (props.busy || sheetOpen.value) return
  // Focus has to come back out of the sheet when it closes, or it lands on
  // <body> and a keyboard user has to tab in from the top of the page again.
  returnFocusTo = document.activeElement
  activeIndex.value = -1
  sheetOpen.value = true
  readViewport()
  window.visualViewport?.addEventListener('resize', readViewport)
  window.visualViewport?.addEventListener('scroll', readViewport)
  window.addEventListener('keydown', onKeydown)
  // nextTick keeps this inside the click's microtask chain, which is what iOS
  // Safari requires to raise the keyboard from a programmatic focus().
  await nextTick()
  inputRef.value?.focus()
}

function closeSheet() {
  if (!sheetOpen.value) return
  sheetOpen.value = false
  teardownSheet()
}

function teardownSheet() {
  window.visualViewport?.removeEventListener('resize', readViewport)
  window.visualViewport?.removeEventListener('scroll', readViewport)
  window.removeEventListener('keydown', onKeydown)
  viewport.value = null
  inputRef.value?.blur()
  if (returnFocusTo?.isConnected) returnFocusTo.focus()
  returnFocusTo = null
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  ++queryToken
  teardownSheet()
})

// ─── Search ─────────────────────────────────────────────────────────────────

function isRowClickable(r) {
  if (r.source === 'local' || r.source === 'artist') return true
  if (r.source === 'catalog' && props.mode === 'singer') {
    return !imports[importKey(r)]?.importing
  }
  return false
}

// ─── Keyboard navigation ────────────────────────────────────────────────────
// Arrow keys move a highlight through the actionable rows while focus stays in
// the input (aria-activedescendant pattern — moving DOM focus would kill live
// typing). Enter activates the highlight; with none, it keeps its original
// freehand-submit meaning. ArrowUp past the first row returns to that state.

const activeIndex = ref(-1)
// Element ids must be unique per instance: two pickers can be mounted at once
// (queue panel + rotation add-form) and both teleport their sheets to <body>.
const uid = useId()
const listId = `${uid}-list`
function rowId(idx) { return `${uid}-row-${idx}` }

function onKey(e) {
  // An active IME composition owns these keys (candidate-window navigation /
  // commit) — 229 is the legacy signal some browsers still report. Bail
  // before preventDefault or the candidate window becomes unnavigable.
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); onEnter() }
}

// A row is keyboard-actionable if it is tappable, or if it is a host-mode
// catalog row whose action is the Import button.
function rowAction(r) {
  if (isRowClickable(r)) return () => onRowClick(r)
  if (r.source === 'catalog' && props.mode === 'host') {
    return () => importFromCatalog(r)
  }
  return null
}

function moveActive(dir) {
  // Directional scan from the current position, so the highlight keeps its
  // place even if the row under it stopped being actionable in the meantime.
  const rows = results.value
  let found = -1
  for (let i = activeIndex.value + dir; i >= 0 && i < rows.length; i += dir) {
    if (rowAction(rows[i])) { found = i; break }
  }
  if (dir > 0) {
    // Bottom edge clamps: ArrowDown past the last actionable row stays put.
    if (found >= 0) activeIndex.value = found
  } else {
    // Top edge escapes: stepping up past the first actionable row lands on
    // -1 (no highlight), restoring Enter's freehand meaning.
    activeIndex.value = found
  }
  if (activeIndex.value >= 0) {
    document.getElementById(rowId(activeIndex.value))?.scrollIntoView({ block: 'nearest' })
  }
}

function onEnter() {
  const r = results.value[activeIndex.value]
  const action = r ? rowAction(r) : null
  if (action) action()
  else submitFreehand()
}

// Fresh results invalidate the highlight — indices no longer point at the
// same rows. (While a stale list is still on screen mid-debounce the
// highlight stays, which is correct: Enter acts on what is visibly lit.)
watch(results, () => { activeIndex.value = -1 })

function setBrowseMode(mode) {
  if (browseMode.value === mode) return
  browseMode.value = mode
  selectedArtist.value = null
  query.value = ''
  onInput()
}

async function browseArtist(artist, event) {
  // A keyboard-activated row/back button disappears on drill-down. Keep
  // focus in the dialog, but do not summon a phone keyboard after a tap.
  const active = document.activeElement
  const restoreFocus = event && (event.type === 'keydown' || event.detail === 0)
    && active !== inputRef.value && event.currentTarget?.contains(active)
  selectedArtist.value = artist
  query.value = ''
  onInput()
  if (restoreFocus) {
    await nextTick()
    if (sheetOpen.value) inputRef.value?.focus()
  }
}

function changePage(delta) {
  page.value += delta
  loadBrowse()
}

async function loadBrowse() {
  clearTimeout(timer)
  const token = ++queryToken
  results.value = []
  searchError.value = null
  searching.value = true
  try {
    const artist = selectedArtist.value
    const response = artist === null
      ? await songApi.artists({ search: query.value.trim(), page: page.value, pageSize })
      : await songApi.list({ artistExact: artist, search: query.value.trim(), status: 'ready', page: page.value, pageSize })
    if (token !== queryToken) return
    total.value = response.data.total
    results.value = artist === null
      ? response.data.items.map(row => ({ ...row, source: 'artist', key: `artist-${row.artist}`, title: row.artist || 'Unknown artist' }))
      : response.data.songs.map(row => ({ ...row, source: 'local', key: `local-${row.id}` }))
  } catch {
    if (token === queryToken) searchError.value = 'Library browsing is not responding. Try searching again.'
  } finally {
    if (token === queryToken) searching.value = false
  }
}

function onInput() {
  if (browseMode.value === 'Artists') {
    page.value = 1
    loadBrowse()
    return
  }
  clearTimeout(timer)
  const q = query.value.trim()
  searchError.value = null
  // Bump BEFORE the length check: shortening the query has to invalidate an
  // already-dispatched request too, or its results land under the shorter
  // query and repopulate a list the user just erased.
  const myToken = ++queryToken
  if (q.length < 2) {
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    try {
      const [localRes, catalogRes] = await Promise.allSettled([
        songApi.list({ search: q, pageSize: 8 }),
        catalog ? catalog.searchCatalog(q) : Promise.resolve([]),
      ])
      if (myToken !== queryToken) return  // a newer query started; drop these results

      // allSettled swallows a rejected request, so a backend that is simply
      // down arrives here as an empty result set. Saying "nothing matches"
      // then is a false claim about the host's library — the guest concludes
      // it isn't there and types a freehand request for a song that is.
      if (localRes.status === 'rejected') {
        searchError.value = 'Library search is not responding — you can still type the song in below.'
      }
      const local = localRes.status === 'fulfilled'
        ? (localRes.value.data?.songs || []).filter(s => s.status === 'ready')
        : []
      // NB: must not be named `catalog` — that shadows the setup-scope slot
      // binding above and puts its use in the Promise.allSettled array into the
      // temporal dead zone, throwing before the catalog request is ever sent.
      const catalogHits = catalogRes.status === 'fulfilled' ? catalogRes.value : []

      // De-dupe catalog hits that match a local song by (artist, title).
      const localKeys = new Set(local.map(s => keyOf(s.artist, s.title)))
      const catalogFiltered = catalogHits.filter(c => !localKeys.has(keyOf(c.artist, c.title)))

      const merged = [
        ...local.map(s => ({
          source: 'local',
          key: `local-${s.id}`,
          id: s.id,
          title: s.title,
          artist: s.artist,
        })),
        ...catalogFiltered.map(c => ({
          source: 'catalog',
          key: `${c.provider}-${c.external_id}`,
          provider: c.provider,
          providerLabel: c.providerLabel,
          providerIcon: c.providerIcon,
          externalId: c.external_id,
          title: c.title,
          artist: c.artist,
        })),
      ]
      results.value = merged.slice(0, 10)
    } catch (e) {
      // Covers the *synchronous* throw — a slot that blows up while the
      // request is being built. That used to leave `searching` stuck true and
      // the type-ahead silently dead, which is how the TDZ shadow noted above
      // hid for so long. Catch rather than just finally: this runs off a
      // timer, so an escaping rejection has nobody to land on.
      if (myToken !== queryToken) return
      results.value = []
      searchError.value = 'Search is not responding — you can still type the song in below.'
    } finally {
      if (myToken === queryToken) searching.value = false
    }
  }, 250)
}

function keyOf(artist, title) {
  return `${(artist || '').trim().toLowerCase()}|${(title || '').trim().toLowerCase()}`
}

function reset() {
  // Disarm any pending debounce and invalidate its token, or a search typed
  // just before the pick fires afterwards and refills the list behind us.
  clearTimeout(timer)
  ++queryToken
  query.value = ''
  browseMode.value = 'Songs'
  selectedArtist.value = null
  total.value = 0
  results.value = []
  searching.value = false
  searchError.value = null
  closeSheet()
}

function pickLocal(r) {
  emit('pick', formatSong(r), r.id)
  reset()
}

function onRowClick(r, event) {
  if (!isRowClickable(r)) return
  if (r.source === 'artist') {
    browseArtist(r.artist, event)
  } else if (r.source === 'local') {
    pickLocal(r)
  } else if (r.source === 'catalog' && props.mode === 'singer') {
    pickCatalogSinger(r)
  }
}

// Singer flow — transparently import then pick. The sheet stays open and the
// input is disabled until the import completes.
async function pickCatalogSinger(r) {
  const key = importKey(r)
  imports[key] = { importing: true, status: 'Importing…', error: null, done: false }
  singerImporting.value = true
  try {
    const localId = await catalog.importCatalog(r.provider, r.externalId, {
      onProgress: (job) => {
        if (imports[key]) imports[key].status = job?.message || 'Importing…'
      },
    })
    imports[key].importing = false
    imports[key].done = true
    imports[key].status = ''
    emit('pick', formatSong(r), localId)
    reset()
  } catch (e) {
    imports[key].importing = false
    imports[key].error = e.message || 'Import failed'
    imports[key].status = ''
  } finally {
    singerImporting.value = false
  }
}

// Host flow — kick off import in the background; row converts to "✓ Imported".
// The host can keep typing / browsing while it runs.
async function importFromCatalog(r) {
  const key = importKey(r)
  if (imports[key]?.importing || imports[key]?.done) return
  imports[key] = { importing: true, status: 'Queued — importing…', error: null, done: false }
  try {
    const localId = await catalog.importCatalog(r.provider, r.externalId, {
      onProgress: (job) => {
        if (imports[key]) imports[key].status = job?.message || 'Importing…'
      },
    })
    imports[key].importing = false
    imports[key].done = true
    imports[key].status = ''
    imports[key].localSongId = localId
  } catch (e) {
    imports[key].importing = false
    imports[key].error = e.message || 'Import failed'
    imports[key].status = ''
  }
}

function submitFreehand() {
  const text = query.value.trim()
  if (browseMode.value !== 'Songs' || !text) return
  emit('pick', text, null)
  reset()
}
</script>

<style scoped>
.picker { position: relative; }
.sheet__modes { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0.75rem; color: white; flex-shrink: 0; }
.sheet__modes button { min-height: 44px; padding: 0.5rem 0.8rem; border: 1px solid #555; border-radius: 0.5rem; background: transparent; color: white; cursor: pointer; }
.sheet__modes button[aria-pressed="true"] { background: #932b43; }
.sheet__modes button:disabled { opacity: 0.5; cursor: default; }
.sheet__artist-heading button { flex-shrink: 0; }
.sheet__artist-heading strong { min-width: 0; overflow-wrap: anywhere; }

/* ─── Trigger ─── */
.picker__trigger {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: 52px;
  padding: 0.75rem 0.9rem;
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 0.5rem;
  color: rgba(255,255,255,0.45);
  font-size: 1rem;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.picker__trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.picker__trigger:active:not(:disabled) { background: rgba(0,0,0,0.55); }
@media (hover: hover) {
  .picker__trigger:hover:not(:disabled) { border-color: rgba(226,62,87,0.5); }
}
.picker__trigger-icon { flex-shrink: 0; font-size: 0.95rem; }
.picker__trigger-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── Sheet ─── */
.sheet {
  position: fixed;
  left: 0;
  right: 0;
  top: var(--sheet-top, 0px);
  /* --sheet-h is the visualViewport height, set while open. The static
     fallbacks only matter on browsers without visualViewport. */
  height: var(--sheet-h, 100vh);
  z-index: 200;
  display: flex;
}
@supports (height: 100dvh) {
  .sheet { height: var(--sheet-h, 100dvh); }
}

.sheet__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.6);
}

.sheet__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  /* Opaque, not translucent: this gets read at arm's length in a dark room
     with a projector behind it. */
  background: #0a0d1c;
}

.sheet__bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  padding: 0.75rem;
  padding-top: max(0.75rem, env(safe-area-inset-top));
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.sheet__input {
  flex: 1;
  min-width: 0;
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(226,62,87,0.35);
  color: white;
  padding: 0.7rem 0.85rem;
  border-radius: 0.5rem;
  /* Must stay >= 16px or iOS zooms the page on focus. */
  font-size: 1rem;
  font-family: inherit;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}
.sheet__input:focus { border-color: rgba(226,62,87,0.7); }
.sheet__input:disabled { opacity: 0.5; }
.sheet__cancel {
  flex-shrink: 0;
  min-height: 44px;
  padding: 0.5rem 0.6rem;
  background: none;
  border: none;
  color: #e23e57;
  font-size: 0.95rem;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}

.sheet__results {
  list-style: none;
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0.35rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.sheet__row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  /* Comfortably past the 44px tap-target floor; phones are the whole audience. */
  min-height: 56px;
  padding: 0.6rem 0.65rem;
  border-radius: 0.45rem;
  font-size: 0.95rem;
}
.sheet__row--tappable { cursor: pointer; }
.sheet__row--tappable:active { background: rgba(226,62,87,0.22); }
.sheet__row--tappable:focus-visible {
  outline: 2px solid rgba(226,62,87,0.9);
  outline-offset: -2px;
}
/* Hover only where a pointer can actually hover — on touch it sticks after a
   tap and leaves a phantom selection behind. */
@media (hover: hover) {
  .sheet__row--tappable:hover { background: rgba(226,62,87,0.12); }
}
/* Keyboard highlight — same treatment as row focus, since it means the same
   thing: "Enter acts here". */
.sheet__row--active {
  background: rgba(226,62,87,0.12);
  outline: 2px solid rgba(226,62,87,0.9);
  outline-offset: -2px;
}
.sheet__row--catalog:not(.sheet__row--tappable) { cursor: default; }

.sheet__badge { font-size: 1.05rem; flex-shrink: 0; }
.sheet__badge--catalog { filter: drop-shadow(0 0 4px rgba(255,180,80,0.4)); }
.sheet__meta { flex: 1; min-width: 0; }
.sheet__title {
  font-weight: 600;
  color: rgba(255,255,255,0.92);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sheet__artist {
  font-size: 0.8rem;
  color: rgba(255,255,255,0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sheet__status { color: #fbbf24; font-weight: 500; }
.sheet__error { color: #fb7f5c; font-weight: 500; }

.sheet__dl {
  flex-shrink: 0;
  min-height: 44px;
  background: rgba(255,180,80,0.12);
  border: 1px solid rgba(255,180,80,0.35);
  color: #fbbf24;
  padding: 0.4rem 0.7rem;
  border-radius: 0.35rem;
  font-size: 0.8rem;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}
.sheet__dl:disabled { cursor: default; }
.sheet__dl--done {
  background: rgba(242, 207, 122,0.12);
  border-color: rgba(242, 207, 122,0.35);
  color: #86efac;
  opacity: 1;
}
.sheet__dl--err {
  background: rgba(251, 127, 92,0.12);
  border-color: rgba(251, 127, 92,0.35);
  color: #fca5a5;
}

.sheet__note {
  padding: 1.2rem 0.75rem;
  text-align: center;
  font-size: 0.88rem;
  color: rgba(255,255,255,0.4);
}
.sheet__note--err { color: #fca5a5; }

/* Pinned, not appended: "it isn't in the library" is the most likely outcome
   for a guest, and that action must never sit below ten scrolled rows. */
.sheet__foot {
  flex-shrink: 0;
  padding: 0.6rem 0.75rem;
  padding-bottom: max(0.6rem, env(safe-area-inset-bottom));
  border-top: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.02);
}
.sheet__freehand {
  display: block;
  width: 100%;
  min-height: 52px;
  padding: 0.8rem;
  background: rgba(226,62,87,0.12);
  border: 1px solid rgba(226,62,87,0.35);
  border-radius: 0.5rem;
  color: #93c0ff;
  font-size: 0.95rem;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet__freehand:active { background: rgba(226,62,87,0.25); }

/* Desktop: the same thing, as a centred dialog. */
@media (min-width: 640px) and (min-height: 520px) {
  .sheet { align-items: center; justify-content: center; padding: 2rem; }
  .sheet__panel {
    max-width: 560px;
    max-height: 100%;
    height: auto;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 0.9rem;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .sheet__results { min-height: 220px; max-height: 60vh; }
}
</style>
