// SPDX-License-Identifier: AGPL-3.0-only
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * Which song the Song tools panel is open on.
 *
 * Only the pointer lives here. The panel's own contents are fetched by the
 * panel, and the jobs it starts are tracked in the songs store — so closing
 * the panel is genuinely free: nothing it started is hanging off this state.
 *
 * The panel opens from three places (a library row, the mixer, the word-timing
 * editor) and none of them is an ancestor of the others, which is why the
 * pointer is a store rather than a prop.
 */
export const useSongToolsStore = defineStore('songTools', () => {
  const songId = ref(null)
  const tab = ref('lyrics')

  const isOpen = computed(() => songId.value != null)

  function open(id, initialTab = 'lyrics') {
    if (id == null) return
    songId.value = Number(id)
    tab.value = initialTab || 'lyrics'
  }

  function close() {
    songId.value = null
  }

  /** Row affordance behaviour: the same song closes it, a different one
   *  re-points it without a close/open flicker. */
  function toggle(id, initialTab = 'lyrics') {
    if (songId.value === Number(id)) close()
    else open(id, initialTab)
  }

  return { songId, tab, isOpen, open, close, toggle }
})
