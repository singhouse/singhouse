<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="stems">
    <section class="stems__block">
      <h4 class="stems__h">Vocal lanes</h4>
      <p v-if="!lanes.length" class="stems__empty">
        No vocal stems on this song.
      </p>
      <ul v-else class="stems__lanes">
        <li v-for="lane in lanes" :key="lane.id" class="stems__lane">
          <span class="stems__lane-id">{{ lane.id }}</span>
          <span v-if="lane.name" class="stems__lane-name">{{ lane.name }}</span>
        </li>
      </ul>
    </section>

    <section class="stems__block">
      <h4 class="stems__h">Re-split lead / backing</h4>
      <p class="stems__blurb">
        Re-runs the second separation pass on this song's vocals with a
        different model. Lyric timing will need a re-fit afterwards.
      </p>

      <div class="stems__row">
        <select v-model="karaokeModel" class="stems__select" :disabled="!!blocked">
          <option v-for="m in KARAOKE_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <button
          class="stems__go"
          :disabled="!!blocked"
          :title="blocked || modelHint"
          @click="runResplit"
        >Re-split</button>
      </div>
      <p class="stems__hint">{{ modelHint }}</p>
      <p v-if="blocked" class="stems__why">{{ blocked }}</p>
    </section>
  </div>
</template>

<script setup>
// The Stems tab. The re-split control used to live in the mixer, which meant
// it only existed for the song currently on the deck and only while the
// popover was open — the two things least true of a job that runs for minutes.
import { computed, ref } from 'vue'
import { useSongsStore } from '@/stores/songs'
import { KARAOKE_MODELS, DEFAULT_KARAOKE_MODEL } from '@/utils/karaokeModels'
import { resplitEligibility } from '@/utils/resplitEligibility'

const props = defineProps({
  songId: { type: Number, required: true },
  song:   { type: Object, default: null },
})

const store = useSongsStore()

// Defaults to the server's default rather than to whatever produced the
// current stems — the song does not carry its Pass-2 pick, and guessing one
// would be worse than starting from the documented default.
const karaokeModel = ref(DEFAULT_KARAOKE_MODEL)

const modelHint = computed(
  () => KARAOKE_MODELS.find(m => m.id === karaokeModel.value)?.hint || ''
)

const lanes = computed(() => {
  const vocals = (props.song?.stems || props.song || {}).vocals
  return Array.isArray(vocals) ? vocals : []
})

const eligibility = computed(() => resplitEligibility(props.song))

const blocked = computed(() => {
  if (store.isJobRunning(props.songId)) return 'A job is already running for this song.'
  return eligibility.value.canResplit ? '' : eligibility.value.reason
})

function runResplit() {
  if (blocked.value) return
  store.startResplit(props.songId, { karaoke_model: karaokeModel.value })
}

defineExpose({ karaokeModel, blocked, eligibility, runResplit })
</script>

<style scoped>
.stems { display: flex; flex-direction: column; gap: 1rem; }
.stems__block { display: flex; flex-direction: column; gap: 0.4rem; }
.stems__h {
  margin: 0;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-muted);
}
.stems__blurb { margin: 0; font-size: 0.72rem; color: var(--text-secondary); line-height: 1.4; }
.stems__empty { margin: 0; font-size: 0.78rem; font-style: italic; color: var(--text-muted); }
.stems__lanes { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
.stems__lane {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  padding: 0.15rem 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--bg-glass);
  border: 1px solid var(--border-subtle);
  font-size: 0.72rem;
}
.stems__lane-id { color: var(--text-primary); font-family: 'JetBrains Mono', monospace; }
.stems__lane-name { color: var(--text-muted); }

.stems__row { display: flex; gap: 0.4rem; align-items: center; }
.stems__select {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-light);
  color: var(--text-primary);
  font-size: 0.76rem;
}
.stems__select:disabled { opacity: 0.45; }
.stems__go {
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-light);
  background: var(--bg-glass);
  color: var(--text-primary);
  font-size: 0.78rem;
  cursor: pointer;
}
.stems__go:hover:not(:disabled) { background: var(--bg-glass-active); color: #fff; }
.stems__go:disabled { opacity: 0.45; cursor: not-allowed; }
.stems__hint { margin: 0; font-size: 0.68rem; color: var(--text-muted); line-height: 1.35; }
.stems__why { margin: 0; font-size: 0.7rem; color: var(--c-warning); line-height: 1.35; }
</style>
