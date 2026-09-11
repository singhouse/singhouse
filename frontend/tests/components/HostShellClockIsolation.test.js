// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// HostShell must NOT re-render when the play clock ticks. The clock updates at
// rAF rate while a song plays; when HostShell's template read
// player.currentTime (to thread it into ScreenStage as a prop), the whole
// shell — sidebar included — re-rendered ~60 times a second. Vue force-visits
// `value` props on every render (`next !== prev || key === "value"` in
// runtime-core; the DOM write is guarded but the visit and el.value read are
// not), and Firefox's native <select> dropdown popup misbehaves under that
// churn: a flashing selection highlight, and picks that close the popup
// without committing. The fix moved the clock reads into
// ScreenStage itself; this test pins the isolation so a future template edit
// can't quietly reintroduce the storm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/api/client', () => {
  // Defined inside the factory: vi.mock is hoisted above imports and consts.
  const asyncNoop = () => vi.fn(async () => ({ data: {} }))
  return {
    default: { get: asyncNoop(), post: asyncNoop() },
    songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
    sessionApi: { config: asyncNoop(), me: asyncNoop(), unlock: asyncNoop(), lock: asyncNoop() },
    historyApi: {
      record: asyncNoop(), complete: asyncNoop(), list: asyncNoop(), remove: asyncNoop(),
      clear: asyncNoop(), getSettings: asyncNoop(), setSettings: asyncNoop(),
    },
    queueApi: {
      list: asyncNoop(), add: asyncNoop(), remove: asyncNoop(),
      reorder: asyncNoop(), clear: asyncNoop(),
    },
    lyricsSetsApi: {},
  }
})
vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,          // core build: no queue provider, no overlays
  slotHasContent: () => false,
}))
vi.mock('@/auth/gate', () => ({
  getSignOutHandler: () => null,
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ hasRoute: () => false, replace: vi.fn() }),
}))

import HostShell from '@/views/HostShell.vue'
import { usePlayerStore } from '@/stores/player'
import { useSongsStore } from '@/stores/songs'

let wrapper = null
let hostShellUpdates = 0

function mountShell() {
  hostShellUpdates = 0
  wrapper = mount(HostShell, {
    global: {
      mixins: [{
        updated() {
          if (this.$options.__name === 'HostShell') hostShellUpdates++
        },
      }],
      stubs: {
        SongList: true, QueuePanel: true, AudioPlayer: true, ScreenStage: true,
        UploadZone: true, HistoryModal: true, Modal: true,
        BrandLogo: true, BrandMark: true,
        Transition: false,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HostShell and the play clock', () => {
  it('does not re-render when the clock ticks', async () => {
    mountShell()
    // Let onMounted's async work (fetchSongs, the fire-and-forget health
    // probe flipping the connection pill) fully settle — those are legitimate
    // one-off renders. flushPromises drains the microtask chain however deep
    // the mocked stores make it; twice covers a promise scheduled by the
    // first flush.
    await flushPromises()
    await flushPromises()
    await nextTick()
    hostShellUpdates = 0

    const player = usePlayerStore()
    for (let i = 1; i <= 30; i++) player.setTime(i / 10)
    await nextTick()

    expect(hostShellUpdates).toBe(0)
  })

  it('still re-renders on real state changes (the counter is live)', async () => {
    mountShell()
    await nextTick()
    hostShellUpdates = 0

    useSongsStore().currentSong = { id: 1, title: 'counter sanity' }
    await nextTick()

    expect(hostShellUpdates).toBeGreaterThan(0)
  })
})
