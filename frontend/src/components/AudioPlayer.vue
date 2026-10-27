<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="player-bar">
    <!-- Song info -->
    <div class="bar__info">
      <h2 class="bar__title">{{ song.title || song.filename || 'Unknown' }}</h2>
      <p class="bar__artist">{{ song.artist || 'Unknown Artist' }}</p>
    </div>

    <!-- Loading state (inline) -->
    <div v-if="loadState === 'loading'" class="bar__status">
      <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c-primary)" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
      </svg>
      <span>{{ loadMessage }}</span>
    </div>

    <!-- Error state (inline) -->
    <div v-else-if="loadState === 'error'" class="bar__status bar__status--error">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-error)" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ errorMessage }}</span>
      <button class="btn btn-ghost" style="font-size:0.75rem;padding:0.2rem 0.5rem" @click="loadSong">Retry</button>
    </div>

    <!-- Transport + progress (shown when ready) -->
    <template v-else-if="loadState === 'ready'">
      <div class="bar__transport">
        <button
          class="ctrl-btn ctrl-btn--play"
          :class="{ 'ctrl-btn--playing': engine.playerState.value === 'playing' }"
          :title="engine.playerState.value === 'playing' ? 'Pause' : 'Play'"
          :aria-label="engine.playerState.value === 'playing' ? 'Pause' : 'Play'"
          :disabled="!hasStems"
          @click="onPlayButton"
        >
          <svg v-if="engine.playerState.value !== 'playing'" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1"/>
            <rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        </button>

        <button class="ctrl-btn" title="Stop" aria-label="Stop" @click="stopPlayback()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
          </svg>
        </button>
      </div>

      <div ref="progressEl" class="bar__progress">
        <ProgressBar
          :currentTime="engine.currentTime.value"
          :duration="engine.duration.value"
          :vocalRegions="vocalRegions"
          @seek="engine.seek"
        />
      </div>
    </template>

    <!-- Space pressed while loading: the song starts as soon as it can. The
         live region stays mounted so the change is announced. -->
    <span class="bar__armed-live" role="status">
      <span v-if="playWhenReady" class="bar__armed">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
        Plays when loaded
      </span>
    </span>

    <AudioOutputSelector v-if="engine.output?.enabled" :output="engine.output" />

    <!-- Mixer toggle button -->
    <button
      v-if="loadState === 'ready'"
      ref="mixerBtnRef"
      class="ctrl-btn bar__mixer-toggle"
      :class="{ 'bar__mixer-toggle--active': mixerOpen }"
      title="Mixer & Controls"
      aria-label="Toggle mixer panel"
      @click="mixerOpen = !mixerOpen"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="6" x2="20" y2="6"/>
        <line x1="4" y1="12" x2="20" y2="12"/>
        <line x1="4" y1="18" x2="20" y2="18"/>
        <circle cx="8" cy="6" r="2" fill="currentColor"/>
        <circle cx="16" cy="12" r="2" fill="currentColor"/>
        <circle cx="10" cy="18" r="2" fill="currentColor"/>
      </svg>
    </button>

    <!-- Mixer popover -->
    <Transition name="dropdown">
      <MixerPopover
        v-if="mixerOpen"
        ref="mixerPanelRef"
        :tracks="tracks"
        :lyricsState="lyricsState"
        :lyricsOffset="lyricsOffset"
        :showLyricsOffset="hasLyricsOrVocals"
        :keyOffset="engine.keyOffset.value"
        :keySupported="engine.keyShiftSupported.value"
        :currentTime="engine.currentTime.value"
        @set-volume="onSetVolume"
        @toggle-mute="toggleMute"
        @seek="engine.seek"
        @update:lyricsOffset="lyricsOffset = $event"
        @update:key="engine.setKey($event)"
        @song-tools="openSongTools"
      />
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import ProgressBar from './ProgressBar.vue'
import AudioOutputSelector from './AudioOutputSelector.vue'
import MixerPopover from './MixerPopover.vue'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { buildStemModel, MAX_VOCAL_LANES } from '@/utils/stemModel'
import { rosterIds } from '@/utils/voiceLayout'
import { useSongsStore } from '@/stores/songs'
import { useSongToolsStore } from '@/stores/songTools'
import { useFeaturesStore } from '@/stores/features'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'
import {
  TEXT_ENTRY, focusedElements, focusInside, modalOpen, spaceBelongsElsewhere,
} from '@/utils/deckKeys'

