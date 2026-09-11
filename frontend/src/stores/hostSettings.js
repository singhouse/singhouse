// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Host-side operational settings (persisted to localStorage).
 *
 * How the host *operates* a show — not renderer tuning.
 *
 * backdrop: id of the audio-reactive backdrop visualizer drawn behind the
 * canvas lyrics — 'none' (flat fill) or any id in stage/visualizers/index.js.
 * Deliberately not enumerated here: the registry is extensible (it globs
 * private entries) and an unknown id degrades to the flat fill, since
 * KaraokeStage resolves it through getVisualizer().
 *
 * audioSource: which audio tap the backdrop reacts to ('mix' | 'inst' |
 * 'vocals'). See composables/audioReactive.js.
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'karaoke-host-settings'

const DEFAULTS = {
  backdrop: 'none',
  audioSource: 'mix',
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULTS, ...parsed }
    }
  } catch {
    // ignore corrupt storage
  }
  return { ...DEFAULTS }
}

export const useHostSettings = defineStore('hostSettings', () => {
  const initial = loadFromStorage()

  const backdrop = ref(initial.backdrop)
  const audioSource = ref(initial.audioSource)

  watch([backdrop, audioSource], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      backdrop: backdrop.value,
      audioSource: audioSource.value,
    }))
  })

  return { backdrop, audioSource, DEFAULTS }
})
