// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract test for HostShell's 'queue-provider' mount. An installed
// package (premium's rotation in real builds) registers ONE object under that
// slot; core must mount its panel instead of BasicManualQueue, read who is up
// through it, and hand it every finished performance. With nothing registered,
// core must fall back to its own queue and do none of that.
//
// This pins the seam in both directions, which is the whole point: the core
// build has no rotation to catch a break, and the premium build has no core
// fallback to catch the opposite one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
  queueApi: { list: vi.fn(async () => ({ data: { entries: [] } })) },
  sessionApi: {
    config: vi.fn(async () => ({ data: {} })),
    me: vi.fn(async () => ({ data: {} })),
  },
}))

// The popout machinery opens real windows and broadcasts heartbeats; none of
// that is under test here.
vi.mock('@/composables/useLyricsWindow', () => ({
  useLyricsWindow: () => ({ isOpen: ref(false), open: vi.fn(), close: vi.fn() }),
  getScreens: vi.fn(async () => ({ screens: [], primary: null })),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), hasRoute: () => false }),
}))

const provider = vi.hoisted(() => ({
  registered: null,
  onSongEnded: null,
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'queue-provider' ? provider.registered : null),
  slotHasContent: (name) => name === 'queue-provider' && !!provider.registered,
  registerSlot: vi.fn(),
}))

import HostShell from '@/views/HostShell.vue'

const PanelStub = {
  name: 'ProviderPanelStub',
  template: '<div class="provider-panel" />',
}
const PillStub = {
  name: 'ProviderPillStub',
  template: '<div class="provider-pill" />',
}
const AudioPlayerStub = {
  name: 'AudioPlayerStub',
  props: ['song'],
  emits: ['ended'],
  template: '<div class="audio-player-stub" />',
}
// Renders the header slots HostShell fills, so the brand-mark account
// popover (where the status pill now lives) is reachable.
const SongListStub = {
  name: 'SongListStub',
  template: '<div class="song-list-stub"><slot name="lead" /><slot name="actions" /></div>',
}
const QueuePanelStub = {
  name: 'QueuePanelStub',
  template: '<div class="core-queue-panel" />',
}

let wrapper = null

