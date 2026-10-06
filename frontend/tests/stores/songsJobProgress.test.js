// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// When a processing song's ingest last moved. Only a change in phase, message
// or percent counts; an identical poll must leave the time alone, or a dead
// stage would look freshly alive every 3 seconds.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: api,
  lyricsSetsApi: {},
}))

import { useSongsStore } from '@/stores/songs'

function serve(songs) {
  api.list.mockResolvedValue({ data: { songs, total: songs.length } })
}

const busy = (patch = {}) => ({
  id: 5, title: 'Busy', artist: 'A', status: 'processing',
  phase: 'separating', progress: 40, message: 'Working', created_at: '2026-08-01T00:00:00',
  ...patch,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
})

afterEach(() => { vi.useRealTimers() })

it('records the time a processing song is first seen', async () => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()
  expect(store.jobLastChangeAt(5)).toBe(Date.parse('2026-09-01T12:00:00Z'))
})

it('keeps the time across an identical poll', async () => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()
  const first = store.jobLastChangeAt(5)

  vi.setSystemTime(new Date('2026-09-01T12:05:00Z'))
  await store.fetchSongs()
  expect(store.jobLastChangeAt(5)).toBe(first)

  // The background poll goes through the same path.
  await vi.advanceTimersByTimeAsync(3000)
  expect(api.list).toHaveBeenCalledTimes(3)
  expect(store.jobLastChangeAt(5)).toBe(first)
})

it.each([
  ['percent', { progress: 41 }],
  ['message', { message: 'Still working' }],
  ['stage', { phase: 'transcribing' }],
])('moves the time when the %s changes', async (_, patch) => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()

  vi.setSystemTime(new Date('2026-09-01T12:05:00Z'))
  serve([busy(patch)])
  await store.fetchSongs()
  expect(store.jobLastChangeAt(5)).toBe(Date.parse('2026-09-01T12:05:00Z'))
})

it('forgets a song once it is no longer processing', async () => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()
  serve([busy({ status: 'ready', phase: null, progress: null, message: null })])
  await store.fetchSongs()
  expect(store.jobLastChangeAt(5)).toBeNull()
})

it('forgets a song an unfiltered walk no longer returns', async () => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()
  serve([])
  await store.fetchSongs()
  expect(store.jobLastChangeAt(5)).toBeNull()
})

it('keeps a song a searched walk merely hides', async () => {
  serve([busy()])
  const store = useSongsStore()
  await store.fetchSongs()
  const first = store.jobLastChangeAt(5)

  serve([])
  await store.fetchSongs({ search: 'nothing matches' })
  expect(store.jobLastChangeAt(5)).toBe(first)

  vi.setSystemTime(new Date('2026-09-01T12:05:00Z'))
  serve([busy()])
  await store.fetchSongs({ search: '' })
  expect(store.jobLastChangeAt(5)).toBe(first)
})
