<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="lyr">
    <!-- ── Versions ─────────────────────────────────────────────────────── -->
    <section class="lyr__block">
      <h4 class="lyr__h">Versions <span class="lyr__count">{{ sets.length }}</span></h4>

      <p v-if="notice" class="lyr__notice" :class="{ 'lyr__notice--error': noticeIsError }">
        {{ notice }}
      </p>

      <p v-if="!sets.length" class="lyr__empty">
        No lyrics sets yet — run one of the actions below, or paste a set by hand.
      </p>
      <ul v-else class="lyr__sets">
        <LyricsSetRow
          v-for="ls in sets"
          :key="ls.id"
          :set="ls"
          :song-id="songId"
          :busy="setBusy || jobRunning"
          @action="onSetAction"
        />
      </ul>
    </section>

    <!-- ── Fix this song's lyrics ───────────────────────────────────────── -->
    <section class="lyr__block">
      <h4 class="lyr__h">Fix this song's lyrics</h4>

      <fieldset class="anchor">
        <legend class="anchor__legend">Anchor to</legend>
        <label
          v-for="opt in anchorOptions"
          :key="opt.value"
          class="anchor__opt"
          :class="{ 'anchor__opt--off': opt.disabled }"
        >
          <input
            type="radio"
            name="anchor"
            :value="opt.value"
            :disabled="opt.disabled"
            :checked="anchor === opt.value"
            @change="chooseAnchor(opt.value)"
          />
          <span class="anchor__name">{{ opt.label }}</span>
          <small class="anchor__help">{{ opt.disabled ? opt.reason : opt.help }}</small>
        </label>
      </fieldset>

      <template v-if="anchor === 'paste'">
        <textarea
          v-model="pasteText"
          class="lyr__textarea lyr__textarea--small"
          placeholder="Paste the correct lyrics (plain text or LRC)…"
          spellcheck="false"
        ></textarea>
        <p v-if="pasteIsLrc" class="lyr__hint">
          LRC detected — the timestamps will be used as anchors.
        </p>
      </template>

      <div class="cards">
        <!-- Re-fit: no GPU, no new words. The default whenever the cached
             transcription it reuses actually exists. -->
        <div class="card" :class="{ 'card--primary': cacheReady }">
          <h5 class="card__h">Re-fit timing</h5>
          <p class="card__blurb">
            Keeps the current transcription, re-fits timing to the anchor above.
            Instant.
          </p>
          <label v-if="features.llmPagingEnabled" class="card__check">
            <input type="checkbox" v-model="refitPaging" />
            <span>LLM paging</span>
          </label>
          <button
            class="card__go"
            :class="{ 'card__go--primary': cacheReady }"
            :disabled="!!refitBlocked"
            :title="refitBlocked || 'Re-fit the existing transcription'"
            @click="runRefit"
          >Re-fit timing</button>
          <p v-if="refitBlocked" class="card__why">{{ refitBlocked }}</p>
        </div>

        <!-- Listen again: the expensive one. Named for what it does to the
             audio, never "Transcribe". -->
        <div class="card" :class="{ 'card--primary': !cacheReady }">
          <h5 class="card__h">Listen again</h5>
          <p class="card__blurb">
            Re-runs the speech model on the vocals — a GPU run that queues
            behind other jobs.
          </p>

          <div class="card__row">
            <label class="field">
              <span>Model</span>
              <select v-model="model">
                <option v-for="m in WHISPER_MODELS" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="field">
              <span>Language</span>
              <input v-model="language" type="text" placeholder="auto" />
            </label>
            <label class="field field--check">
              <input type="checkbox" v-model="useVad" />
              <span>VAD</span>
            </label>
          </div>

          <label v-if="features.llmPagingEnabled" class="card__check">
            <input type="checkbox" v-model="listenPaging" />
            <span>LLM paging</span>
          </label>

          <button
            class="card__go"
            :class="{ 'card__go--primary': !cacheReady }"
            :disabled="!!listenBlocked"
            :title="listenBlocked || 'Re-run the speech model on this song'"
            @click="runListen"
          >Listen again</button>
          <p v-if="listenBlocked" class="card__why">{{ listenBlocked }}</p>
        </div>
      </div>
    </section>

    <!-- ── Save a set by hand ───────────────────────────────────────────── -->
    <section class="lyr__block">
      <h4 class="lyr__h">Save lyrics by hand</h4>
      <textarea
        v-model="manualText"
        class="lyr__textarea"
        placeholder="Paste lyrics here (plain text or LRC format)…"
        spellcheck="false"
      ></textarea>
      <div class="lyr__manual-meta">
        <span class="lyr__format" :class="manualFormatClass">{{ manualFormatLabel }}</span>
        <span v-if="manualLines" class="lyr__lines">{{ manualLines }} lines</span>
        <span class="lyr__spacer"></span>
        <button
          class="card__go"
          :disabled="!manualText.trim() || setBusy"
          @click="saveManual"
        >{{ setBusy ? 'Saving…' : 'Save as new set' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup>
// The Lyrics tab of the Song tools panel.
//
// One anchor choice governs BOTH actions, because "what should the words be"
// and "how do I get the timing" are separate questions and the old modal
// asked them as one. Every refusal the two routes can answer with is mirrored
// here as a disabled control carrying its reason: a host mid-show should read
// why an action is unavailable, not a 409.
import { computed, ref, watch } from 'vue'
import { useSongsStore } from '@/stores/songs'
import { useFeaturesStore } from '@/stores/features'
import { lyricsSetsApi } from '@/api/client'
import { isLrcText, countLyricLines } from '@/utils/lyricsText'
import LyricsSetRow from './LyricsSetRow.vue'

const props = defineProps({
  songId: { type: Number, required: true },
  song:   { type: Object, default: null },
  sets:   { type: Array, default: () => [] },
})

const emit = defineEmits(['refresh'])

const store = useSongsStore()
const features = useFeaturesStore()
features.load()   // cached; the lrclib anchor appears when it resolves

// The server's allowlist for the speech model, same order the upload form
// offers. `heart` is the tuned default.
const WHISPER_MODELS = ['heart', 'large-v3', 'large-v2', 'medium', 'small', 'base', 'tiny']

const anchor = ref(features.lyricsLookupEnabled ? 'lrclib' : 'none')
const anchorChosen = ref(false)
function chooseAnchor(value) {
  anchorChosen.value = true
  anchor.value = value
}
// Capabilities can arrive after the host starts editing. Only update an
// untouched default; explicit audio-only and pasted choices must survive.
watch(() => features.lyricsLookupEnabled, enabled => {
  if (!anchorChosen.value) anchor.value = enabled ? 'lrclib' : 'none'
})
const pasteText = ref('')
const model = ref('heart')
const language = ref('')
const useVad = ref(true)
const refitPaging = ref(false)
const listenPaging = ref(false)

const manualText = ref('')
const setBusy = ref(false)
const notice = ref('')
const noticeIsError = ref(false)

// Is there a cached transcription for THIS model/VAD pair? Re-fit reuses it,
// and the route 409s without one, so the probe decides which card is primary.
const cache = ref({ exists: false, label: '' })
// The active set's line count, for the anchor label. The list payload says
// only WHETHER the set has lyrics, so the count needs the full set.
const activeLineCount = ref(null)

function say(message, isError = false) {
  notice.value = message
  noticeIsError.value = isError
}

const jobRunning = computed(() => store.isJobRunning(props.songId))
const cacheReady = computed(() => cache.value.exists === true)
const pasteIsLrc = computed(() => isLrcText(pasteText.value))

const activeSet = computed(() => props.sets.find(s => s.is_active) || null)

// Why the "lyrics saved on this song" anchor cannot be used, or ''. Mirrors
// `_resolve_reference`: no active set is a 404 there, an active TRANSCRIPTION
// is a 409 — feeding the speech model its own output back in.
const activeBlocked = computed(() => {
  const ls = activeSet.value
  if (!ls) return 'This song has no active lyrics set to anchor to.'
  if (ls.source === 'transcription') {
    return 'The active set is a transcription — anchoring to it would feed the '
      + 'speech model its own output back in. Paste lyrics or activate a '
      + 'reference set instead.'
  }
  if (!ls.has_plain_lyrics && !ls.has_synced_lyrics) {
    return 'The active set carries word timings but no lyrics text to anchor to.'
  }
  return ''
})

const activeAnchorLabel = computed(() => {
  if (activeLineCount.value) {
    return `Lyrics saved on this song (${activeLineCount.value} lines)`
  }
  return 'Lyrics saved on this song'
})

// What to CALL the lookup in front of the host. The features store already
// owns this fallback and makes it neutral ("a third-party service") — naming a
// vendor we may not be talking to is a claim, and copy here is load-bearing.
// The `value: 'lrclib'` below is a different thing: a wire enum, never read.
const lookupName = computed(() => features.lyricsLookupLabel)

// `auto` is deliberately absent: it resolved its reference server-side, so
// what it actually anchored to could not be shown here — and an anchor nobody
// can name is the thing this panel exists to stop.
const anchorOptions = computed(() => {
  const out = [
    {
      value: 'none',
      label: 'Audio only',
      help: 'The speech model decides the words as well as the timing.',
      disabled: false,
      reason: '',
    },
    {
      value: 'active',
      label: activeAnchorLabel.value,
      help: 'Re-uses the words already saved on this song.',
      disabled: !!activeBlocked.value,
      reason: activeBlocked.value,
    },
    {
      value: 'paste',
      label: 'Paste lyrics…',
      help: 'Anchor to lyrics you paste below.',
      disabled: false,
      reason: '',
    },
  ]
  // Third-party lookup is opt-in and OFF by default. The option whose whole
  // job is to perform one is not rendered at all when it is off — the route
  // would answer 503.
  if (features.lyricsLookupEnabled) {
    out.push({
      value: 'lrclib',
      label: `Look up on ${lookupName.value}`,
      help: 'Fetches plain lyrics for this artist/title; generates timing from your audio.',
      disabled: false,
      reason: '',
    })
  }
  return out
})

// If the selection stops being available — flags resolve after setup, the
// active set is replaced by a transcription — fall back rather than submit a
// reference_mode the server will refuse.
watch(anchorOptions, opts => {
  const chosen = opts.find(o => o.value === anchor.value)
  if (!chosen || chosen.disabled) anchor.value = 'none'
})

// Why the anchor cannot be submitted as it stands, or ''.
const anchorBlocked = computed(() => {
  const chosen = anchorOptions.value.find(o => o.value === anchor.value)
  if (!chosen) return 'Pick something to anchor to.'
  if (chosen.disabled) return chosen.reason
  if (anchor.value === 'paste' && !pasteText.value.trim()) {
    return 'Paste the lyrics to anchor to, or choose “Audio only”.'
  }
  return ''
})

const songBlocked = computed(() => {
  const status = props.song?.status
  if (!status || status === 'ready') return ''
  if (status === 'failed') {
    return 'This song’s ingest failed — retry it on the Details tab first.'
  }
  return 'This song is still being processed.'
})

const busyBlocked = computed(
  () => jobRunning.value ? 'A job is already running for this song.' : ''
)

const refitBlocked = computed(() =>
  songBlocked.value
  || busyBlocked.value
  || anchorBlocked.value
  || (cacheReady.value
    ? ''
    : `No transcription cached for ${model.value} — run Listen again first.`)
)

const listenBlocked = computed(
  () => songBlocked.value || busyBlocked.value || anchorBlocked.value
)

// ── Cache probe ────────────────────────────────────────────────────────────
// Every probe is answered, and the answers do not have to come back in the
// order they were asked: flipping the model twice can leave a slow reply for
// the FIRST choice landing after the fast reply for the second, and the card
// would then say "cached" about a model the host is no longer looking at —
// which is the difference between Re-fit being offered and being refused.
// A monotonic token drops any answer a later probe has already superseded.
let _cacheSeq = 0

async function refreshCache() {
  if (!props.songId) return
  const seq = ++_cacheSeq
  const status = await store.cacheStatus(props.songId, {
    model: model.value,
    useVad: useVad.value,
  })
  if (seq !== _cacheSeq) return          // superseded in flight; discard
  cache.value = { exists: !!status?.exists, label: status?.label || '' }
}

watch([model, useVad, () => props.songId], refreshCache, { immediate: true })

// A finished job can create the cache (Listen again), invalidate it (a
// re-split rewrites the vocals the transcription was made from) or change the
// set list. Re-read both rather than guess which.
watch(() => store.jobFor(props.songId)?.status, (status, prev) => {
  if (status === 'done' && prev && prev !== 'done') refreshCache()
})

// ── The active set's line count ────────────────────────────────────────────
watch(activeSet, async (ls) => {
  activeLineCount.value = null
  if (!ls || (!ls.has_plain_lyrics && !ls.has_synced_lyrics)) return
  const wanted = ls.id
  try {
    const res = await lyricsSetsApi.get(props.songId, ls.id)
    // The set can have been replaced while the request was in flight.
    if (activeSet.value?.id !== wanted) return
    const body = res.data?.plain_lyrics || res.data?.synced_lyrics || ''
    activeLineCount.value = countLyricLines(body) || null
  } catch (e) {
    console.warn('Could not read the active set:', e.message)
  }
}, { immediate: true })

// ── Requests ───────────────────────────────────────────────────────────────
function buildBody({ paging = false } = {}) {
  const body = {
    whisper_model: model.value,
    use_vad: useVad.value,
    reference_mode: anchor.value,
    activate: true,
  }
  const lang = language.value.trim()
  if (lang) body.language = lang
  if (features.llmPagingEnabled && paging) body.llm_paging = true
  // Lyrics travel ONLY with `paste`. The server 400s a body that carries
  // lyrics under reference_mode=none, precisely so they are never silently
  // discarded — so they are never sent.
  if (anchor.value === 'paste') {
    const text = pasteText.value.trim()
    if (text) {
      if (isLrcText(text)) body.synced_lyrics = text
      else body.plain_lyrics = text
    }
  }
  return body
}

function runRefit() {
  if (refitBlocked.value) return
  say('')
  store.startRealign(props.songId, buildBody({ paging: refitPaging.value }))
}

function runListen() {
  if (listenBlocked.value) return
  say('')
  store.startTranscribe(props.songId, buildBody({
    paging: listenPaging.value,
  }))
}

// ── Version actions ────────────────────────────────────────────────────────
async function onSetAction({ action, setId }) {
  if (action === 'repage') {
    say('')
    store.startPageLyricsSet(props.songId, setId, { activate: true })
    return
  }
  if (action === 'delete'
      && typeof confirm === 'function'
      && !confirm('Delete this lyrics set?')) {
    return
  }
  setBusy.value = true
  say('')
  try {
    if (action === 'activate') await store.activateLyricsSet(props.songId, setId)
    else if (action === 'verify') await store.verifyLyricsSet(props.songId, setId)
    else if (action === 'duplicate') await lyricsSetsApi.copy(props.songId, setId)
    else if (action === 'delete') await store.deleteLyricsSet(props.songId, setId)
    emit('refresh')
  } catch (e) {
    say(e.message, true)
  } finally {
    setBusy.value = false
  }
}

// ── Manual set ─────────────────────────────────────────────────────────────
const manualIsLrc = computed(() => isLrcText(manualText.value))
const manualLines = computed(() => countLyricLines(manualText.value))
const manualFormatLabel = computed(() => {
  if (!manualText.value.trim()) return 'Paste lyrics above'
  return manualIsLrc.value ? 'LRC (synced) format detected' : 'Plain text'
})
const manualFormatClass = computed(() => ({
  'lyr__format--lrc': manualIsLrc.value && !!manualText.value.trim(),
  'lyr__format--plain': !manualIsLrc.value && !!manualText.value.trim(),
}))

async function saveManual() {
  const text = manualText.value.trim()
  if (!props.songId || !text) return
  setBusy.value = true
  say('')
  try {
    await store.createManualLyricsSet(props.songId, {
      plainLyrics: manualIsLrc.value ? null : text,
      syncedLyrics: manualIsLrc.value ? text : null,
      label: 'manual edit',
      activate: true,
    })
    manualText.value = ''
    say('Saved as a new active set.')
    emit('refresh')
  } catch (e) {
    say(e.message, true)
  } finally {
    setBusy.value = false
  }
}

defineExpose({
  anchor, anchorOptions, anchorBlocked, refitBlocked, listenBlocked,
  buildBody, cache, pasteText, model, useVad, language,
  refitPaging, listenPaging, manualText, runRefit, runListen,
})
</script>

<style scoped>
.lyr { display: flex; flex-direction: column; gap: 1rem; }
.lyr__block { display: flex; flex-direction: column; gap: 0.45rem; }
.lyr__h {
  margin: 0;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.lyr__count { color: var(--text-secondary); font-weight: 500; }
.lyr__notice { margin: 0; font-size: 0.75rem; color: var(--text-secondary); line-height: 1.35; }
.lyr__notice--error { color: var(--c-error); }
.lyr__empty { margin: 0; font-size: 0.78rem; font-style: italic; color: var(--text-muted); }
.lyr__sets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }

.anchor {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.55rem;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.anchor__legend {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-muted);
  padding: 0 0.25rem;
}
.anchor__opt {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  column-gap: 0.4rem;
  padding: 0.15rem 0;
  font-size: 0.78rem;
  cursor: pointer;
  color: var(--text-primary);
}
.anchor__opt--off { opacity: 0.45; cursor: not-allowed; }
.anchor__name { grid-column: 2; }
.anchor__help {
  grid-column: 2;
  color: var(--text-muted);
  font-size: 0.68rem;
  line-height: 1.3;
}

.lyr__textarea {
  width: 100%;
  min-height: 150px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.78rem;
  line-height: 1.55;
  padding: 0.6rem;
  resize: vertical;
  outline: none;
}
.lyr__textarea:focus { border-color: var(--c-primary-border); }
.lyr__textarea--small { min-height: 90px; }
.lyr__hint {
  margin: 0;
  font-size: 0.7rem;
  color: rgba(255, 200, 120, 0.8);
  line-height: 1.35;
}

.cards { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.card {
  flex: 1 1 190px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.55rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-glass);
}
.card--primary { border-color: var(--c-primary-border); background: var(--c-primary-bg); }
.card__h { margin: 0; font-size: 0.85rem; font-weight: 600; color: #fff; }
.card__blurb { margin: 0; font-size: 0.7rem; color: var(--text-secondary); line-height: 1.35; }
.card__row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: flex-end; }
.card__check {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
  cursor: pointer;
}
.card__go {
  margin-top: auto;
  padding: 0.4rem 0.65rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-light);
  background: var(--bg-glass);
  color: var(--text-primary);
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
}
.card__go:hover:not(:disabled) { background: var(--bg-glass-active); color: #fff; }
.card__go--primary { background: var(--c-primary); border-color: transparent; color: #0a0a1a; }
.card__go--primary:hover:not(:disabled) { background: var(--c-primary-hover); }
.card__go:disabled { opacity: 0.45; cursor: not-allowed; }
.card__why { margin: 0; font-size: 0.68rem; color: var(--text-muted); line-height: 1.35; }

.field { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.66rem; color: var(--text-muted); }
.field--check { flex-direction: row; align-items: center; gap: 0.3rem; padding-bottom: 0.3rem; }
.field select,
.field input[type="text"] {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  padding: 0.25rem 0.35rem;
  font-size: 0.75rem;
  outline: none;
  max-width: 7rem;
}

.lyr__manual-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem; }
.lyr__spacer { flex: 1; }
.lyr__format { color: var(--text-muted); }
.lyr__format--lrc { color: var(--c-success); }
.lyr__format--plain { color: var(--c-warning); }
.lyr__lines { color: var(--text-muted); }
</style>