function mountShell() {
  return mount(HostShell, {
    global: {
      stubs: {
        AudioPlayer: AudioPlayerStub,
        QueuePanel: QueuePanelStub,
        ScreenStage: true,
        SongList: SongListStub,
        teleport: true,
        UploadZone: true,
        Modal: true,
        BrandLogo: true,
        BrandMark: true,
        'router-link': true,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  provider.registered = null
  provider.onSongEnded = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('with a queue provider registered', () => {
  beforeEach(() => {
    provider.registered = {
      panel: PanelStub,
      statusPill: PillStub,
      useCurrent: () => computed(() => null),
      useAdvancing: () => computed(() => false),
      onSongEnded: (...a) => provider.onSongEnded(...a),
    }
  })

  it('mounts the provider panel instead of the core queue', () => {
    wrapper = mountShell()
    expect(wrapper.find('.provider-panel').exists()).toBe(true)
    expect(wrapper.find('.core-queue-panel').exists()).toBe(false)
  })

  it('renders the provider status pill in the account popover', async () => {
    wrapper = mountShell()
    expect(wrapper.find('.provider-pill').exists()).toBe(false)
    await wrapper.find('.brand-btn').trigger('click')
    expect(wrapper.find('.provider-pill').exists()).toBe(true)
  })

  it('forwards the whole ended payload to onSongEnded', async () => {
    wrapper = mountShell()
    // AudioPlayer only exists once a song is loaded.
    wrapper.vm.store.currentSong = { id: 7, title: 'Heroes' }
    await wrapper.vm.$nextTick()

    const info = { songId: 7, reason: 'natural', positionSec: 214.5, durationSec: 215 }
    wrapper.findComponent(AudioPlayerStub).vm.$emit('ended', info)

    expect(provider.onSongEnded).toHaveBeenCalledTimes(1)
    expect(provider.onSongEnded).toHaveBeenCalledWith(info)
  })
})

describe('with no queue provider registered (core assembly)', () => {
  it('falls back to the core queue panel', () => {
    wrapper = mountShell()
    expect(wrapper.find('.core-queue-panel').exists()).toBe(true)
    expect(wrapper.find('.provider-panel').exists()).toBe(false)
  })

  it('renders no provider status pill', () => {
    wrapper = mountShell()
    expect(wrapper.find('.provider-pill').exists()).toBe(false)
  })

  it('swallows a finished song without a provider to hand it to', async () => {
    wrapper = mountShell()
    wrapper.vm.store.currentSong = { id: 7, title: 'Heroes' }
    await wrapper.vm.$nextTick()

    expect(() =>
      wrapper
        .findComponent(AudioPlayerStub)
        .vm.$emit('ended', { songId: 7, reason: 'natural', positionSec: 1, durationSec: 2 }),
    ).not.toThrow()
  })
})

// ── Auto-load of the current singer's pick ──────────────────────────────────
// The shell watches the provider's current pick and loads its song, but never
// over a live deck: a busy deck stashes the pick and applies it at the next
// stop. That deferral is the part the seam put at risk — the provider is now
// an installed package, so nothing but these cases holds the shell's half of
// it in place.
describe('auto-loading the current pick', () => {
  const pick = ref(null)        // { key, songId } | null — the provider's view
  const advancing = ref(false)  // the provider's mid-cycle flag
  let loadSong = null

  beforeEach(() => {
    pick.value = null
    advancing.value = false
    provider.registered = {
      panel: PanelStub,
      useCurrent: () => computed(() => pick.value),
      useAdvancing: () => computed(() => advancing.value),
      onSongEnded: vi.fn(),
    }
  })

  // Mount, then stub the store action the watchers call. Both watchers are
  // non-immediate, so nothing has fired yet at this point.
  async function mountWithSpy() {
    wrapper = mountShell()
    loadSong = vi.spyOn(wrapper.vm.store, 'loadSong').mockImplementation(async () => {})
    await wrapper.vm.$nextTick()
    return wrapper
  }

  const setState = async (s) => {
    wrapper.vm.player.setPlayState(s)
    await wrapper.vm.$nextTick()
  }

  it('loads immediately when the deck is idle', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    expect(loadSong).toHaveBeenCalledTimes(1)
    expect(loadSong).toHaveBeenCalledWith({ id: 5 })
  })

  it('does not interrupt a playing deck when a new singer becomes current', async () => {
    await mountWithSpy()
    await setState('playing')

    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // Reordering the queue mid-song reassigns "current" on the backend; that
    // must never cut the audio out from under whoever is singing.
    expect(loadSong).not.toHaveBeenCalled()
  })

  it('holds the stash back while the provider is advancing', async () => {
    await mountWithSpy()
    await setState('playing')
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // Natural end of track: the deck reaches 'stopped' while the provider's
    // advance is still in flight, so the pick still names the OUTGOING singer.
    // Applying the stash here loads a song that is superseded a few hundred ms
    // later — the double-load this flag exists to remove.
    advancing.value = true
    await setState('stopped')

    expect(loadSong).not.toHaveBeenCalled()
  })

  it('applies the stash exactly once on a stop that is not an advance', async () => {
    await mountWithSpy()
    await setState('playing')
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // Host hit Stop: nobody is advancing, so the singer's stashed pick loads —
    // and loads once.
    await setState('stopped')

    expect(loadSong).toHaveBeenCalledTimes(1)
    expect(loadSong).toHaveBeenCalledWith({ id: 5 })
  })

  it('drops a stash whose singer is no longer up', async () => {
    await mountWithSpy()
    await setState('playing')
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // The host advanced past that singer mid-song; the new one has not picked
    // anything yet, so there is nothing to load in their place either.
    pick.value = { key: 'e2', songId: null }
    await wrapper.vm.$nextTick()
    await setState('stopped')

    expect(loadSong).not.toHaveBeenCalled()
  })

  it('loads the new singer, not the stale stash, when the queue moved on', async () => {
    await mountWithSpy()
    await setState('playing')
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    pick.value = { key: 'e2', songId: 9 }
    await wrapper.vm.$nextTick()
    await setState('stopped')

    expect(loadSong).toHaveBeenCalledTimes(1)
    expect(loadSong).toHaveBeenCalledWith({ id: 9 })
  })
})

// ── onSongStarted notification ──────────────────────────────────────────────
// The optional half of the play lifecycle: the shell ARMS a notification where
// the provider's current pick reaches the deck (either load site, and the
// load-free back-to-back case) and FIRES it — { entryId, songId } — at the
// deck's next transition to 'playing'. Play-time, not load-time: every open
// host shell auto-loads the pick (that is what keeps a projector window in
// sync), so a load-time signal fires once per open window — a provider
// keeping history wrote duplicate rows for every performance. Only the
// shell whose deck actually plays owns the performance. A walk-up fallback
// covers the host loading a song by hand for whoever is up: the first play
// while the current entry is unannounced is that singer's performance.
// Optional by contract: a provider without it must lose nothing but the
// notification.
describe('onSongStarted notification', () => {
  const pick = ref(null)
  const advancing = ref(false)
  let onSongStarted = null
  let loadSong = null

  beforeEach(() => {
    pick.value = null
    advancing.value = false
    onSongStarted = vi.fn()
    provider.registered = {
      panel: PanelStub,
      useCurrent: () => computed(() => pick.value),
      useAdvancing: () => computed(() => advancing.value),
      onSongEnded: vi.fn(),
      onSongStarted: (...a) => onSongStarted(...a),
    }
  })

  async function mountWithSpy() {
    wrapper = mountShell()
    loadSong = vi.spyOn(wrapper.vm.store, 'loadSong').mockImplementation(async () => {})
    await wrapper.vm.$nextTick()
    return wrapper
  }

  const setState = async (s) => {
    wrapper.vm.player.setPlayState(s)
    await wrapper.vm.$nextTick()
  }

  // loadSong is stubbed, so tests land the load themselves — exactly what the
  // real action does on response.
  const landLoad = async (id) => {
    wrapper.vm.store.currentSong = { id }
    await wrapper.vm.$nextTick()
  }

  it('stays silent at load — a window that only loads never notifies', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)

    // This is the projector-window pin: loading alone (which every open host
    // shell does) must produce nothing.
    expect(loadSong).toHaveBeenCalledWith({ id: 5 })
    expect(onSongStarted).not.toHaveBeenCalled()
  })

  it('notifies with { entryId, songId } when the deck starts playing the pick', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)

    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledWith({ entryId: 'e1', songId: 5 })
  })

  it('does not repeat on pause/resume — one notification per performance', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    await setState('paused')
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(1)
  })

  it('notifies a stashed pick only when it plays, not when it applies at stop', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // Next singer picks mid-song: deck busy, pick stashed.
    pick.value = { key: 'e2', songId: 9 }
    await wrapper.vm.$nextTick()
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // Host stops: the stash applies (loads e2's song) but nothing plays yet.
    await setState('stopped')
    expect(loadSong).toHaveBeenLastCalledWith({ id: 9 })
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    await landLoad(9)
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(2)
    expect(onSongStarted).toHaveBeenLastCalledWith({ entryId: 'e2', songId: 9 })
  })

  it('does not notify while the deck is busy and the pick is only stashed', async () => {
    await mountWithSpy()
    await setState('playing')
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // No load happened and no play started — a notification here would record
    // a play for a song that never reached the deck.
    expect(loadSong).not.toHaveBeenCalled()
    expect(onSongStarted).not.toHaveBeenCalled()
  })

  it('notifies load-free when a new entry plays the song already up (back-to-back)', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)
    await setState('stopped')

    // The next singer picked the same crowd-pleaser. No load is needed — but
    // playing it again is a second performance, and skipping it here is how
    // the second of two back-to-back plays of one song used to vanish.
    pick.value = { key: 'e2', songId: 5 }
    await wrapper.vm.$nextTick()
    expect(loadSong).toHaveBeenCalledTimes(1) // e1's load only
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(2)
    expect(onSongStarted).toHaveBeenLastCalledWith({ entryId: 'e2', songId: 5 })
  })

  it('stays silent when the same entry re-picks the loaded song', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)
    await setState('stopped')

    // e1 clears their pick and then re-picks the song already up. Same entry,
    // nothing new in the deck: announcing the revert (or replaying the song)
    // would double-record e1's single performance.
    pick.value = { key: 'e1', songId: null }
    await wrapper.vm.$nextTick()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await setState('playing')

    expect(loadSong).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledTimes(1)
  })

  it('walk-up: a hand-loaded song plays as the current singer\'s performance', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)

    // The singer walked up and asked for something else: the host loads it
    // from the library directly. The manual load supersedes the armed pick,
    // and the song that actually PLAYS is what gets recorded — for the singer
    // who is actually up.
    await landLoad(9)
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledWith({ entryId: 'e1', songId: 9 })

    // The entry is spent: a restart or filler after their song adds nothing.
    await setState('stopped')
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)
  })

  it('walk-up: works for a singer who never picked at all', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null }
    await wrapper.vm.$nextTick()

    await landLoad(9)
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledWith({ entryId: 'e1', songId: 9 })
  })

  it('attributes nothing when nobody is current', async () => {
    await mountWithSpy()
    await landLoad(9)
    await setState('playing')

    expect(onSongStarted).not.toHaveBeenCalled()
  })

  it('stays silent when play hits the OLD song while an armed load is in flight', async () => {
    await mountWithSpy()
    await landLoad(3)
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    expect(loadSong).toHaveBeenCalledWith({ id: 5 })

    // e1's load has not landed; the deck still holds the outgoing song. A
    // play here must not pin the wrong song on e1 — the armed pick wins when
    // it lands.
    await setState('playing')
    expect(onSongStarted).not.toHaveBeenCalled()

    // ...and when it lands, it does win: landing clears the deck to
    // 'stopped', and the next play announces the armed pick.
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledWith({ entryId: 'e1', songId: 5 })
  })

  it('a resume after a mid-song entry change is not a first play (stashed pick)', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // Routine mid-song move: e2 becomes current, their pick stashes. Banter
    // pause, resume. The resume must not walk-up e1's PLAYING song onto e2.
    pick.value = { key: 'e2', songId: 9 }
    await wrapper.vm.$nextTick()
    await setState('paused')
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // The real flow then completes: stop applies the stash, e2's song plays.
    await setState('stopped')
    await landLoad(9)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(2)
    expect(onSongStarted).toHaveBeenLastCalledWith({ entryId: 'e2', songId: 9 })
  })

  it('a resume after advancing to a songless entry writes nothing for them', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // e2 is current with no pick; e1's song is still the one playing. A
    // pause/resume (or the pause/play bounce a seek produces) must not
    // attribute that already-announced performance to e2.
    pick.value = { key: 'e2', songId: null }
    await wrapper.vm.$nextTick()
    await setState('paused')
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(1)
  })

  it('an arming made while paused fires at the next real play, not the resume', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)
    await setState('paused')

    // Paused + a NEW entry whose pick is the same song already up: the deck
    // is not busy for a new singer, so this arms load-free. Resuming e1's
    // song must not announce e2 mid-performance...
    pick.value = { key: 'e2', songId: 5 }
    await wrapper.vm.$nextTick()
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(1)

    // ...but e2's genuine play (from stopped) fires the arming.
    await setState('stopped')
    await setState('playing')
    expect(onSongStarted).toHaveBeenCalledTimes(2)
    expect(onSongStarted).toHaveBeenLastCalledWith({ entryId: 'e2', songId: 5 })
  })

  it('a stale arming does not spend the NEW current entry\'s announcement', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await wrapper.vm.$nextTick()

    // Rotation moves past e1 before anything plays; e2 has no pick yet.
    pick.value = { key: 'e2', songId: null }
    await wrapper.vm.$nextTick()
    await landLoad(5)
    await setState('playing')

    // The armed notification fires with e1 — the provider's own staleness
    // check is what drops it — but e2 must remain announceable.
    expect(onSongStarted).toHaveBeenCalledTimes(1)
    expect(onSongStarted).toHaveBeenCalledWith({ entryId: 'e1', songId: 5 })

    await setState('stopped')
    await landLoad(9)
    await setState('playing')

    expect(onSongStarted).toHaveBeenCalledTimes(2)
    expect(onSongStarted).toHaveBeenLastCalledWith({ entryId: 'e2', songId: 9 })
  })

  it('is optional: a provider without it still loads and plays picks cleanly', async () => {
    provider.registered = {
      panel: PanelStub,
      useCurrent: () => computed(() => pick.value),
      useAdvancing: () => computed(() => advancing.value),
      onSongEnded: vi.fn(),
    }
    await mountWithSpy()
    pick.value = { key: 'e1', songId: 5 }
    await expect(wrapper.vm.$nextTick()).resolves.toBeUndefined()
    await landLoad(5)
    await expect(setState('playing')).resolves.toBeUndefined()

    expect(loadSong).toHaveBeenCalledWith({ id: 5 })
  })
})