const props = defineProps({
  song: { type: Object, required: true }
})

// `ended` reports a finished performance to whoever is hosting this player:
//   { songId, reason: 'natural' | 'stopped', positionSec, durationSec }
// Position and duration are captured BEFORE the engine zeroes them, so the
// payload describes the performance rather than the idle deck it leaves
// behind. NOT emitted on a song change or on unmount — the deck being torn
// down is not a performance ending.
const emit = defineEmits(['lyrics-loaded', 'time-update', 'lyrics-offset-change', 'ended'])

const store = useSongsStore()
const songTools = useSongToolsStore()
const features = useFeaturesStore()
const player = usePlayerStore()
const playGuard = usePlayGuard()
const engine = useAudioEngine()

function endedInfo(reason) {
  return {
    songId: props.song?.id ?? null,
    reason,
    positionSec: engine.currentTime.value,
    durationSec: engine.duration.value,
  }
}

// Every manual stop path goes through here so the event can't be forgotten on
// one of them. The payload is captured before stop() zeroes the engine, and
// the emit happens after: the button's job is to stop the audio, and a
// throwing listener must not be able to prevent that.
//
// Only a deck that was actually live ends a performance. Stop on an idle deck
// — a second Stop click, or Home on a song that was loaded but never played —
// stops nothing, so it must stay silent: `ended` is the hook a queue records
// play history from, and an unconditional emit writes phantom rows at
// position 0. engine.stop() still runs either way; the idempotent reset is a
// separate guarantee from the event.
function stopPlayback() {
  disarmPlayWhenReady()
  const wasLive = engine.playerState.value === 'playing' || engine.playerState.value === 'paused'
  const info = endedInfo('stopped')
  engine.stop()
  if (wasLive) emit('ended', info)
}

// Mirror the engine's transport state into the player store so other surfaces
// (like the title-card overlay in ScreenStage) can react without holding a
// direct reference to this component's engine instance.
watch(() => engine.playerState.value, val => player.setPlayState(val))

const loadState = ref('idle')
const loadMessage = ref('Loading...')
const errorMessage = ref('')
const lyricsState = ref('none')
const lyricsOffset = ref(0)
const mixerOpen = ref(false)

// Space pressed while the deck is still loading arms this: { songId } of the
// song it is waiting for, played the moment that song is ready. Loading is
// this player's own stem load, and also the song-detail fetch that runs
// before a new song reaches this player at all (a library click, a queue
// advance), which the store reports as `incomingSongId`. A second Space,
// Stop/Home, a failed load or any other song taking its place disarms it.
//
// A queue advance in flight (player.advancePending) arms it too, as
// { songId: null, advance: true }: the incoming singer's song is not known
// yet, and the deck still holds the outgoing one, which Space must not
// replay. The first song to head for the deck after that is the advance's
// and takes the arm; if the advance settles with none (it failed, the new
// singer has no linked song, the queue ran out) the arm is dropped.
const playWhenReady = ref(null)
const fetchingIncoming = computed(() =>
  store.incomingSongId != null && store.incomingSongId !== props.song?.id,
)
const deckLoading = computed(() => loadState.value === 'loading' || fetchingIncoming.value)
function disarmPlayWhenReady() { playWhenReady.value = null }

