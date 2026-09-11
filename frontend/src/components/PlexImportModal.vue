<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="plex-modal">
    <!-- Title -->
    <div class="plex-modal__title">
      <span class="title-icon">🎞</span>
      <h2>Import from your Plex library</h2>
    </div>

    <!-- ── Connection ─────────────────────────────────────────── -->
    <section class="plex-section">
      <h3 class="plex-section__heading">Connection</h3>

      <p v-if="envManaged" class="plex-modal__note">
        Configured by the server's environment.
      </p>

      <div class="plex-form">
        <label class="plex-field">
          <span class="plex-field__label">Plex server URL</span>
          <input
            v-model="urlInput"
            class="plex-input"
            type="text"
            :disabled="envManaged"
            placeholder="http://plex.lan:32400"
            aria-label="Plex server URL"
          />
        </label>

        <label class="plex-field">
          <span class="plex-field__label">Plex token</span>
          <input
            v-model="tokenInput"
            class="plex-input"
            type="password"
            :disabled="envManaged"
            :placeholder="settings.token_set ? 'Token set — leave blank to keep it' : 'Plex token'"
            aria-label="Plex token"
          />
        </label>
      </div>

      <div class="plex-actions">
        <button
          class="plex-btn"
          :disabled="envManaged || saving || testing"
          @click="onSave"
        >{{ saving ? 'Saving…' : 'Save' }}</button>
        <button
          class="plex-btn"
          :disabled="testing || saving"
          @click="onTest"
          :title="hasUnsavedChanges ? 'Saves your changes, then tests the connection' : 'Tests the saved connection'"
        >{{ testing ? 'Testing…' : 'Test connection' }}</button>
      </div>
    </section>

    <p v-if="error" class="plex-modal__error">{{ error }}</p>
    <p v-if="notice" class="plex-modal__notice">{{ notice }}</p>

    <!-- ── Browse + import ────────────────────────────────────── -->
    <section class="plex-section">
      <h3 class="plex-section__heading">Your collection</h3>

      <div class="plex-controls">
        <label class="plex-field plex-field--inline">
          <span class="plex-field__label">Library</span>
          <select
            v-model="libraryKey"
            class="plex-input plex-input--select"
            aria-label="Plex music library"
            @change="onLibraryChange"
          >
            <option value="" disabled>Choose a library</option>
            <option v-for="lib in libraries" :key="lib.key" :value="lib.key">
              {{ lib.title }}
            </option>
          </select>
        </label>

        <label class="plex-field plex-field--filter">
          <span class="plex-field__label">Artist</span>
          <input
            v-model="filterArtist"
            class="plex-input plex-input--filter"
            type="text"
            maxlength="200"
            placeholder="Filter by artist"
            aria-label="Filter by artist"
            @input="onFilterInput"
          />
        </label>

        <label class="plex-field plex-field--filter">
          <span class="plex-field__label">Title</span>
          <input
            v-model="filterTitle"
            class="plex-input plex-input--filter"
            type="text"
            maxlength="200"
            placeholder="Filter by title"
            aria-label="Filter by title"
            @input="onFilterInput"
          />
        </label>
      </div>

      <ul v-if="tracks.length" class="plex-tracks">
        <li v-for="track in tracks" :key="track.rating_key" class="plex-track">
          <label class="plex-track__label">
            <input
              type="checkbox"
              class="plex-track__check"
              :value="track.rating_key"
              :checked="isSelected(track)"
              @change="toggle(track)"
            />
            <span class="plex-track__text">
              <span class="plex-track__title">{{ track.title }}</span>
              <span class="plex-track__meta">
                — {{ track.artist }}<template v-if="track.album"> · {{ track.album }}</template>
              </span>
            </span>
            <span
              v-if="track.has_lyrics"
              class="plex-track__badge"
              title="This track has lyrics on the server"
            >♪</span>
          </label>
        </li>
      </ul>

      <p v-else-if="fetchedOnce && !loadingTracks" class="plex-modal__empty">
        {{ filterActive ? 'No tracks match.' : 'No tracks to show.' }}
      </p>

      <div v-if="tracks.length || offset > 0" class="plex-paging">
        <button class="plex-btn" :disabled="offset === 0 || loadingTracks" @click="prevPage">
          ‹ Previous
        </button>
        <span class="plex-paging__label">{{ pageLabel }}</span>
        <button class="plex-btn" :disabled="!hasNextPage || loadingTracks" @click="nextPage">
          Next ›
        </button>
        <button class="plex-btn" :disabled="!tracks.length" @click="selectAllOnPage">
          Select all on page
        </button>
      </div>

      <p v-if="lyricsNoteVisible" class="plex-modal__hint">
        Plex lyrics are not used as an alignment reference unless the operator
        enables {{ features.plexLyricsEnv }}.
      </p>

      <div class="plex-actions plex-actions--end">
        <button
          class="plex-btn plex-btn--primary"
          :disabled="!selectedCount || importing"
          @click="onImport"
        >{{ importLabel }}</button>
      </div>
    </section>
  </div>
