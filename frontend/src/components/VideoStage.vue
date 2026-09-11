<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!--
  The display for a song whose picture the host imported along with it: a
  karaoke video from their own library, lyrics already burned into the frames.

  It draws instead of the canvas lyric stage, never alongside it — there is no
  stage model to draw for such a song.

  The video is NOT the clock. Its audio was extracted at import time and is
  what the audio engine plays through the ordinary stem path, so this element
  is muted and follows: play/pause track the engine's transport, and the
  picture is nudged back whenever it drifts more than a threshold away from the
  engine's time. That one rule covers everything that can separate the two —
  a seek, a decoder that started late, a remount when the projector pops out —
  without this component needing to know which of them happened.

  Deliberately dumb: props in, nothing else. Two of these are alive at once
  (the host's preview and the projector), each following the same clock from
  its own copy of the file, so it must hold no shared or store state.
-->
<template>
  <video
    ref="videoEl"
    class="video-stage"
    :src="src"
    muted
    playsinline
    preload="auto"
    disablepictureinpicture
  />
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  src:         { type: String, default: '' },
  currentTime: { type: Number, default: 0 },
  playing:     { type: Boolean, default: false },
})

const videoEl = ref(null)

// How far the picture may lag or lead the engine before it is pulled back.
// Small enough that no one reads it as out of sync, large enough that ordinary
// decode jitter does not provoke a correction on every animation frame — each
// correction is a seek, and seeking 60 times a second stalls the decoder.
const DRIFT_TOLERANCE_SEC = 0.35

function syncTransport() {
  const el = videoEl.value
  if (!el) return
  if (props.playing) {
    // Muted playback needs no user gesture, but a rejected promise is still
    // possible (a src swap mid-call) and must not surface as an unhandled
    // rejection during a show.
    const p = el.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* transport is retried on the next state change */ })
    }
  } else {
    el.pause()
  }
}

function syncClock() {
  const el = videoEl.value
  if (!el) return
  // readyState 0 means no metadata yet: the element has no timeline to seek
  // into, and a write would be discarded. The next tick catches it.
  if (el.readyState === 0) return
  if (Math.abs(el.currentTime - props.currentTime) > DRIFT_TOLERANCE_SEC) {
    try {
      el.currentTime = props.currentTime
    } catch { /* seek refused mid-load; the next tick retries */ }
  }
}

watch(() => props.playing, syncTransport)

// currentTime ticks once per animation frame off the audio engine, so this is
// the drift check's heartbeat as well as its seek handler.
watch(() => props.currentTime, syncClock)

// A new song's video starts paused at its first frame regardless of what the
// previous one was doing; the transport watcher takes over from there.
// flush: 'post' — the callback has to run AFTER Vue has written the new `src`
// onto the element, or load() would re-fetch the outgoing file.
watch(() => props.src, () => {
  const el = videoEl.value
  if (!el) return
  el.pause()
  el.load()
  syncTransport()
}, { flush: 'post' })

onMounted(() => {
  const el = videoEl.value
  if (!el) return
  // Belt and braces on top of the template attribute: an unmuted autoplay is
  // refused outright, and this element must never contribute audio anyway —
  // the engine is playing the same audio, extracted, through the mixer.
  el.muted = true
  // Mounting can happen mid-song — the projector popout remounts this
  // component with the engine already running — so adopt the current transport
  // and clock rather than assuming a cold start. The element has no timeline
  // to seek into until metadata lands, so the listener covers the case where
  // the immediate correction below is too early to take.
  el.addEventListener('loadedmetadata', syncClock)
  syncTransport()
  syncClock()
})

onBeforeUnmount(() => {
  const el = videoEl.value
  if (!el) return
  el.removeEventListener('loadedmetadata', syncClock)
  el.pause()
  // Drop the source so the browser tears the connection down now. Without
  // this, an element removed from the document can keep buffering the rest of
  // a multi-gigabyte file — and the popout unmounts one of these every time
  // the projector is opened or closed.
  el.removeAttribute('src')
  el.load()
})
</script>

<style scoped>
/* Fills its cell and letterboxes rather than cropping: a karaoke video's
   lyrics sit near the frame edges, and cover-cropping would cut them off. */
.video-stage {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  display: block;
}
</style>