// ── Songless-pick banner ────────────────────────────────────────────────────
// When the provider's current entry has nothing loadable (no pick yet, or a
// free-text pick with no library link), the shell can't touch the deck — and a
// silent no-op there caused a double-advance past a singer. These pin
// the banner that now surfaces that state: it appears only for a songless
// ENTRY, clears the moment a loadable pick arrives or the queue empties, falls
// back to generic copy when the optional label/songText seam fields are
// omitted, and a dismissal holds across poll echoes of the same key|songId.
describe('songless-pick banner', () => {
  const pick = ref(null)
  const advancing = ref(false)
  let loadSong = null

  beforeEach(() => {
    pick.value = null
    advancing.value = false
    provider.registered = {
      panel: PanelStub,
      useCurrent: () => computed(() => pick.value),
      useAdvancing: () => computed(() => advancing.value),
      onSongEnded: vi.fn(),
    }
  })

  async function mountWithSpy() {
    wrapper = mountShell()
    loadSong = vi.spyOn(wrapper.vm.store, 'loadSong').mockImplementation(async () => {})
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('appears with the free-text copy when the entry has an unlinked song', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null, label: 'Alice', songText: 'Freebird at half speed' }
    await wrapper.vm.$nextTick()

    const notice = wrapper.find('.pick-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('Alice is up')
    expect(notice.text()).toContain('“Freebird at half speed” isn’t linked to a library song')
    expect(loadSong).not.toHaveBeenCalled()
  })

  it('appears with the no-pick copy when the entry has no song at all', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null, label: 'Alice', songText: null }
    await wrapper.vm.$nextTick()

    const notice = wrapper.find('.pick-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('Alice is up')
    expect(notice.text()).toContain('hasn’t picked a song yet')
  })

  it('falls back to generic copy when the provider omits label and songText', async () => {
    // label/songText are OPTIONAL on the seam — a provider that reports only
    // { key, songId } must still get a coherent banner, not "undefined is up".
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null }
    await wrapper.vm.$nextTick()

    const notice = wrapper.find('.pick-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('Current singer is up')
    expect(notice.text()).toContain('hasn’t picked a song yet')
  })

  it('clears when a loadable pick arrives', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null, label: 'Alice' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pick-notice').exists()).toBe(true)

    pick.value = { key: 'e1', songId: 5, label: 'Alice' }
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.pick-notice').exists()).toBe(false)
    expect(loadSong).toHaveBeenCalledWith({ id: 5 })
  })

  it('clears when the queue empties', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null, label: 'Alice' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pick-notice').exists()).toBe(true)

    pick.value = null
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.pick-notice').exists()).toBe(false)
  })

  it('stays dismissed across a poll echo of the same pick', async () => {
    await mountWithSpy()
    pick.value = { key: 'e1', songId: null, label: 'Alice' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pick-notice').exists()).toBe(true)

    await wrapper.find('.pick-notice__dismiss').trigger('click')
    expect(wrapper.find('.pick-notice').exists()).toBe(false)

    // A polling provider hands back a FRESH object each tick; same key|songId
    // is not a change, and a dismissed banner must not resurrect on the echo.
    pick.value = { key: 'e1', songId: null, label: 'Alice' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pick-notice').exists()).toBe(false)

    // The NEXT songless entry is news again.
    pick.value = { key: 'e2', songId: null, label: 'Bob' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pick-notice').exists()).toBe(true)
    expect(wrapper.find('.pick-notice').text()).toContain('Bob is up')
  })
})

describe('the provider contract itself', () => {
  it('is read once at setup, from within a component', () => {
    // useCurrent()/useAdvancing() may create computeds off a pinia store, so
    // they must run inside setup() — never at registration time, when pinia
    // does not exist yet. Both are called exactly once per shell.
    const useCurrent = vi.fn(() => computed(() => null))
    const useAdvancing = vi.fn(() => computed(() => false))
    provider.registered = { panel: PanelStub, useCurrent, useAdvancing, onSongEnded: vi.fn() }

    wrapper = mountShell()

    expect(useCurrent).toHaveBeenCalledTimes(1)
    expect(useAdvancing).toHaveBeenCalledTimes(1)
  })

  it('treats statusPill and useAdvancing as optional', () => {
    // panel/useCurrent/onSongEnded are the required three; a provider with no
    // status to report and no in-flight state must still mount cleanly.
    provider.registered = {
      panel: PanelStub,
      useCurrent: () => computed(() => null),
      onSongEnded: vi.fn(),
    }
    expect(() => { wrapper = mountShell() }).not.toThrow()
    expect(wrapper.find('.provider-panel').exists()).toBe(true)
    expect(wrapper.find('.provider-pill').exists()).toBe(false)
  })
})