</template>

<script setup>
// Import songs from a Plex media server the operator runs themselves. Two
// halves, deliberately in one dialog: the connection has to be right before
// the browse below it can show anything, and splitting them into two places
// would mean an operator whose token expired sees an empty list with no
// explanation next to it.
//
// The token is write-only from here. The server never returns it, so the
// field's placeholder ("Token set") is the only readback there is, and leaving
// it blank on save means "keep the one you have".
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { plexApi } from '@/api/client'
import { useFeaturesStore } from '@/stores/features'
import { useSongsStore } from '@/stores/songs'

const PAGE_SIZE = 100
// Matches the API's own cap on a filter term.
const MAX_FILTER_LENGTH = 200

const features = useFeaturesStore()
const store = useSongsStore()

const settings = ref({ url: '', token_set: false, source: 'settings', lyrics_enabled: false })
const urlInput = ref('')
const tokenInput = ref('')

const libraries = ref([])
const libraryKey = ref('')
const tracks = ref([])
const total = ref(0)
const offset = ref(0)
const filterArtist = ref('')
const filterTitle = ref('')
const fetchedOnce = ref(false)

// Keyed by rating_key so a selection survives paging away and back — the row
// object is a fresh literal on every fetch, so identity is no use here.
const selected = ref(new Map())

const saving = ref(false)
const testing = ref(false)
const importing = ref(false)
const loadingTracks = ref(false)
const error = ref('')
const notice = ref('')

const envManaged = computed(() => settings.value.source === 'env')
const selectedCount = computed(() => selected.value.size)
// A short page is the end of the results whatever the total says: Plex has
// handed back fewer rows than the window, and asking for the next window gets
// nothing. Both halves matter — the total alone trusts a count that a filter
// can make stale between requests.
const hasNextPage = computed(
  () => tracks.value.length === PAGE_SIZE && offset.value + PAGE_SIZE < total.value,
)
const importLabel = computed(() => {
  if (importing.value) return 'Importing…'
  const n = selectedCount.value
  return n === 1 ? 'Import 1 track' : `Import ${n} tracks`
})
// True when either box holds a term the server is filtering on.
const filterActive = computed(() => !!(filterArtist.value.trim() || filterTitle.value.trim()))
// The filters are the media server's, applied across the whole library, so
// `total` is a count of MATCHES and the window walks the match set. That makes
// "1–100 of 4210" true whether or not a filter is on — which is the point of
// having moved the filtering off the page: a library of tens of thousands of
// tracks made a page-local artist filter match essentially nothing.
const pageLabel = computed(() => {
  if (!total.value) return ''
  const first = offset.value + 1
  const last = Math.min(offset.value + PAGE_SIZE, total.value)
  return `${first}–${last} of ${total.value}`
})
// Only worth saying when it changes what the operator is about to get: they
// picked tracks that HAVE lyrics on the server, and this install will not use
// them.
const lyricsNoteVisible = computed(() =>
  !features.plexLyricsEnabled &&
  [...selected.value.values()].some(t => t.has_lyrics),
)

function messageOf(e, fallback) {
  return e?.response?.data?.detail || e?.message || fallback
}

function isSelected(track) {
  return selected.value.has(track.rating_key)
}

function toggle(track) {
  const next = new Map(selected.value)
  if (next.has(track.rating_key)) next.delete(track.rating_key)
  else next.set(track.rating_key, track)
  selected.value = next
}

function selectAllOnPage() {
  const next = new Map(selected.value)
  for (const track of tracks.value) next.set(track.rating_key, track)
  selected.value = next
}

async function loadSettings() {
  try {
    const res = await plexApi.getSettings()
    settings.value = res.data
    urlInput.value = res.data.url || ''
  } catch (e) {
    error.value = messageOf(e, 'Could not read the Plex settings.')
  }
}