// Space pressed before this player existed (nothing was loaded yet, the first
// song's details still on their way): the shell recorded it in the player
// store. It is this song's arm now, unless it named another song.
{
  const handed = player.pendingPlay
  if (handed) {
    player.setPendingPlay(null)
    if (handed.advance || handed.songId === (props.song?.id ?? null)) {
      playWhenReady.value = { songId: props.song?.id ?? null }
    }
  }
}

watch([() => store.incomingSongId, () => player.advancePending], ([incoming, pending]) => {
  const armed = playWhenReady.value
  if (!armed) return
  if (incoming != null) {
    if (armed.advance) playWhenReady.value = { songId: incoming }
    else if (armed.songId !== incoming) disarmPlayWhenReady()
    return
  }
  if (armed.advance && !pending) disarmPlayWhenReady()
})

function playIfArmed() {
  const armed = playWhenReady.value
  if (!armed || loadState.value !== 'ready') return
  if (armed.songId !== (props.song?.id ?? null) || deckLoading.value) return
  disarmPlayWhenReady()
  engine.play()
}

// The mixer's one way through to everything you can do TO this song. The
// panel lives outside the player, so opening it neither unmounts the deck nor
// ties the tools to the song that happens to be loaded.
function openSongTools() {
  mixerOpen.value = false
  if (props.song?.id != null) songTools.open(props.song.id)
}

const mixerBtnRef = ref(null)
const mixerPanelRef = ref(null)

const tracks = ref([])   // built per song in loadSong from the stem DTO

// A finished re-split writes new files at the SAME URLs, so the browser would
// happily serve the old ones out of its cache; this stamp is appended to the
// stem URLs on the reload afterwards. Reset per song by the id watcher — a
// fresh song has nothing to bust.
const stemCacheBust = ref(0)

