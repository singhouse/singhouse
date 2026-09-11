<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="screen-stage">
    <!-- The lyrics grid. Row 1 is the canvas; anything an overlay package
         contributes shares that cell or takes row 2 (see the slot below). -->
    <div class="screen-stage__lyrics">
      <!-- The canvas KaraokeStage is the ONE lyric renderer. There is no DOM
           fallback: a song with no parsed stage model draws an empty stage,
           by design. `stageEpoch` is a remount key — see the prop.

           Keyed on the INNER component only. The popout moves this
           component's ancestor element between documents, and
           useLyricsWindow holds raw references to that element and its
           original parent; re-keying anything at or above .screen-stage would
           swap the moved node out from under it. -->
      <div class="canvas-stage">
        <!-- A song imported with its own karaoke video shows the video INSTEAD
             of the canvas: its lyrics are burned into the picture, so there is
             no stage model to draw and drawing one on top would double them.
             Keyed on `stageEpoch` for the same reason the canvas is — the
             popout reparents this cell between documents without remounting,
             and a video element that survives that move keeps a decoder tied
             to the document it left.

             `player.currentTime`, NOT `adjustedTime`: the lyrics-offset knob
             nudges the canvas lyrics against the audio, but this video's audio
             was extracted from this very file, so picture and sound are
             aligned by construction. Feeding the offset in here would drag the
             picture out of sync to fix a problem it does not have. -->
        <VideoStage
          v-if="videoUrl"
          :key="stageEpoch"
          :src="videoUrl"
          :currentTime="player.currentTime"
          :playing="player.playState === 'playing'"
        />
        <KaraokeStage
          v-else
          :key="stageEpoch"
          :model="player.stageModel"
          :currentTime="player.adjustedTime"
          :visualizer="hostSettings.backdrop"
          :audioSource="hostSettings.audioSource"
          :playing="player.playState === 'playing'"
        />
      </div>

      <!-- Stage overlays. The projector IS core; what a queue system
           draws on top of it — announcements, join QR, an upcoming-singers
           marquee — is not. A registered package contributes grid items into
           this grid (see .screen-stage__lyrics below): the canvas cell for
           anything that must sit above the lyrics, row 2 for anything that
           must shorten them. Core registers nothing and the stage is the
           canvas alone. -->
      <component :is="stageOverlays" v-if="stageOverlays" :show-qr="showQr" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import KaraokeStage from '@/stage/KaraokeStage.vue'
import VideoStage from '@/components/VideoStage.vue'
import { usePlayerStore } from '@/stores/player'
import { useSongsStore } from '@/stores/songs'
import { useHostSettings } from '@/stores/hostSettings'
import { getSlot } from '@/plugins/slots'

defineProps({
  showQr:      { type: Boolean, default: false },
  // Remount key for the inner KaraokeStage. Bump it whenever this stage's DOM
  // has just been reparented into another document (the popout window, or back
  // to the host) — the Vue components are NOT remounted by that move, so
  // without a re-key the canvas keeps whatever 2D context it acquired in the
  // old document. A fresh mount re-runs getContext() with the element already
  // in its destination document. The docked stage never moves and leaves this
  // at 0.
  stageEpoch:  { type: Number, default: 0 },
})

const player = usePlayerStore()
const songs = useSongsStore()
const hostSettings = useHostSettings()

// The imported karaoke video for the loaded song, when there is one. Null-safe
// at every hop: this stage renders with no song loaded (the welcome state and
// the popped-out projector before the first pick both mount it), and
// `video_url` is absent until the server has the file on disk.
//
// Resolved to an ABSOLUTE url. The server hands back a root-relative path, and
// the popped-out projector's document is `about:blank` — a relative src there
// resolves only through about-blank base-url inheritance, a dependency nothing
// else in this app has. This computed runs in the host window's JS context
// whatever document its DOM node has been moved into, so `location.origin` is
// the app's origin either way.
const videoUrl = computed(() => {
  if (!songs.currentSong?.has_video) return null
  const raw = songs.currentSong?.video_url
  if (!raw) return null
  try {
    return new URL(raw, window.location.origin).href
  } catch {
    return null
  }
})

// Read once at setup, like every other slot consumer: registration happens
// before the app is created (main.js awaits the package import), so this can
// never change under a mounted stage.
const stageOverlays = getSlot('stage-overlays')

// ── Canvas stage clock ───────────────────────────────────────────────────────
// The clock is read HERE from the player store (`player.adjustedTime`, which
// folds the host's lyrics-offset knob in), not passed down as a prop from
// HostShell. currentTime changes at rAF rate while a song plays; a template
// that reads it re-renders at that rate. Scoped here, that 60fps re-render
// covers only this small stage subtree. Threaded through HostShell it covered
// the whole shell — including the sidebar's native <select>s, which Vue
// force-visits on every render (`next !== prev || key === "value"` in
// runtime-core: patchProp always runs for `value` and re-reads el.value; the
// DOM write itself is guarded, but any DOM/vnode value divergence writes at
// render rate), and Firefox's native dropdown popup misbehaves under that
// churn (flashing highlight, picks not committing). Do not lift these reads
// back up.
</script>

<style scoped>
.screen-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  /* Own stacking context: overlay z-indexes layer against each other in here
     only — never against host chrome (the mixer popover sits in the player
     panel's z:10 context and must stay on top of the stage). This is also the
     context registered overlays resolve their z values in, so nothing between
     here and them may become a stacking context of its own. */
  isolation: isolate;
}

/* Two-row grid rather than a flex column, so an overlay package can place
   items ON the canvas (row 1, same cell) AND under it (row 2, which shortens
   the canvas the way a marquee has to) from a single mount point. Positioned
   with z:auto — the containing block for full-stage overlays, not a stacking
   context. With nothing registered, row 2 collapses and this is the canvas
   alone. */
.screen-stage__lyrics {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  position: relative;
}

/* Canvas renderer host: KaraokeStage fills its container; give it a black
   background so letterboxing reads as stage, not a hole. */
.canvas-stage {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: #000;
}

</style>