async function loadLibraries({ quiet = false } = {}) {
  if (!settings.value.url) return
  try {
    const res = await plexApi.listLibraries()
    libraries.value = res.data.libraries || []
    if (libraries.value.length === 1 && !libraryKey.value) {
      libraryKey.value = libraries.value[0].key
      await loadTracks()
    }
  } catch (e) {
    // "Quiet" used to mean silent, which left the opening state — stored URL,
    // stored token, empty library list — looking like a server with no music
    // on it. It now means a fixed one-liner instead of the server's own text:
    // this fires on mount, before the operator asked for anything, so it
    // points at the control that WILL explain the problem rather than
    // surfacing a raw error (or anything carrying a credential) unprompted.
    if (quiet) {
      error.value = 'Could not list libraries — check the connection and press Test connection.'
    } else {
      error.value = messageOf(e, 'Could not reach the Plex server.')
    }
  }
}

// Every fetch takes a ticket, and only the newest one may write to the screen.
// Typing "ack" fires three requests over a slow link and they can land in any
// order; without this, the reply to "ac" arriving last would leave rows that
// match neither the boxes nor the label beside them.
let trackRequestSeq = 0

async function loadTracks() {
  if (!libraryKey.value) return
  const seq = ++trackRequestSeq
  loadingTracks.value = true
  error.value = ''
  try {
    const params = { offset: offset.value, limit: PAGE_SIZE }
    // Each field is sent only when it holds something: a blank filter is not
    // "no filter" to the server, it is a filter that matches the entire
    // library. Capped to match what the API accepts.
    const artist = filterArtist.value.trim().slice(0, MAX_FILTER_LENGTH)
    const title = filterTitle.value.trim().slice(0, MAX_FILTER_LENGTH)
    if (artist) params.artist = artist
    if (title) params.title = title
    const res = await plexApi.listTracks(libraryKey.value, params)
    if (seq !== trackRequestSeq) return
    tracks.value = res.data.tracks || []
    total.value = res.data.total || 0
    fetchedOnce.value = true
  } catch (e) {
    if (seq !== trackRequestSeq) return
    tracks.value = []
    error.value = messageOf(e, 'Could not list the tracks in that library.')
  } finally {
    if (seq === trackRequestSeq) loadingTracks.value = false
  }
}

async function onLibraryChange() {
  offset.value = 0
  await loadTracks()
}

// Light debounce, the history search's pattern: each keystroke now costs a
// round trip to the media server, and a filter is only meaningful part-typed
// by accident. Both fields share the timer — typing in one while the other
// holds a term should produce one request, not two.
let filterTimer = null
function onFilterInput() {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => { offset.value = 0; loadTracks() }, 250)
}

async function prevPage() {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  await loadTracks()
}

async function nextPage() {
  offset.value += PAGE_SIZE
  await loadTracks()
}

// True when the fields hold something the server has not been told yet.
// Test reads the STORED settings, so it must save these first or the operator
// gets "no URL configured" with a URL sitting right there in the box.
const hasUnsavedChanges = computed(() =>
  !envManaged.value
  && (urlInput.value.trim() !== (settings.value.url || '') || tokenInput.value.trim() !== ''),
)

// A different server is a different library: rating keys, library keys and any
// selection made against the old one refer to nothing here. Drop all of it
// rather than let a stale pick ride along into an import.
function resetBrowseState() {
  libraries.value = []
  libraryKey.value = ''
  tracks.value = []
  offset.value = 0
  total.value = 0
  selected.value = new Map()
  fetchedOnce.value = false
  filterArtist.value = ''
  filterTitle.value = ''
}

// Persist the fields. THROWS on failure — the caller decides what to say.
async function persistSettings() {
  const previousUrl = settings.value.url || ''
  const body = { url: urlInput.value.trim() }
  // Omitted, not empty: an empty token is the explicit "forget it", and a
  // URL-only save must not be read as one. Trimmed on both sides of that
  // test, so a stray space pasted into the box is not read as a deletion.
  const token = tokenInput.value.trim()
  if (token) body.token = token
  const res = await plexApi.setSettings(body)
  settings.value = res.data
  tokenInput.value = ''
  // Read the stored form back: the server normalizes what it keeps (a
  // trailing slash, for one), and a box that disagrees with it would leave
  // hasUnsavedChanges stuck true, so every Test would save again.
  urlInput.value = res.data.url ?? body.url
  if ((res.data.url || '') !== previousUrl) resetBrowseState()
}

async function onSave() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    await persistSettings()
    notice.value = 'Saved.'
    await loadLibraries({ quiet: true })
  } catch (e) {
    error.value = messageOf(e, 'Could not save the Plex settings.')
  } finally {
    saving.value = false
  }
}

