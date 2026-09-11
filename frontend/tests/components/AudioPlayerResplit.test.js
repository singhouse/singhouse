// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// What the deck still owes a re-split after the control moved to Song tools.
//
// The job is started elsewhere now and tracked on the songs store, keyed by
// song id. The player's remaining job is the one thing only it can do: a
// finished re-split writes new files at the SAME stem URLs, so the deck must
// reload against cache-busted URLs or the browser keeps playing the audio it
// already has and the re-split looks like it did nothing.
//
// The race this used to have is the reason the record is keyed by song: the
// job runs for minutes and the deck can be pointed at another song long
// before it finishes, and reloading THAT song for a job it had nothing to do
// with would interrupt whoever is singing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const engine = vi.hoisted(() => ({
  stub: {
    currentTime: { value: 0 },
    duration: { value: 0 },
    playerState: { value: 'stopped' },
    keyOffset: { value: 0 },
    keyShiftSupported: { value: true },
    loadStems: vi.fn(async () => ({ durations: [200] })),
    startAnimationLoop: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setKey: vi.fn(),
    setVolume: vi.fn(),
    cleanup: vi.fn(),
  },
}))

vi.mock('@/composables/useAudioEngine', () => ({
  useAudioEngine: () => engine.stub,
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(), get: vi.fn(async () => ({ data: {} })), pollJob: vi.fn() },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
}))

// The job records have to be REACTIVE for the player's watcher to see them —
// that is the whole mechanism under test — so the fake store keeps them in a
// `reactive` map the test writes into, exactly as the real store does.
vi.mock('@/stores/songs', async () => {
  const { reactive } = await import('vue')
  const jobs = reactive({})
  const store = {
    fetchLyrics: vi.fn(async () => null),
    loadSong: vi.fn(async () => ({})),
    jobFor: id => jobs[id] ?? null,
    isJobRunning: () => false,
  }
  return { useSongsStore: () => store, JOB_KIND_LABELS: {}, __jobs: jobs, __store: store }
})
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ load: vi.fn(async () => {}), lyricsLookupEnabled: false }),
}))

import AudioPlayer from '@/components/AudioPlayer.vue'
import { useSongToolsStore } from '@/stores/songTools'
import { __jobs as jobs, __store as store } from '@/stores/songs'

const PAIR = [
  { id: 'lead', name: null, url: '/lead.wav' },
  { id: 'backing', name: null, url: '/backing.wav' },
]

function song(overrides = {}) {
  return {
    id: 42,
    title: 'Heroes',
    artist: 'Bowie',
    status: 'ready',
    has_video: false,
    stems: { instrumental: '/i.wav', karaoke: '/k.wav', vocals: PAIR },
    ...overrides,
  }
}

async function mountPlayer(props) {
  const w = mount(AudioPlayer, {
    props: { song: props },
    global: { stubs: { ProgressBar: true } },
  })
  await new Promise(r => setTimeout(r))
  await w.vm.$nextTick()
  return w
}

/** Drive the store's job record the way a real re-split would. */
function jobIs(songId, record) {
  for (const key of Object.keys(jobs)) delete jobs[key]
  jobs[songId] = record
}

