<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="progress-bar-wrap">
    <!-- Time: current -->
    <span class="time-display">{{ formatTime(currentTime) }}</span>

    <!-- Seek track -->
    <div
      class="seek-wrap"
      role="slider"
      aria-label="Playback position"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(currentTime)"
      :aria-valuetext="formatTime(currentTime) + ' of ' + formatTime(duration)"
      tabindex="0"
      @mousedown="startDrag"
      @touchstart.passive="startDrag"
    >
      <div class="seek-track" ref="trackRef" @click="onTrackClick">
        <!-- Filled portion (overall progress, dim when vocal markers present) -->
        <div
          class="seek-fill"
          :class="{ 'seek-fill--muted': vocalRegions.length > 0 }"
          :style="{ width: fillPct + '%' }"
        />
        <!-- Vocal region markers (dim for upcoming, bright for sung) -->
        <div
          v-for="(r, i) in scaledVocalRegions"
          :key="'v' + i"
          class="seek-vocal"
          :style="{ left: r.left + '%', width: r.width + '%' }"
        >
          <div class="seek-vocal__fill" :style="{ width: r.played + '%' }" />
        </div>
        <!-- Hover ghost (shown while dragging) -->
        <div v-if="isDragging" class="seek-ghost" :style="{ width: ghostPct + '%' }" />
        <!-- Thumb -->
        <div
          class="seek-thumb"
          :class="{ 'seek-thumb--dragging': isDragging }"
          :style="{ left: fillPct + '%' }"
        />
      </div>

      <!-- Buffered bar (future feature placeholder) -->
      <!-- <div class="seek-buffered" :style="{ width: bufferedPct + '%' }" /> -->
    </div>

    <!-- Time: total -->
    <span class="time-display time-display--total">{{ formatTime(duration) }}</span>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  currentTime:  { type: Number, default: 0 },
  duration:     { type: Number, default: 0 },
  vocalRegions: { type: Array,  default: () => [] }   // [{start, end}] in seconds
})

const emit = defineEmits(['seek'])

const trackRef = ref(null)
const isDragging = ref(false)
const ghostPct = ref(0)

const fillPct = computed(() => {
  if (!props.duration) return 0
  return Math.min(100, (props.currentTime / props.duration) * 100)
})

const scaledVocalRegions = computed(() => {
  const dur = props.duration
  if (!dur || !props.vocalRegions.length) return []
  const t = props.currentTime
  return props.vocalRegions.map(r => {
    const left  = (r.start / dur) * 100
    const width = Math.max(0.15, ((r.end - r.start) / dur) * 100)
    let played = 0
    if (t >= r.end) played = 100
    else if (t > r.start) played = ((t - r.start) / (r.end - r.start)) * 100
    return { left, width, played }
  })
})

function formatTime(sec) {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

function pctFromEvent(e) {
  const rect = trackRef.value.getBoundingClientRect()
  const clientX = e.touches ? e.touches[0].clientX : e.clientX
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}

function onTrackClick(e) {
  if (!props.duration) return
  const pct = pctFromEvent(e)
  emit('seek', pct * props.duration)
}

function startDrag(e) {
  if (!props.duration) return
  isDragging.value = true

  const onMove = (ev) => {
    const pct = pctFromEvent(ev) * 100
    ghostPct.value = pct
    // Live seek preview
    emit('seek', (pct / 100) * props.duration)
  }

  const onUp = (ev) => {
    isDragging.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('touchmove', onMove)
  document.addEventListener('touchend', onUp)
}
</script>

<style scoped>
.progress-bar-wrap {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0;
}

.time-display {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: #e23e57;
  min-width: 2.25rem;
  text-align: center;
  flex-shrink: 0;
}
.time-display--total {
  color: rgba(255,255,255,0.35);
}

/* Seek */
.seek-wrap {
  flex: 1;
  padding: 6px 0;
  cursor: pointer;
  position: relative;
}

.seek-track {
  position: relative;
  height: 4px;
  background: rgba(255,255,255,0.12);
  border-radius: 2px;
  overflow: visible;
}

.seek-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #e23e57, #f7e7c8);
  border-radius: 2px;
  transition: width 0.1s linear;
}
/* When vocal markers are present, mute the gradient so the markers dominate */
.seek-fill--muted {
  background: rgba(255, 255, 255, 0.18);
}

/* Vocal regions — sit slightly taller than the track so
   they're readable against the dim background. */
.seek-vocal {
  position: absolute;
  top: -2px;
  bottom: -2px;
  background: rgba(247, 231, 200, 0.55);   /* dim purple = upcoming */
  border-radius: 2px;
  overflow: hidden;
  pointer-events: none;
}
.seek-vocal__fill {
  height: 100%;
  background: #e23e57;                    /* bright cyan = sung */
  box-shadow: 0 0 6px rgba(226, 62, 87, 0.55);
  border-radius: 2px;
  transition: width 0.08s linear;
}
.seek-wrap:hover .seek-vocal { top: -3px; bottom: -3px; }

.seek-ghost {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: rgba(226, 62, 87, 0.25);
  border-radius: 2px;
}

.seek-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #e23e57;
  box-shadow: 0 0 8px rgba(226,62,87,0.7);
  transition: transform 0.15s, box-shadow 0.15s;
  pointer-events: none;
}

.seek-wrap:hover .seek-thumb,
.seek-thumb--dragging {
  transform: translate(-50%, -50%) scale(1.3);
  box-shadow: 0 0 16px rgba(226,62,87,0.9);
}

.seek-wrap:hover .seek-track {
  height: 5px;
}
.seek-wrap:focus-visible {
  outline: 2px solid #f7e7c8;
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