async function onTest() {
  // An empty box is not something to test, and Test must not be the thing that
  // clears a stored server. Save still can — that is an explicit act.
  if (!envManaged.value && !urlInput.value.trim()) {
    error.value = 'Enter a server URL first.'
    notice.value = ''
    return
  }
  testing.value = true
  error.value = ''
  notice.value = ''
  let saved = false
  try {
    if (hasUnsavedChanges.value) {
      // Save owns the same fields; hold its button down for the whole write.
      saving.value = true
      try {
        await persistSettings()
        saved = true
      } catch (e) {
        error.value = messageOf(e, 'Could not save the Plex settings.')
        return
      } finally {
        saving.value = false
      }
    }
    const res = await plexApi.test()
    libraries.value = res.data.libraries || []
    const n = libraries.value.length
    const found = n === 1
      ? 'Connected — 1 music library found.'
      : `Connected — ${n} music libraries found.`
    notice.value = saved ? `Saved. ${found}` : found
  } catch (e) {
    const message = messageOf(e, 'Could not reach the Plex server.')
    // The save landed even though the test after it did not. Say so, or an
    // operator reading only "could not reach" retypes credentials that are
    // already stored.
    error.value = saved ? `Saved, but the connection test failed: ${message}` : message
  } finally {
    testing.value = false
  }
}

async function onImport() {
  if (!selectedCount.value) return
  importing.value = true
  error.value = ''
  notice.value = ''
  try {
    const picked = [...selected.value.values()].map(t => ({
      rating_key: t.rating_key,
      title: t.title,
      artist: t.artist,
      part_key: t.part_key,
      file_path: t.file_path,
      container: t.container,
      has_lyrics: !!t.has_lyrics,
    }))
    const res = await plexApi.importTracks({ tracks: picked })
    const n = (res.data.jobs || []).length
    notice.value = `Queued ${n} ${n === 1 ? 'import' : 'imports'}.`
    selected.value = new Map()
    // The songs appear in the library immediately, as `processing` rows the
    // list already knows how to render.
    await store.fetchSongs()
  } catch (e) {
    error.value = messageOf(e, 'Could not queue the import.')
  } finally {
    importing.value = false
  }
}

// The debounce can outlive the dialog — a timer that fires after the modal is
// gone touches refs nobody is watching, and in a test it leaks into the next one.
onUnmounted(() => { clearTimeout(filterTimer) })

onMounted(async () => {
  features.load()
  await loadSettings()
  if (settings.value.url && settings.value.token_set) {
    await loadLibraries({ quiet: true })
  }
})
</script>

<style scoped>
.plex-modal {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
}

.plex-modal__title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.25rem;
}
.plex-modal__title h2 {
  font-size: 1.05rem;
  font-weight: 700;
  color: white;
  letter-spacing: -0.01em;
  margin: 0;
}
.plex-modal__title .title-icon { font-size: 1.2rem; }

.plex-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.4rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.plex-section__heading {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.5);
}

.plex-form {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.plex-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
  min-width: 12rem;
}
.plex-field--inline { flex: 0 0 auto; min-width: 10rem; }
.plex-field__label {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.55);
}

.plex-input {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: white;
  padding: 0.45rem 0.65rem;
  font-size: 0.85rem;
}
.plex-input:focus {
  outline: none;
  border-color: rgba(226, 62, 87, 0.4);
}
.plex-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.plex-input--filter { width: 100%; }
.plex-field--filter { flex: 1; min-width: 10rem; }

.plex-controls {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.plex-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.plex-actions--end { justify-content: flex-end; }

.plex-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: white;
  padding: 0.4rem 0.8rem;
  font-size: 0.8rem;
  cursor: pointer;
}
.plex-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.plex-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.plex-btn--primary {
  background: rgba(226, 62, 87, 0.85);
  border-color: rgba(226, 62, 87, 0.9);
}

.plex-tracks {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 20rem;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}
.plex-track { border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
.plex-track:last-child { border-bottom: none; }
.plex-track__label {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}
.plex-track__label:hover { background: rgba(255, 255, 255, 0.04); }
.plex-track__text {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plex-track__meta { color: rgba(255, 255, 255, 0.5); }
.plex-track__badge {
  font-size: 0.8rem;
  color: rgba(120, 200, 255, 0.85);
}

.plex-paging {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.plex-paging__label {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.45);
}

.plex-modal__hint,
.plex-modal__note {
  margin: 0;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.45);
}
.plex-modal__empty {
  margin: 0;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.4);
}
.plex-modal__error {
  margin: 0;
  font-size: 0.78rem;
  color: rgba(255, 130, 130, 0.9);
}
.plex-modal__notice {
  margin: 0;
  font-size: 0.78rem;
  color: rgba(140, 220, 160, 0.9);
}
</style>