function withCacheBust(url) {
  if (!stemCacheBust.value || !url) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${stemCacheBust.value}`
}

const hasStems = computed(() => {
  const s = props.song.stems || props.song || {}
  return !!(s.instrumental || (Array.isArray(s.vocals) && s.vocals.length))
})

// The lyrics offset only moves lyrics, so it is offered only when the song has
// something it can move: a vocal lane or lyrics. Read from the loaded tracks
// and lyrics rather than the media type, so a karaoke video that later gains
// stems gets the control.
const hasLyricsOrVocals = computed(() =>
  tracks.value.some((t) => t.kind === 'vocal') ||
  lyricsState.value !== 'none' ||
  !!props.song.word_sync?.segments
)

// Vocal regions for the progress bar. One block per lyric line,
// then merged across short gaps so adjacent phrases read as one chunk instead
// of a stutter of slivers. Falls back gracefully when word-level sync isn't
// available (LRC-only or no lyrics → empty array → bar renders normally).
const VOCAL_MERGE_GAP_SEC = 0.5
const vocalRegions = computed(() => {
  const ws = props.song.word_sync
  if (!ws) return []

  const isWord = (w) => {
    const t = (w.word || w.text || '').trim()
    return t && t !== '[*]' && t !== '.'
  }

  const phrases = []
  if (Array.isArray(ws.lines) && ws.lines.length) {
    for (const line of ws.lines) {
      const ws_ = line.filter(isWord)
      if (!ws_.length) continue
      phrases.push({ start: ws_[0].start, end: ws_[ws_.length - 1].end })
    }
  } else if (Array.isArray(ws.segments)) {
    for (const seg of ws.segments) {
      const ws_ = (seg.words || []).filter(isWord)
      if (!ws_.length) continue
      phrases.push({ start: ws_[0].start, end: ws_[ws_.length - 1].end })
    }
  }

  const merged = []
  for (const p of phrases) {
    const last = merged[merged.length - 1]
    if (last && p.start - last.end < VOCAL_MERGE_GAP_SEC) {
      last.end = Math.max(last.end, p.end)
    } else {
      merged.push({ start: p.start, end: p.end })
    }
  }
  return merged
})

// Click-outside for mixer popover
function onDocClick(e) {
  if (mixerOpen.value &&
      !mixerPanelRef.value?.$el?.contains(e.target) &&
      !mixerBtnRef.value?.contains(e.target)) {
    mixerOpen.value = false
  }
}

// Lifecycle
onMounted(() => {
  engine.output?.start()
  features.load()   // cached after the first call; decides the lyrics fallback
  loadSong()
  window.addEventListener('keydown', handleKeyboard)
  window.addEventListener('keyup', handleKeyup, true)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('mousedown', onDocClick)
})

onUnmounted(() => {
  engine.output?.stop()
  window.removeEventListener('keydown', handleKeyboard)
  window.removeEventListener('keyup', handleKeyup, true)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('mousedown', onDocClick)
  // An in-flight load that lands after this must not ready the torn-down
  // deck, start its loop or play it.
  loadSeq++
  disarmPlayWhenReady()
  engine.cleanup()
  loadState.value = 'idle'
})

watch(() => props.song?.id, (id) => {
  const armed = playWhenReady.value
  if (armed?.advance) playWhenReady.value = { songId: id ?? null }   // the advance's song
  else if (armed && armed.songId !== (id ?? null)) disarmPlayWhenReady()
  mixerOpen.value = false   // avoid acting on a previous song's (stale) mixer state
  lyricsOffset.value = 0    // the player store's offset is cleared on song change too
  stemCacheBust.value = 0
  engine.cleanup()
  loadState.value = 'idle'
  loadSong()
})

watch(lyricsOffset, val => emit('lyrics-offset-change', val))

// Mirror the engine's key offset into the player store so other surfaces can
// read it. Resets to 0 on song change (engine.cleanup zeroes keyOffset).
watch(() => engine.keyOffset.value, val => player.setKey(val))

// Audio loading. Each call takes a ticket; a call overtaken by a newer one
// (the song changed, a re-split reload) stops touching the deck's state when
// it resumes, so a late-finishing earlier load can neither mark the newer
// load ready nor start an armed play-when-ready for the wrong song.
let loadSeq = 0
async function loadSong() {
  const seq = ++loadSeq
  loadState.value = 'loading'
  loadMessage.value = 'Initialising audio...'
  engine.currentTime.value = 0
  engine.duration.value = 0

  try {
    loadMessage.value = 'Loading stems...'
    const roster = rosterIds(props.song.word_sync)
    const stems = props.song.stems || props.song || {}
    if (Array.isArray(stems.vocals) && stems.vocals.length > MAX_VOCAL_LANES) {
      console.warn(`AudioPlayer: ${stems.vocals.length} vocal stems; capping at ${MAX_VOCAL_LANES}`)
    }
    tracks.value = buildStemModel(stems, roster)

    const stemList = tracks.value.map((t) => ({
      key: t.key, url: withCacheBust(t.url), kind: t.kind, volume: t.volume,
    }))
    const { durations, available } = await engine.loadStems(stemList)
    if (seq !== loadSeq) return
    tracks.value.forEach((t) => { t.available = !!(available && available[t.key]) })

    if (!durations.length) throw new Error('No audio stems could be loaded')
    engine.duration.value = Math.max(...durations)

    loadMessage.value = 'Fetching lyrics...'
    await loadLyrics()
    if (seq !== loadSeq) return

    loadState.value = 'ready'
    engine.startAnimationLoop(
      t => emit('time-update', t, lyricsOffset.value),
      // Natural end of track. The engine calls this BEFORE stop(), so the
      // position/duration below are still the ones the singer just finished
      // on. What (if anything) happens next — advancing a queue, recording a
      // play — belongs to whoever mounted this player, not here.
      () => emit('ended', endedInfo('natural')),
    )
    playIfArmed()
  } catch (err) {
    if (seq !== loadSeq) return
    console.error('AudioPlayer load error:', err)
    disarmPlayWhenReady()
    loadState.value = 'error'
    errorMessage.value = err.message || 'Failed to load audio'
  }
}

// A re-split rewrites this song's stem files in place, so when one lands the
// deck has to reload against cache-busted URLs — otherwise the browser keeps
// playing the audio it already has and the re-split looks like it did nothing.
//
// The job itself is started from Song tools and tracked on the store, keyed by
// song id. Watching that record rather than owning the poll is what makes a
// late finish safe: the source below reads the CURRENT song's job, so a job
// that finishes after the deck moved on simply is not this song's job and the
// watcher never fires for it.
//
// Which is also why the song id is WATCHED ALONGSIDE the status rather than
// merely read inside the callback. Reading the current song's job means the
// value changes when the SONG changes too: pointing the deck from a song whose
// re-split is running at one whose re-split finished earlier reads as
// running → done, and the deck would cache-bust and reload a song nothing had
// just happened to — concurrently with the reload the id watcher above already
// started. A status transition only means something when both ends of it were
// observed on the same song.
const resplitStatus = computed(() => {
  const job = store.jobFor?.(props.song?.id)
  return job && job.kind === 'resplit' ? job.status : null
})

watch(
  [() => props.song?.id ?? null, resplitStatus],
  async ([songId, status], [previousId, previous]) => {
    if (songId == null || songId !== previousId) return
    // Only a transition we WATCHED go from in-flight to done. A panel opened
    // on a song whose re-split finished an hour ago must not reload the deck.
    if (status !== 'done' || !previous || previous === 'done') return
    stemCacheBust.value = Date.now()
    await store.loadSong({ id: songId })
    await nextTick()          // let the refreshed song detail reach this prop
    if (props.song?.id !== songId) return
    engine.cleanup()
    loadState.value = 'idle'
    await loadSong()
  },
)

// The active lyrics set can change from outside this component — Song tools
// activating another version, a job landing a new one. The store refreshes the
// song detail, which arrives here as a new `word_sync`; without this the deck
// would keep drawing the set that was active when it loaded.
watch(() => props.song?.word_sync, (wordSync) => {
  if (loadState.value !== 'ready') return
  if (wordSync && wordSync.segments) {
    lyricsState.value = 'synced'
    emit('lyrics-loaded', wordSync)
  } else {
    loadLyrics()
  }
})

async function loadLyrics() {
  // Word-level sync is produced by the ingest pipeline, so by the time the
  // song is "ready" it should already be on the song detail. Just use it.
  if (props.song.word_sync && props.song.word_sync.segments) {
    lyricsState.value = 'synced'
    emit('lyrics-loaded', props.song.word_sync)
    return
  }

  // A song imported with its own karaoke video already shows lyrics — they are
  // burned into the picture, and the stage draws the video instead of the
  // canvas. Looking up a third party's lyrics for it would be wrong twice
  // over: nothing would render them, and the request itself asks an outside
  // service about a file the host authored.
  if (props.song.has_video) {
    lyricsState.value = 'none'
    emit('lyrics-loaded', null)
    return
  }

  // Fallback: legacy songs (or ingests where transcription failed) — show
  // whatever the lyrics provider has so the user isn't staring at a blank
  // panel. Only when the operator has opted in to third-party lookup; off is
  // the default, and a blank panel is the correct outcome then. The server
  // would 503 anyway — this just avoids a request we know will be refused.
  // Awaited, not merely read: the onMounted warm-up may still be in flight,
  // and reading the OFF default early would suppress a lookup the operator
  // actually enabled. Cached after the first call, so this is free later.
  await features.load()
  if (!features.lyricsLookupEnabled) {
    lyricsState.value = 'none'
    emit('lyrics-loaded', null)
    return
  }

  const lyrics = await store.fetchLyrics(props.song.artist, props.song.title)
  if (lyrics && (lyrics.plain_lyrics || lyrics.synced_lyrics)) {
    lyricsState.value = 'synced'
    emit('lyrics-loaded', lyrics)
  } else {
    lyricsState.value = 'none'
    emit('lyrics-loaded', null)
  }
}

// Playback
// The transport button is an explicit choice: it replaces a pending
// play-when-ready rather than racing it.
function onPlayButton() {
  disarmPlayWhenReady()
  togglePlayPause()
}

async function togglePlayPause() {
  if (engine.playerState.value === 'playing') {
    engine.pause()
  } else {
    await engine.play()
  }
}

// Mixer
function onSetVolume({ key, value }) {
  const track = tracks.value.find((t) => t.key === key)
  if (!track) return
  track.volume = Math.max(0, Math.min(1, value))
  track.prevVolume = value > 0 ? value : track.prevVolume
  engine.setVolume(key, track.volume)
}

function toggleMute(track) {
  if (track.volume > 0) {
    track.prevVolume = track.volume
    track.volume = 0
  } else {
    track.volume = track.prevVolume || 1
  }
  engine.setVolume(track.key, track.volume)
}

// Which keys the deck leaves to whatever has focus (shared rules in
// utils/deckKeys).
//
// Space is play/pause everywhere except where it types and while a modal
// dialog is up. A button keeps focus after a click, so leaving Space to it
// would press that button again (a stray Advance mid-show).
//
// ←/→ seek and Home stops everywhere except text entry, widgets that move
// with those keys themselves (sliders, tabs, radios, listboxes, menus), a
// library row the keyboard is walking, and modal dialogs. A focused button,
// link or menu trigger is no reason to give them up. The deck's own seek
// slider is the exception among sliders: its arrows ARE the seek shortcut.
//
// Non-modal popovers (PopoverMenu's default role="dialog", e.g. Display) do
// not own the deck keys; their text fields and arrow widgets still do, and
// Escape is never a deck key. A modal dialog — Modal.vue's native showModal()
// dialog, any [aria-modal="true"] surface, an alertdialog — owns them all,
// which is what leaves the play guard's own prompt in charge of its Space
// and Enter.
const SLIDERS = 'input[type="range"], [role="slider"], [role="spinbutton"]'
// Home means something here too (first tab, first option, first item).
const HOME_WIDGETS = [
  '[role="tablist"]', '[role="tab"]', '[role="listbox"]', '[role="option"]',
  '[role="menu"]', '[role="menubar"]', '[role="menuitem"]',
  '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
].join(', ')
// ...and the arrows additionally move a radio group's selection.
const ARROW_WIDGETS = [
  HOME_WIDGETS, '[role="radiogroup"]', '[role="radio"]', 'input[type="radio"]',
].join(', ')
// A grid row focused from the keyboard walks the grid. One focused by a
// pointer press carries data-pointer-focus (SongList) and leaves the keys to
// the deck. Matched on the focused row itself, not its contents.
const KEYBOARD_ROW = '[role="grid"] [role="row"]:not([data-pointer-focus]), '
  + '[role="treegrid"] [role="row"]:not([data-pointer-focus])'

const progressEl = ref(null)

function navBelongsElsewhere(e) {
  if (modalOpen(e) || focusInside(e, TEXT_ENTRY)) return true
  const widgets = e.code === 'Home' ? HOME_WIDGETS : ARROW_WIDGETS
  return focusedElements(e).some(el =>
    el.closest(widgets)
    || (el.closest(SLIDERS) && !progressEl.value?.contains(el))
    || el.matches(KEYBOARD_ROW))
}

// Browsers press a focused button on Space's keyup, so the keyup of a Space
// taken as play/pause is swallowed too.
let swallowSpaceUp = false
function onWindowBlur() { swallowSpaceUp = false }
function handleKeyup(e) {
  if (e.code !== 'Space' || !swallowSpaceUp) return
  swallowSpaceUp = false
  e.preventDefault()
}

// Keyboard shortcuts
function handleKeyboard(e) {
  // A fresh Space press starts clean: a swallow left over from a press whose
  // keyup never arrived here must not eat this one's keyup.
  if (e.code === 'Space' && !e.repeat) swallowSpaceUp = false
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
  if (e.code === 'Space' ? spaceBelongsElsewhere(e) : navBelongsElsewhere(e)) return
  switch (e.code) {
    case 'Space':
      if (e.shiftKey) return
      e.preventDefault()
      swallowSpaceUp = true
      if (e.repeat) return
      // A press while the song is still loading asks for it to start once it
      // can; a second press takes that back. Nothing is playing yet, so there
      // is nothing to guard.
      if (playWhenReady.value) {
        disarmPlayWhenReady()
        break
      }
      if (deckLoading.value) {
        playWhenReady.value = {
          songId: fetchingIncoming.value ? store.incomingSongId : (props.song?.id ?? null),
        }
        break
      }
      // Mid-advance with the outgoing song stopped or paused: wait for the
      // incoming one. If the outgoing song is still PLAYING, Space stays the
      // guarded pause below — that is a live performance, and the shell
      // never loads over a playing deck anyway.
      if (player.advancePending && engine.playerState.value !== 'playing') {
        playWhenReady.value = { songId: null, advance: true }
        break
      }
      // A stray Space must not stop the song mid-show: pausing asks first,
      // resuming does not. The transport button stays unguarded.
      if (engine.playerState.value === 'playing') {
        playGuard.guard(() => engine.pause(), { kind: 'pause' })
      } else {
        togglePlayPause()
      }
      break
    case 'ArrowLeft':
      e.preventDefault()
      engine.seek(engine.currentTime.value - (e.shiftKey ? 30 : 5))
      break
    case 'ArrowRight':
      e.preventDefault()
      engine.seek(engine.currentTime.value + (e.shiftKey ? 30 : 5))
      break
    case 'Home':
      e.preventDefault()
      stopPlayback()
      break
  }
}
</script>

<style scoped>
.player-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 100%;
}

.bar__info { min-width: 0; flex-shrink: 1; max-width: 150px; }
.bar__title {
  font-size: 0.85rem; font-weight: 700; color: white;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;
}
.bar__artist {
  font-size: 0.7rem; color: rgba(255,255,255,0.45);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;
}

.bar__status {
  display: flex; align-items: center; gap: 0.5rem; flex: 1;
  color: rgba(255,255,255,0.5); font-size: 0.8rem;
}
.bar__status--error { color: var(--c-error); }

.bar__transport { display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0; }

.ctrl-btn {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.7); cursor: pointer; transition: all 0.15s ease;
}
.ctrl-btn:hover { background: rgba(255,255,255,0.12); color: white; }
.ctrl-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.ctrl-btn:focus-visible { outline: 2px solid #f7e7c8; outline-offset: 2px; }

.ctrl-btn--play {
  width: 34px; height: 34px; background: var(--c-primary);
  border-color: transparent; color: #0c0e14;
}
.ctrl-btn--play:hover {
  background: var(--c-primary-hover);
  box-shadow: 0 0 16px rgba(226, 62, 87, 0.5); color: #0c0e14;
}
.ctrl-btn--playing {
  background: var(--c-primary-bg); border-color: var(--c-primary-border); color: var(--c-primary);
}
.ctrl-btn--playing:hover { background: rgba(226,62,87,0.25); color: var(--c-primary); }

.bar__progress { flex: 1; min-width: 180px; }

.bar__armed {
  display: inline-flex; align-items: center; gap: 0.3rem; flex-shrink: 0;
  padding: 0.15rem 0.5rem; border-radius: 999px;
  background: var(--c-primary-bg); border: 1px solid var(--c-primary-border);
  color: var(--c-primary); font-size: 0.7rem; font-weight: 600; white-space: nowrap;
}
.bar__mixer-toggle { flex-shrink: 0; }
.bar__mixer-toggle--active {
  border-color: var(--c-primary-border); color: var(--c-primary); background: var(--c-primary-bg);
}

.spinner { animation: spin 1s linear infinite; }

.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-8px); }

@media (max-width: 640px) {
  .bar__artist { display: none; }
  .bar__info { max-width: 100px; }
}
</style>
