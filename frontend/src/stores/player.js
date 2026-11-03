// SPDX-License-Identifier: AGPL-3.0-only
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { normalizeWordSync } from '@/stage/adapter.mjs'
import { applyVoiceLayout } from '@/utils/voiceLayout.js'

export const usePlayerStore = defineStore('player', () => {
  const lyrics = ref(null)
  const lyricsState = ref('none') // none | synced | plain

  // Parsed model for the canvas KaraokeStage — the only lyric renderer there
  // is; nothing else draws lyrics, and there is no DOM fallback.
  // Derived from the raw `lyrics` payload, which is kept as the source of truth
  // the derivation runs on (and for anything that needs the unparsed data).
  const stageModel = ref(null)

  const currentTime = ref(0)
  const offset = ref(0) // lyrics offset in ms
  const key = ref(0) // musical key offset in semitones
  const playState = ref('stopped') // stopped | playing | paused

  const currentSong = ref(null)

  // A queue advance is in flight: the provider's useAdvancing() as the shell
  // reads it, held until the shell has seen where the advance landed. While
  // it is set, the deck holds the OUTGOING song and Space must not replay
  // it. Owned by HostShell; not reset by clear(), which runs on every load.
  const advancePending = ref(false)

  // Space pressed while no player is mounted yet but a song is on its way
  // (the session's first song, or the first singer's advance): { songId } of
  // that song, or { songId: null, advance: true } while the advance has not
  // named one. The player adopts it as its play-when-ready when it mounts.
  // Owned by HostShell until then; not reset by clear().
  const pendingPlay = ref(null)

  const adjustedTime = computed(() => currentTime.value + (offset.value / 1000))

  function setLyrics(data) {
    lyrics.value = data
    // Derive the canvas model from word-sync data. Parsed once per
    // lyrics-loaded, not per render.
    if (data && (data.lines || data.segments)) {
      try {
        stageModel.value = applyVoiceLayout(normalizeWordSync(data), data)
        return
      } catch (err) {
        console.warn('Stage model: word-sync parse failed:', err)
      }
    }
    stageModel.value = null
  }

  function setTime(t) { currentTime.value = t }
  function setOffset(ms) { offset.value = ms }
  function setKey(s) { key.value = s }
  function setPlayState(s) { playState.value = s }
  function setLyricsState(s) { lyricsState.value = s }
  function setAdvancePending(on) { advancePending.value = !!on }
  function setPendingPlay(req) { pendingPlay.value = req || null }

  function clear() {
    lyrics.value = null
    lyricsState.value = 'none'
    stageModel.value = null
    currentTime.value = 0
    offset.value = 0
    key.value = 0
    playState.value = 'stopped'
  }

  return {
    lyrics, lyricsState, stageModel, currentTime, offset, key, playState, currentSong,
    advancePending, pendingPlay,
    adjustedTime,
    setLyrics, setTime, setOffset, setKey, setPlayState, setLyricsState, setAdvancePending, setPendingPlay, clear,
  }
})