let wrapper = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  for (const key of Object.keys(jobs)) delete jobs[key]
  store.loadSong.mockResolvedValue({})
  store.fetchLyrics.mockResolvedValue(null)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('AudioPlayer and a finished re-split', () => {
  it('cache-busts and reloads the song the job was for', async () => {
    wrapper = await mountPlayer(song())

    jobIs(42, { kind: 'resplit', status: 'running' })
    await wrapper.vm.$nextTick()
    jobIs(42, { kind: 'resplit', status: 'done' })
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).toHaveBeenCalledWith({ id: 42 })
    expect(wrapper.vm.$el.outerHTML).not.toContain('undefined')
    // The reload runs against stamped URLs.
    const stems = engine.stub.loadStems.mock.calls.at(-1)[0]
    expect(stems.some(s => /\?v=\d+/.test(s.url))).toBe(true)
  })

  it('ignores a job belonging to a song the deck is not showing', async () => {
    wrapper = await mountPlayer(song())
    store.loadSong.mockClear()

    jobIs(99, { kind: 'resplit', status: 'running' })
    await wrapper.vm.$nextTick()
    jobIs(99, { kind: 'resplit', status: 'done' })
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).not.toHaveBeenCalled()
    expect(wrapper.vm.$el.outerHTML).not.toContain('?v=')
  })

  it('does not reload for a re-split that was already finished when it mounted', async () => {
    // Opening the panel on a song whose re-split landed an hour ago must not
    // interrupt playback to refresh it.
    jobIs(42, { kind: 'resplit', status: 'done' })
    wrapper = await mountPlayer(song())
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).not.toHaveBeenCalled()
  })

  it('does not reload when the deck moves onto a song whose re-split is already done', async () => {
    // Two songs can carry a job record at once. The watched value is the
    // CURRENT song's status, so switching the deck from song 42 (re-splitting)
    // to song 99 (finished earlier) reads as running → done even though
    // nothing landed — and reloading 99 here would cache-bust and re-fetch it
    // on top of the load the song change itself already started.
    wrapper = await mountPlayer(song())
    jobs[42] = { kind: 'resplit', status: 'running' }
    jobs[99] = { kind: 'resplit', status: 'done' }
    await wrapper.vm.$nextTick()
    store.loadSong.mockClear()
    engine.stub.loadStems.mockClear()

    await wrapper.setProps({ song: song({ id: 99 }) })
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).not.toHaveBeenCalled()
    // The one load that DID happen is the ordinary song change: no cache-bust,
    // and only one of them.
    expect(engine.stub.loadStems).toHaveBeenCalledTimes(1)
    const stems = engine.stub.loadStems.mock.calls.at(-1)[0]
    expect(stems.every(s => !/\?v=\d+/.test(s.url))).toBe(true)
  })

  it('still reloads a re-split that lands while the deck sits on that song', async () => {
    // The mirror of the case above: the id did NOT change across the
    // transition, so this one is genuinely this song's re-split landing.
    wrapper = await mountPlayer(song())
    jobs[42] = { kind: 'resplit', status: 'running' }
    jobs[99] = { kind: 'resplit', status: 'done' }
    await wrapper.vm.$nextTick()
    store.loadSong.mockClear()

    jobs[42] = { kind: 'resplit', status: 'done' }
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).toHaveBeenCalledWith({ id: 42 })
  })

  it('ignores a finished job of another kind', async () => {
    wrapper = await mountPlayer(song())
    store.loadSong.mockClear()

    jobIs(42, { kind: 'transcribe', status: 'running' })
    await wrapper.vm.$nextTick()
    jobIs(42, { kind: 'transcribe', status: 'done' })
    await new Promise(r => setTimeout(r, 10))

    expect(store.loadSong).not.toHaveBeenCalled()
  })
})

describe('AudioPlayer mixer entry', () => {
  it('opens Song tools on the loaded song and closes the popover', async () => {
    wrapper = await mountPlayer(song())
    await wrapper.find('.bar__mixer-toggle').trigger('click')
    await wrapper.vm.$nextTick()

    const mixer = wrapper.findComponent({ name: 'MixerPopover' })
    expect(mixer.text()).toContain('Song tools')
    await mixer.vm.$emit('song-tools')
    await wrapper.vm.$nextTick()

    expect(useSongToolsStore().songId).toBe(42)
    expect(wrapper.findComponent({ name: 'MixerPopover' }).exists()).toBe(false)
  })

  it('no longer carries a re-split control of its own', async () => {
    // It moved to the Stems tab, which can be opened for any song in the
    // library rather than only the one on the deck.
    wrapper = await mountPlayer(song())
    await wrapper.find('.bar__mixer-toggle').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mixer__resplit').exists()).toBe(false)
  })
})

describe('AudioPlayer and an activated lyrics set', () => {
  it('re-draws when the active set changes underneath it', async () => {
    // Song tools activating another version refreshes the store's song detail,
    // which arrives here as a new word_sync. Without this the deck keeps
    // drawing the set that was active when it loaded.
    wrapper = await mountPlayer(song())
    const before = (wrapper.emitted('lyrics-loaded') || []).length

    await wrapper.setProps({
      song: song({ word_sync: { segments: [{ words: [{ word: 'hi', start: 0, end: 1 }] }] } }),
    })
    await new Promise(r => setTimeout(r, 10))

    const after = wrapper.emitted('lyrics-loaded')
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)[0]).toMatchObject({ segments: expect.any(Array) })
  })
})
