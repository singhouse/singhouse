// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The panel shell: what it loads, what it shows about the current job, and —
// the property the old modal did not have — that being re-pointed at another
// song shows the NEW song's everything.
//
// It deliberately owns no job state. The record lives on the songs store keyed
// by song id, so closing the panel orphans no polling and a job started here
// keeps running (and keeps reporting) with the panel shut.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  listSets: vi.fn(),
  cacheStatus: vi.fn(async () => ({ data: { exists: true, label: 'heart' } })),
  getSet: vi.fn(async () => ({ data: { plain_lyrics: 'a\nb\n' } })),
  activate: vi.fn(async () => ({ data: {} })),
  copy: vi.fn(async () => ({ data: {} })),
  remove: vi.fn(async () => ({ data: {} })),
  verify: vi.fn(async () => ({ data: {} })),
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    get: (...a) => api.getSong(...a),
    list: vi.fn(async () => ({ data: { songs: [], total: 0 } })),
    pollJob: vi.fn(async () => ({ data: { status: 'running' } })),
  },
  featuresApi: { get: vi.fn(async () => ({ data: {} })) },
  lyricsSetsApi: {
    list: (...a) => api.listSets(...a),
    get: (...a) => api.getSet(...a),
    cacheStatus: (...a) => api.cacheStatus(...a),
    activate: (...a) => api.activate(...a),
    verify: (...a) => api.verify(...a),
    copy: (...a) => api.copy(...a),
    remove: (...a) => api.remove(...a),
    realign: vi.fn(async () => ({ data: { job_id: 'j' } })),
    transcribe: vi.fn(async () => ({ data: { job_id: 'j' } })),
    page: vi.fn(async () => ({ data: { job_id: 'j' } })),
  },
}))

import SongToolsPanel from '@/components/SongToolsPanel.vue'
import { useSongsStore } from '@/stores/songs'

function detail(id, overrides = {}) {
  return {
    id,
    artist: `Artist ${id}`,
    title: `Title ${id}`,
    status: 'ready',
    created_at: '2026-08-01T10:00:00',
    stems: { instrumental: '/i.wav', vocals: [] },
    ...overrides,
  }
}

function set(overrides = {}) {
  return {
    id: 10,
    source: 'transcription',
    label: 'whisper heart',
    is_active: true,
    is_verified: false,
    has_word_sync: true,
    has_plain_lyrics: false,
    has_synced_lyrics: false,
    created_at: '2026-08-01T10:00:00',
    ...overrides,
  }
}

async function mountPanel(songId = 1) {
  const w = mount(SongToolsPanel, { props: { songId } })
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  api.getSong.mockImplementation(async id => ({ data: detail(id) }))
  api.listSets.mockResolvedValue({ data: [set()] })
  api.cacheStatus.mockResolvedValue({ data: { exists: true, label: 'heart' } })
})

describe('SongToolsPanel', () => {
  it('loads the song and its versions when it opens', async () => {
    const w = await mountPanel(1)
    expect(api.getSong).toHaveBeenCalledWith(1)
    expect(api.listSets).toHaveBeenCalledWith(1)
    expect(w.text()).toContain('Title 1')
    expect(w.text()).toContain('Artist 1')
  })

  it('shows the three tabs and switches between them', async () => {
    const w = await mountPanel(1)
    const tabs = w.findAll('.tools__tab')
    expect(tabs.map(t => t.text())).toEqual(['Lyrics', 'Stems', 'Details'])

    await tabs[1].trigger('click')
    expect(w.vm.tab).toBe('stems')
  })

  it('re-loads everything when it is re-pointed at another song', async () => {
    const w = await mountPanel(1)
    api.getSong.mockImplementation(async id => ({ data: detail(id) }))
    api.listSets.mockResolvedValue({ data: [set({ id: 99, source: 'manual' })] })

    await w.setProps({ songId: 2 })
    await flushPromises()

    expect(api.getSong).toHaveBeenLastCalledWith(2)
    expect(w.text()).toContain('Title 2')
    expect(w.vm.sets[0].id).toBe(99)
  })

  it('shows the job belonging to ITS song, and never another song’s', async () => {
    const store = useSongsStore()
    store.activeJobs = {
      1: { kind: 'transcribe', status: 'running', phase: 'transcribing', progress: 20 },
      2: { kind: 'resplit', status: 'failed', error: 'boom' },
    }
    const w = await mountPanel(1)

    expect(w.find('.tools__job').text()).toContain('Listen again')
    expect(w.find('.tools__job').text()).toContain('transcribing')
    expect(w.find('.tools__job').text()).not.toContain('boom')
  })

  it('renders a failed job with the server’s detail', async () => {
    const store = useSongsStore()
    store.activeJobs = { 1: { kind: 'retry', status: 'failed', error: 'the source audio is gone' } }
    const w = await mountPanel(1)

    expect(w.find('.tools__job').classes()).toContain('tools__job--error')
    expect(w.find('.tools__job').text()).toContain('the source audio is gone')
  })

  it('re-reads the song when a job it was watching finishes', async () => {
    const store = useSongsStore()
    store.activeJobs = { 1: { kind: 'realign', status: 'running' } }
    const w = await mountPanel(1)
    api.getSong.mockClear()
    api.listSets.mockClear()

    store.activeJobs = { 1: { kind: 'realign', status: 'done', message: 'Finished' } }
    await flushPromises()

    expect(api.getSong).toHaveBeenCalledWith(1)
    expect(api.listSets).toHaveBeenCalledWith(1)
    expect(w.exists()).toBe(true)
  })

  it('says so, rather than rendering an empty shell, when the song cannot be read', async () => {
    api.getSong.mockRejectedValue(new Error('Song 1 not found'))
    const w = await mountPanel(1)
    expect(w.find('.tools__error').text()).toContain('Song 1 not found')
  })
})

describe('the versions list', () => {
  it('carries the same actions everywhere, one menu per set', async () => {
    api.listSets.mockResolvedValue({
      data: [set({ id: 10, is_active: true }), set({ id: 11, is_active: false, source: 'manual' })],
    })
    const w = await mountPanel(1)

    const menus = w.findAll('.vset__menu')
    expect(menus).toHaveLength(2)
    // The active set offers no Activate; the other one does.
    expect(menus[0].text()).not.toContain('Activate')
    expect(menus[1].text()).toContain('Activate')
    for (const menu of menus) {
      expect(menu.text()).toContain('Verify')
      expect(menu.text()).toContain('Duplicate')
      expect(menu.text()).toContain('Edit timing')
      expect(menu.text()).toContain('Delete')
      expect(menu.text()).toContain('Re-page')
    }
  })

  it('shows provenance derived from the payload, not from the label alone', async () => {
    api.listSets.mockResolvedValue({
      data: [
        set({ id: 10, has_plain_lyrics: true, label: 'realigned to paste' }),
        set({ id: 11, is_active: false, has_plain_lyrics: false, has_synced_lyrics: false }),
      ],
    })
    const w = await mountPanel(1)
    const rows = w.findAll('.vset')

    expect(rows[0].text()).toContain('anchored')
    expect(rows[0].text()).toContain('realigned')
    expect(rows[1].text()).toContain('unanchored')
  })

  it('activates through the store, so the deck follows', async () => {
    api.listSets.mockResolvedValue({ data: [set({ id: 11, is_active: false })] })
    const w = await mountPanel(1)

    const activate = w.findAll('.vset__menu-pop button')
      .find(b => b.text() === 'Activate')
    await activate.trigger('click')
    await flushPromises()

    expect(api.activate).toHaveBeenCalledWith(1, 11)
  })
})
