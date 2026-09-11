// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The Stems and Details tabs of the Song tools panel.
//
// Stems is where the re-split moved to from the mixer: the mixer only existed
// for the song on the deck and only while its popover was open, which are the
// two things least true of a job that runs for minutes.
//
// Details is the first surface to call PATCH /api/songs/{id} at all, and the
// only way back from a failed ingest — which used to be a dead row.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  resplit: vi.fn(),
  retryIngest: vi.fn(),
  updateSong: vi.fn(),
  pollJob: vi.fn(),
  list: vi.fn(async () => ({ data: { songs: [], total: 0 } })),
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    get: vi.fn(async () => ({ data: {} })),
    list: (...a) => api.list(...a),
    resplit: (...a) => api.resplit(...a),
    retryIngest: (...a) => api.retryIngest(...a),
    updateSong: (...a) => api.updateSong(...a),
    pollJob: (...a) => api.pollJob(...a),
  },
  lyricsSetsApi: { list: vi.fn(async () => ({ data: [] })) },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
}))

import StemsTab from '@/components/songtools/StemsTab.vue'
import DetailsTab from '@/components/songtools/DetailsTab.vue'
import { useSongsStore } from '@/stores/songs'
import { KARAOKE_MODELS } from '@/utils/karaokeModels'

const PAIR = [
  { id: 'lead', name: null, url: '/lead.wav' },
  { id: 'backing', name: null, url: '/backing.wav' },
]

function readySong(overrides = {}) {
  return {
    id: 42,
    status: 'ready',
    has_video: false,
    artist: 'Bowie',
    title: 'Heroes',
    duration: 245,
    created_at: '2026-08-01T10:00:00',
    filename: 'heroes.flac',
    stems: { instrumental: '/i.wav', vocals: PAIR },
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  api.resplit.mockResolvedValue({ data: { job_id: 'j-resplit' } })
  api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'separating' } })
})

describe('Stems tab', () => {
  it('offers exactly the shared model list, in order', async () => {
    // Upload and this picker choose the same Pass-2 model, and the ids are the
    // server's allowlist. Two copies of the list meant one was always about to
    // drift, so both read the same module.
    const w = mount(StemsTab, { props: { songId: 42, song: readySong() } })
    const options = w.findAll('.stems__select option')
    expect(options.map(o => o.attributes('value'))).toEqual(KARAOKE_MODELS.map(m => m.id))
    expect(options.map(o => o.text())).toEqual(KARAOKE_MODELS.map(m => m.label))
  })

  it('starts the job on the song the panel is showing', async () => {
    const w = mount(StemsTab, { props: { songId: 42, song: readySong() } })
    await w.find('.stems__select').setValue('mdxnet_kara2')
    await w.find('.stems__go').trigger('click')
    await flushPromises()

    expect(api.resplit).toHaveBeenCalledWith(42, { karaoke_model: 'mdxnet_kara2' })
    expect(useSongsStore().jobFor(42).kind).toBe('resplit')
  })

  it('says why it is unavailable instead of offering a doomed button', async () => {
    const w = mount(StemsTab, {
      props: { songId: 42, song: readySong({ has_video: true }) },
    })
    expect(w.find('.stems__go').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/karaoke video/)
  })

  it('warns that the timing will need a re-fit afterwards', async () => {
    const w = mount(StemsTab, { props: { songId: 42, song: readySong() } })
    expect(w.text()).toMatch(/timing will need a re-fit/)
  })

  it('locks out while another job is running for this song', async () => {
    const store = useSongsStore()
    const w = mount(StemsTab, { props: { songId: 42, song: readySong() } })
    store.startResplit(42, { karaoke_model: 'roformer' })
    await flushPromises()

    expect(w.vm.blocked).toMatch(/already running/)
  })
})

