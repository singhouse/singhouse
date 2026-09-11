// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Store wrappers for the re-page and re-split jobs. Both unwrap the
// 202 envelope the caller polls on, and neither swallows a failure: the
// refusals these routes answer with (no word timings, no LLM endpoint, a song
// that is not ready) are things the operator can act on, so they have to reach
// the component that can say so.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const page = vi.fn()
const resplit = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { resplit: (...a) => resplit(...a) },
  lyricsSetsApi: { page: (...a) => page(...a) },
}))

import { useSongsStore } from '@/stores/songs'

beforeEach(() => {
  setActivePinia(createPinia())
  page.mockReset()
  resplit.mockReset()
})

describe('pageLyricsSet', () => {
  it('returns the job envelope', async () => {
    page.mockResolvedValue({ data: { job_id: 'j1', song_id: 7, message: 'queued' } })
    const store = useSongsStore()

    const res = await store.pageLyricsSet(7, 42, { activate: true })

    expect(page).toHaveBeenCalledWith(7, 42, { activate: true })
    expect(res).toEqual({ job_id: 'j1', song_id: 7, message: 'queued' })
  })

  it('lets the refusal through', async () => {
    page.mockRejectedValue(new Error('No LLM endpoint is configured'))
    const store = useSongsStore()

    await expect(store.pageLyricsSet(7, 42)).rejects.toThrow('No LLM endpoint')
  })
})

describe('resplitStems', () => {
  it('returns the job envelope', async () => {
    resplit.mockResolvedValue({ data: { job_id: 'j2', song_id: 3, message: 'queued' } })
    const store = useSongsStore()

    const res = await store.resplitStems(3, { karaoke_model: 'mdxnet_kara2' })

    expect(resplit).toHaveBeenCalledWith(3, { karaoke_model: 'mdxnet_kara2' })
    expect(res.job_id).toBe('j2')
  })

  it('lets the refusal through', async () => {
    resplit.mockRejectedValue(new Error('Song 3 is not ready yet'))
    const store = useSongsStore()

    await expect(store.resplitStems(3, {})).rejects.toThrow('not ready')
  })
})
