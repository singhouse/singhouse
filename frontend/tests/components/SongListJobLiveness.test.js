// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A processing row whose stage has stopped reporting gets its age appended to
// the status line, so a slow stage can be told from a dead one. Fresh
// progress clears it; finished and failed rows never carry it.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  lyricsSetsApi: {},
  exportApi: { getSettings: vi.fn(), setSettings: vi.fn(), exportSong: vi.fn() },
}))

vi.mock('@/plugins/slots', () => ({
  getSlot: () => null,
  registerSlot: vi.fn(),
  slotHasContent: () => false,
}))

import SongList from '@/components/SongList.vue'
import { useSongsStore } from '@/stores/songs'

const busy = (patch = {}) => ({
  id: 2, title: 'Busy Song', artist: 'B', status: 'processing',
  phase: 'separating', progress: 40, created_at: '2026-08-02T00:00:00', ...patch,
})
const READY = { id: 1, title: 'Ready Song', artist: 'A', status: 'ready', created_at: '2026-08-03T00:00:00' }
const FAILED = { id: 3, title: 'Broken Song', artist: 'C', status: 'failed', created_at: '2026-08-01T00:00:00' }

function serve(songs) {
  listSongs.mockResolvedValue({ data: { songs, total: songs.length } })
}

let wrapper = null

async function mountWith(songs) {
  serve(songs)
  wrapper = mount(SongList)
  await useSongsStore().fetchSongs()
  await flushPromises()
}

async function advance(ms) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

const row = id => wrapper.find(`.song-item[data-song-id="${id}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

it('adds nothing while the stage has been quiet for under two minutes', async () => {
  await mountWith([busy()])
  await advance(90_000)
  expect(row(2).find('.song-item__sub').text()).not.toContain('last update')
  expect(row(2).find('.song-item__sub').text()).toContain('40%')
})

it('appends the age once the stage has been quiet for two minutes', async () => {
  await mountWith([busy()])
  await advance(120_000)
  const sub = row(2).find('.song-item__sub').text().replace(/\s+/g, ' ')
  expect(sub).toContain('40%')
  expect(sub).toContain('· last update 2 min ago')
})

it('clears the age when the stage reports progress again', async () => {
  await mountWith([busy()])
  await advance(150_000)
  expect(row(2).text()).toContain('last update 2 min ago')

  serve([busy({ progress: 41 })])
  await useSongsStore().fetchSongs()
  await flushPromises()
  expect(row(2).text()).not.toContain('last update')
})

it('never shows the age on finished or failed rows', async () => {
  await mountWith([READY, FAILED, busy()])
  await advance(300_000)
  expect(row(2).text()).toContain('last update 5 min ago')
  expect(row(1).text()).not.toContain('last update')
  expect(row(3).text()).not.toContain('last update')

  // The quiet song finishing takes the age with it.
  serve([READY, FAILED, busy({ status: 'ready', phase: null, progress: null })])
  await useSongsStore().fetchSongs()
  await flushPromises()
  expect(row(2).text()).not.toContain('last update')
})

it('carries the whole status line, age included, as its title', async () => {
  await mountWith([busy()])
  await advance(120_000)
  const sub = row(2).find('.song-item__sub')
  const visible = sub.text().replace(/\s+/g, ' ').trim()
  expect(visible).toContain('last update 2 min ago')
  expect(sub.attributes('title')).toBe(visible)
})