describe('Details tab', () => {
  it('PATCHes the edited artist and title', async () => {
    api.updateSong.mockResolvedValue({ data: { id: 42, artist: 'David Bowie', title: 'Heroes' } })
    const w = mount(DetailsTab, { props: { songId: 42, song: readySong() } })

    const [artist] = w.findAll('.det__field input')
    await artist.setValue('David Bowie')
    await w.find('.det__go').trigger('click')
    await flushPromises()

    expect(api.updateSong).toHaveBeenCalledWith(42, { artist: 'David Bowie', title: 'Heroes' })
    expect(w.emitted('refresh')).toBeTruthy()
  })

  it('will not save an unchanged form', async () => {
    const w = mount(DetailsTab, { props: { songId: 42, song: readySong() } })
    expect(w.find('.det__go').attributes('disabled')).toBeDefined()
  })

  it('re-seeds the fields when the panel is re-pointed at another song', async () => {
    // An edit typed against song 42 must never be saved onto song 43.
    const w = mount(DetailsTab, { props: { songId: 42, song: readySong() } })
    await w.findAll('.det__field input')[0].setValue('Typo')
    await w.setProps({ songId: 43, song: readySong({ id: 43, artist: 'Queen', title: 'Radio Ga Ga' }) })
    await flushPromises()

    expect(w.findAll('.det__field input')[0].element.value).toBe('Queen')
    expect(w.vm.dirty).toBe(false)
  })

  it('shows the ingest error and offers a retry for a failed song', async () => {
    api.retryIngest.mockResolvedValue({
      data: { job_id: 'j-retry', song_id: 42, options_recovered: true, message: 'queued' },
    })
    const song = readySong({ status: 'failed', error_message: 'Separation crashed: OOM' })
    const w = mount(DetailsTab, { props: { songId: 42, song } })

    expect(w.text()).toContain('Separation crashed: OOM')
    await w.find('.det__block--bad .det__go').trigger('click')
    await flushPromises()

    expect(api.retryIngest).toHaveBeenCalledWith(42)
    expect(useSongsStore().jobFor(42).kind).toBe('retry')
  })

  it('surfaces the retry refusal verbatim on the song’s job record', async () => {
    const detail = 'Song 42 has no separated stems and no record of the audio '
      + 'it was made from — upload the file again.'
    api.retryIngest.mockRejectedValue(new Error(detail))
    const w = mount(DetailsTab, {
      props: { songId: 42, song: readySong({ status: 'failed', error_message: 'boom' }) },
    })

    await w.find('.det__block--bad .det__go').trigger('click')
    await flushPromises()

    expect(useSongsStore().jobFor(42).error).toBe(detail)
  })

  it('says when the retry fell back to server defaults', async () => {
    api.retryIngest.mockResolvedValue({
      data: { job_id: 'j-retry', song_id: 42, options_recovered: false, message: 'queued' },
    })
    const w = mount(DetailsTab, {
      props: { songId: 42, song: readySong({ status: 'failed', error_message: 'boom' }) },
    })

    await w.find('.det__block--bad .det__go').trigger('click')
    await flushPromises()

    expect(w.text()).toMatch(/could not be read back/)
  })

  it('keeps the fallback notice after the retry flips the row to processing', async () => {
    // The retry the notice is about moves the row to `processing` within a
    // second of the click. Inside the failed block the notice vanished on the
    // very click that produced it, so the one line saying "this run is not the
    // run you asked for" was unreadable in practice.
    api.retryIngest.mockResolvedValue({
      data: { job_id: 'j-retry', song_id: 42, options_recovered: false, message: 'queued' },
    })
    api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'separating' } })
    const w = mount(DetailsTab, {
      props: { songId: 42, song: readySong({ status: 'failed', error_message: 'boom' }) },
    })

    await w.find('.det__block--bad .det__go').trigger('click')
    await flushPromises()
    expect(w.text()).toMatch(/could not be read back/)

    await w.setProps({ song: readySong({ status: 'processing', phase: 'separating' }) })
    await flushPromises()

    expect(w.text()).toContain('Separating stems')
    expect(w.text()).toMatch(/could not be read back/)
  })

  it('shows the ingest phase for a song still processing', async () => {
    const w = mount(DetailsTab, {
      props: {
        songId: 42,
        song: readySong({ status: 'processing', phase: 'separating', progress: 40 }),
      },
    })
    expect(w.text()).toContain('Separating stems')
    expect(w.text()).toContain('40%')
  })
})
