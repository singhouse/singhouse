<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div ref="panelRef" class="mixer-popover">
    <!-- Lyrics status badge -->
    <div class="popover__header">
      <span class="popover__title">Mixer</span>
      <Badge :variant="lyricsState" v-if="lyricsState !== 'none'">
        {{ lyricsState === 'synced' ? 'Synced' : 'Plain' }}
      </Badge>
      <Badge v-else variant="none">No lyrics</Badge>
    </div>

    <!-- Skip controls -->
    <div class="popover__skip">
      <button class="ctrl-btn" title="Rewind 10s" aria-label="Rewind 10 seconds" @click="$emit('seek', currentTime - 10)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 1 0 .49-4.59"/>
          <text x="8" y="16" font-size="7" fill="currentColor" stroke="none" font-weight="bold">10</text>
        </svg>
      </button>
      <button class="ctrl-btn" title="Forward 10s" aria-label="Forward 10 seconds" @click="$emit('seek', currentTime + 10)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-.49-4.59"/>
          <text x="8" y="16" font-size="7" fill="currentColor" stroke="none" font-weight="bold">10</text>
        </svg>
      </button>
    </div>

    <!-- Volume tracks -->
    <div class="mixer__tracks">
      <div
        v-for="track in tracks"
        :key="track.key"
        class="mixer-track"
        :class="{ 'mixer-track--muted': track.volume === 0 }"
      >
        <button
          class="mixer-track__mute"
          :class="{ 'mixer-track__mute--active': track.volume > 0 }"
          :style="{ '--lane-color': track.color || '#8890a8' }"
          :title="track.volume > 0 ? `Mute ${track.label}` : `Unmute ${track.label}`"
          :aria-label="track.volume > 0 ? `Mute ${track.label}` : `Unmute ${track.label}`"
          @click="$emit('toggle-mute', track)"
        >
          <span class="mixer-track__dot" aria-hidden="true"></span>
        </button>
        <div class="mixer-track__slider-wrap">
          <label class="mixer-track__label">{{ track.label }}</label>
          <input
            type="range"
            min="0"
            max="100"
            :value="track.volume * 100"
            class="mixer-track__slider"
            :aria-label="`${track.label} volume`"
            @input="$emit('set-volume', { key: track.key, value: Number($event.target.value) / 100 })"
          />
        </div>
        <span class="mixer-track__value">{{ Math.round(track.volume * 100) }}</span>
      </div>
    </div>

    <!-- Lyrics offset control -->
    <div class="mixer__offset">
      <span class="mixer__offset-label">Lyrics offset</span>
      <button class="offset-btn" @click="$emit('update:lyricsOffset', lyricsOffset - 100)">−</button>
      <span class="offset-value">{{ lyricsOffset > 0 ? '+' : '' }}{{ lyricsOffset }}ms</span>
      <button class="offset-btn" @click="$emit('update:lyricsOffset', lyricsOffset + 100)">+</button>
      <button class="offset-btn" @click="$emit('update:lyricsOffset', 0)">↺</button>
    </div>

    <!-- Key (pitch) control. Transposes all stems, preserving tempo. -->
    <div class="mixer__offset">
      <span class="mixer__offset-label">Key</span>
      <button
        class="offset-btn"
        :disabled="!keySupported"
        title="Down a semitone"
        @click="$emit('update:key', Math.max(-12, keyOffset - 1))"
      >−</button>
      <span class="offset-value">{{ keyOffset > 0 ? '+' : '' }}{{ keyOffset }} st</span>
      <button
        class="offset-btn"
        :disabled="!keySupported"
        title="Up a semitone"
        @click="$emit('update:key', Math.min(12, keyOffset + 1))"
      >+</button>
      <button
        class="offset-btn"
        :disabled="!keySupported"
        title="Reset key"
        @click="$emit('update:key', 0)"
      >↺</button>
    </div>
    <p v-if="!keySupported" class="mixer__key-note">
      Key change needs a secure connection — open the app via https or localhost.
    </p>

    <!-- One way in to everything you can do TO this song: lyrics versions,
         the re-split that used to live below this button, and the metadata.
         The panel opens beside the library and stays open, so it is not the
         mixer's job to host any of it. -->
    <button class="mixer__edit-lyrics" @click="$emit('song-tools')">
      Song tools
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Badge from '@/components/ui/Badge.vue'

defineProps({
  tracks: { type: Array, required: true },
  lyricsState: { type: String, default: 'none' },
  lyricsOffset: { type: Number, default: 0 },
  keyOffset: { type: Number, default: 0 },
  keySupported: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0 },
})

defineEmits([
  'set-volume', 'toggle-mute', 'seek', 'update:lyricsOffset', 'update:key',
  'song-tools',
])

const panelRef = ref(null)
</script>

<style scoped>
.mixer-popover {
  position: absolute;
  top: 100%;
  right: 0.5rem;
  width: 300px;
  max-width: calc(100vw - 2rem);
  max-height: 70vh;
  overflow-y: auto;
  background: rgba(10, 10, 30, 0.92);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 0.875rem;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  padding: 0.75rem;
  margin-top: 0.25rem;
  z-index: 20;
}

.popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.popover__title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.35);
}

.popover__skip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.ctrl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  transition: all 0.15s ease;
}
.ctrl-btn:hover {
  background: rgba(255,255,255,0.12);
  color: white;
}

.mixer__tracks {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.mixer-track {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: opacity 0.2s;
}
.mixer-track--muted { opacity: 0.5; }

.mixer-track__mute {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.4rem;
  border: 1px solid transparent;
  cursor: pointer;
  background: rgba(255,255,255,0.05);
  transition: all 0.15s;
  flex-shrink: 0;
}
.mixer-track__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--lane-color);
  opacity: 0.35;                 /* muted look by default */
  transition: opacity 0.15s, box-shadow 0.15s;
}
.mixer-track__mute--active {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.1);
}
.mixer-track__mute--active .mixer-track__dot {
  opacity: 1;
  box-shadow: 0 0 6px var(--lane-color);
}
.mixer-track__mute:hover .mixer-track__dot { opacity: 0.85; }

.mixer-track__slider-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.mixer-track__label {
  font-size: 0.72rem;
  color: rgba(255,255,255,0.45);
  font-weight: 500;
}
.mixer-track__slider {
  width: 100%;
  height: 4px;
}

.mixer-track__value {
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: var(--c-primary);
  min-width: 2rem;
  text-align: right;
  flex-shrink: 0;
}

.mixer__offset {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.mixer__offset-label {
  font-size: 0.72rem;
  color: rgba(255,255,255,0.35);
  flex: 1;
}
.offset-btn {
  width: 26px;
  height: 26px;
  border-radius: 0.35rem;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.09);
  color: rgba(255,255,255,0.6);
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}
.offset-btn:hover {
  background: rgba(255,255,255,0.12);
  color: white;
}
.offset-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.offset-btn:disabled:hover {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.6);
}
.offset-value {
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  color: rgba(255,255,255,0.5);
  min-width: 3.5rem;
  text-align: center;
}
.mixer__key-note {
  font-size: 0.68rem;
  color: rgba(255,200,120,0.7);
  margin-top: 0.4rem;
  line-height: 1.3;
}

.mixer__edit-lyrics {
  width: 100%;
  margin-top: 0.4rem;
  padding: 0.4rem 0.75rem;
  border-radius: 0.4rem;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.09);
  color: rgba(255,255,255,0.6);
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.12s;
}
.mixer__edit-lyrics:hover {
  background: rgba(255,255,255,0.12);
  color: white;
}

</style>
