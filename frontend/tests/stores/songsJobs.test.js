// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Per-song job tracking.
//
// Every long-running per-song action used to poll inside whichever component
// started it, and that is where the races lived: a panel re-pointed at another
// song inherited the first song's "busy", and a job finishing after the deck
// moved on refreshed the wrong song. The record is now keyed by song id and
// the id is captured at start, so the properties worth pinning are all about
// two songs never seeing each other's job.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  pollJob: vi.fn(),
  list: vi.fn(async () => ({ data: { songs: [], total: 0 } })),
  retryIngest: vi.fn(),
  updateSong: vi.fn(),
  get: vi.fn(async () => ({ data: {} })),
  resplit: vi.fn(),
}))

const setsApi = vi.hoisted(() => ({
  realign: vi.fn(),
  transcribe: vi.fn(),
  page: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: api,
  lyricsSetsApi: setsApi,
}))

import { useSongsStore } from '@/stores/songs'

// The store polls on a 3s timer; fake timers keep that instant without the
// test having to know the interval.
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3000)
  }
}

beforeEach(() => {
  delete window.karaokeDesktop
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setsApi.realign.mockResolvedValue({ data: { job_id: 'j-realign' } })
  setsApi.transcribe.mockResolvedValue({ data: { job_id: 'j-transcribe' } })
  setsApi.page.mockResolvedValue({ data: { job_id: 'j-page' } })
  api.resplit.mockResolvedValue({ data: { job_id: 'j-resplit' } })
  api.pollJob.mockResolvedValue({ data: { status: 'done', message: 'Finished' } })
})

it('does not submit transcription after declined model setup', async () => {
  window.karaokeDesktop = { isDesktop: true, prepareHeart: vi.fn().mockResolvedValue({ installed: false }) }
  const store = useSongsStore()
  await store.startTranscribe(7, { whisper_model: 'heart' })
  expect(setsApi.transcribe).not.toHaveBeenCalled()
  expect(store.jobFor(7).message).toContain('cancelled')
  expect(store.jobFor(7).jobId).toBeNull()
})

it('does not resubmit a refused retry when model setup requires reopening', async () => {
  window.karaokeDesktop = { isDesktop: true,
    prepareHeart: vi.fn().mockResolvedValue({ installed: true, restartRequired: true }) }
  api.retryIngest.mockRejectedValueOnce(Object.assign(new Error('Set up Heart'), { code: 'heart_model_missing' }))
  const store = useSongsStore()
  await store.startRetryIngest(7)
  expect(api.retryIngest).toHaveBeenCalledTimes(1)
  expect(store.jobFor(7).message).toContain('Reopen the app')
})

it('does not ask for Heart when the server admits a prepared-video retry', async () => {
  const setup = vi.fn()
  window.karaokeDesktop = { isDesktop: true, prepareHeart: setup }
  api.retryIngest.mockResolvedValueOnce({ data: { job_id: 'video-retry' } })
  const store = useSongsStore()
  store.startRetryIngest(7)
  await settle()
  expect(setup).not.toHaveBeenCalled()
  expect(store.jobFor(7).status).toBe('done')
})

describe('runSongJob', () => {
  it('records the job under the song it was started for', async () => {
    const store = useSongsStore()
    api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'aligning', progress: 40 } })

    store.startRealign(7, { reference_mode: 'none' })
    await settle()

    expect(store.jobFor(7)).toMatchObject({
      kind: 'realign', jobId: 'j-realign', status: 'running', phase: 'aligning', progress: 40,
    })
    expect(store.isJobRunning(7)).toBe(true)
    // The song next to it in the library knows nothing about this.
    expect(store.jobFor(8)).toBeNull()
    expect(store.isJobRunning(8)).toBe(false)
  })

  it('keeps two songs’ jobs apart, including when they finish out of order', async () => {
    const store = useSongsStore()
    // Song 7's job never finishes; song 8's does.
    api.pollJob.mockImplementation(jobId => Promise.resolve({
      data: jobId === 'j-realign'
        ? { status: 'running', phase: 'aligning', progress: 10 }
        : { status: 'done', message: 'Listened again' },
    }))

    store.startRealign(7, {})
    store.startTranscribe(8, {})
    await settle()

    expect(store.jobFor(7).kind).toBe('realign')
    expect(store.jobFor(7).status).toBe('running')
    expect(store.jobFor(8).kind).toBe('transcribe')
    expect(store.jobFor(8).status).toBe('done')
  })

  it('records a failed job with the server’s own message', async () => {
    const store = useSongsStore()
    api.pollJob.mockResolvedValue({
      data: { status: 'failed', message: 'No transcription cache for heart' },
    })

    store.startRealign(7, {})
    await settle()

    expect(store.jobFor(7).status).toBe('failed')
    expect(store.jobFor(7).error).toBe('No transcription cache for heart')
    expect(store.isJobRunning(7)).toBe(false)
  })

  it('records a refused REQUEST rather than throwing it at the caller', async () => {
    // The 409s these routes answer with carry the whole remedy in their
    // detail. Swallowed, they become a button that does nothing.
    const store = useSongsStore()
    setsApi.realign.mockRejectedValue(new Error('No cached transcription for this song'))

    await store.startRealign(7, {})

    expect(store.jobFor(7)).toMatchObject({
      status: 'failed', error: 'No cached transcription for this song',
    })
  })

  it('refuses to start a second job for a song that already has one', async () => {
    const store = useSongsStore()
    api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'aligning' } })

    store.startRealign(7, {})
    await settle()
    store.startTranscribe(7, {})
    await settle()

    expect(setsApi.transcribe).not.toHaveBeenCalled()
    expect(store.jobFor(7).kind).toBe('realign')
  })

  it('survives a blip on one poll instead of calling the job failed', async () => {
    const store = useSongsStore()
    let calls = 0
    api.pollJob.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('Network Error'))
      return Promise.resolve({ data: { status: 'done', message: 'Finished' } })
    })

    store.startRealign(7, {})
    await settle()

    expect(store.jobFor(7).status).toBe('done')
  })

  it('clears one song’s record without touching another’s', async () => {
    const store = useSongsStore()
    store.startRealign(7, {})
    store.startTranscribe(8, {})
    await settle()

    store.clearJob(7)

    expect(store.jobFor(7)).toBeNull()
    expect(store.jobFor(8)).not.toBeNull()
  })
})

