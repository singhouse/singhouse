// SPDX-License-Identifier: AGPL-3.0-only
//
// One confirmation in front of every action that would stop or replace the
// song that is playing. While the deck is paused or stopped the action runs
// straight away; while it plays, the shell shows a small confirmation and the
// action runs only if the host confirms it.
import { ref } from 'vue'
import { usePlayerStore } from '@/stores/player'

// Shared by every caller and by the single confirmation the shell mounts.
// { kind: 'load' | 'pause', title, resolve } while one is open.
const pending = ref(null)

function answer(confirmed) {
  const p = pending.value
  if (!p) return
  pending.value = null
  p.resolve(confirmed)
}

export function usePlayGuard() {
  const player = usePlayerStore()

  // Resolves true once `action` has run, false when the host cancels (or a
  // newer guarded action replaces this one before it is answered).
  async function guard(action, { kind = 'load', title = '' } = {}) {
    if (player.playState === 'playing') {
      answer(false)
      const confirmed = await new Promise((resolve) => {
        pending.value = { kind, title, resolve }
      })
      if (!confirmed) return false
    }
    await action()
    return true
  }

  return {
    pending,
    guard,
    confirm: () => answer(true),
    cancel: () => answer(false),
  }
}