describe('startResplit', () => {
  it('sends the model and tracks the job as a re-split', async () => {
    const store = useSongsStore()
    api.pollJob.mockResolvedValue({ data: { status: 'running' } })

    store.startResplit(3, { karaoke_model: 'mdxnet_kara2' })
    await settle()

    expect(api.resplit).toHaveBeenCalledWith(3, { karaoke_model: 'mdxnet_kara2' })
    expect(store.jobFor(3).kind).toBe('resplit')
  })
})

describe('startRetryIngest', () => {
  it('queues the retry and keeps the envelope the server answered with', async () => {
    const store = useSongsStore()
    api.retryIngest.mockResolvedValue({
      data: { job_id: 'j-retry', song_id: 5, options_recovered: false, message: 'Retry queued' },
    })
    api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'separating' } })

    store.startRetryIngest(5)
    await settle()

    expect(api.retryIngest).toHaveBeenCalledWith(5)
    expect(store.jobFor(5)).toMatchObject({ kind: 'retry', jobId: 'j-retry' })
    // `options_recovered: false` is the difference between a faithful re-run
    // and one on server defaults, so it has to survive to the UI.
    expect(store.jobFor(5).envelope.options_recovered).toBe(false)
  })

  it('re-reads the library as soon as the retry is accepted', async () => {
    // By the time the 202 comes back the server has already moved the row to
    // `processing`. Nothing else would notice: the list poll only runs while
    // something in it is processing, and the job's own onDone is an ingest
    // away — so the row would sit `failed` for the whole retried run, with
    // Details offering a retry the server now refuses and Lyrics still saying
    // to retry the ingest first.
    const store = useSongsStore()
    store.songs = [{ id: 5, status: 'failed', error_message: 'boom' }]
    api.retryIngest.mockResolvedValue({
      data: { job_id: 'j-retry', song_id: 5, options_recovered: true, message: 'queued' },
    })
    api.list.mockResolvedValue({
      data: { songs: [{ id: 5, status: 'processing', phase: 'separating' }], total: 1 },
    })
    api.pollJob.mockResolvedValue({ data: { status: 'running', phase: 'separating' } })

    store.startRetryIngest(5)
    await settle()

    expect(api.list).toHaveBeenCalled()
    expect(store.songs[0].status).toBe('processing')
    // And it is the ACCEPTANCE that refreshed, not the completion hook: the
    // ingest is still running.
    expect(store.jobFor(5).status).toBe('running')
  })

  it('surfaces the 409 detail when the song has not failed', async () => {
    const store = useSongsStore()
    api.retryIngest.mockRejectedValue(
      new Error('Song 5 has not failed (status: ready) — only a failed ingest can be retried.')
    )

    await store.startRetryIngest(5)

    expect(store.jobFor(5).status).toBe('failed')
    expect(store.jobFor(5).error).toMatch(/only a failed ingest can be retried/)
  })
})

describe('updateSongMeta', () => {
  it('patches the song and folds the answer into the library row', async () => {
    const store = useSongsStore()
    store.songs = [{ id: 4, artist: 'Unknown', title: 'Track 04', status: 'ready' }]
    api.updateSong.mockResolvedValue({ data: { id: 4, artist: 'Bowie', title: 'Heroes' } })

    await store.updateSongMeta(4, { artist: 'Bowie', title: 'Heroes' })

    expect(api.updateSong).toHaveBeenCalledWith(4, { artist: 'Bowie', title: 'Heroes' })
    expect(store.songs[0]).toMatchObject({ id: 4, artist: 'Bowie', title: 'Heroes', status: 'ready' })
  })

  it('lets the refusal through to the form that can show it', async () => {
    const store = useSongsStore()
    api.updateSong.mockRejectedValue(new Error('Song 4 not found'))

    await expect(store.updateSongMeta(4, { title: 'x' })).rejects.toThrow('not found')
  })
})
