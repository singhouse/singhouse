// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract for the Plex import dialog: it renders the libraries and tracks a
// mocked plexApi returns, the token field never shows a token (the server does
// not return one — only "a token is set"), an env-managed configuration
// disables the connection fields, and pressing Import posts exactly the
// selected rows and refreshes the library.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const getSettings = vi.fn()
const setSettings = vi.fn()
const test_ = vi.fn()
const listLibraries = vi.fn()
const listTracks = vi.fn()
const importTracks = vi.fn()
const featuresGet = vi.fn()
const fetchSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  featuresApi: { get: (...a) => featuresGet(...a) },
  plexApi: {
    getSettings: (...a) => getSettings(...a),
    setSettings: (...a) => setSettings(...a),
    test: (...a) => test_(...a),
    listLibraries: (...a) => listLibraries(...a),
    listTracks: (...a) => listTracks(...a),
    importTracks: (...a) => importTracks(...a),
  },
}))

vi.mock('@/stores/songs', () => ({
  useSongsStore: () => ({ fetchSongs: (...a) => fetchSongs(...a) }),
}))

import { h } from 'vue'
import PlexImportModal from '@/components/PlexImportModal.vue'
import Modal from '@/components/ui/Modal.vue'

const SETTINGS = {
  url: 'http://plex.lan:32400',
  token_set: true,
  source: 'settings',
  lyrics_enabled: false,
}

const LIBRARIES = { libraries: [{ key: '2', title: 'Music' }] }

const TRACKS = {
  tracks: [
    {
      rating_key: '5501', title: 'Zither Blues', artist: 'Ackerman',
      album: 'Long Player', part_key: '/library/parts/9001/1/file.flac',
      file_path: '/srv/music/Ackerman/01 Zither Blues.flac',
      container: 'flac', has_lyrics: true,
    },
    {
      rating_key: '5502', title: 'Second Take', artist: 'Ackerman',
      album: null, part_key: '/library/parts/9002/1/file.mp3',
      file_path: '/srv/music/Ackerman/02 Second Take.mp3',
      container: 'mp3', has_lyrics: false,
    },
  ],
  total: 2,
  offset: 0,
  limit: 100,
}

// The axios interceptor flattens a failed response into a bare Error with a
// status on it, so a fixture shaped like a raw axios error would test a shape
// production never produces.
function apiError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

// A full page — hasNextPage requires one, because a short page IS the end of
// the results whatever the total claims.
function fullPage(total = 4210, offset = 0) {
  const tracks = Array.from({ length: 100 }, (_, i) => ({
    ...TRACKS.tracks[0],
    rating_key: `${9000 + offset + i}`,
    title: `Track ${offset + i}`,
  }))
  return { data: { tracks, total, offset, limit: 100 } }
}

let wrapper = null

async function mountModal() {
  wrapper = mount(PlexImportModal)
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  delete window.karaokeDesktop
  setActivePinia(createPinia())
  for (const fn of [
    getSettings, setSettings, test_, listLibraries, listTracks, importTracks,
    featuresGet, fetchSongs,
  ]) fn.mockReset()

  getSettings.mockResolvedValue({ data: { ...SETTINGS } })
  listLibraries.mockResolvedValue({ data: LIBRARIES })
  listTracks.mockResolvedValue({ data: TRACKS })
  importTracks.mockResolvedValue({ data: { jobs: [{ job_id: 'j1', song_id: 1 }] } })
  featuresGet.mockResolvedValue({
    data: { plex_lyrics: { enabled: false, env: 'KARAOKE_PLEX_LYRICS' } },
  })
  fetchSongs.mockResolvedValue()
})

describe('PlexImportModal', () => {
  it('preserves selection and queues nothing after model setup requires reopening', async () => {
    window.karaokeDesktop = { isDesktop: true,
      prepareHeart: vi.fn().mockResolvedValue({ installed: true, restartRequired: true }) }
    await mountModal()
    await wrapper.findAll('.plex-track__check')[1].setValue(true)
    await wrapper.find('.plex-btn--primary').trigger('click')
    await flushPromises()
    expect(importTracks).not.toHaveBeenCalled()
    expect(wrapper.findAll('.plex-track__check')[1].element.checked).toBe(true)
    expect(wrapper.text()).toContain('Reopen the app')
  })

  it('does not import after the dialog closes while setup is pending', async () => {
    let complete
    window.karaokeDesktop = { isDesktop: true,
      prepareHeart: vi.fn(() => new Promise(resolve => { complete = resolve })) }
    await mountModal()
    await wrapper.findAll('.plex-track__check')[1].setValue(true)
    await wrapper.find('.plex-btn--primary').trigger('click')
    wrapper.unmount()
    complete({ installed: true, restartRequired: false })
    await flushPromises()
    expect(importTracks).not.toHaveBeenCalled()
  })

  it('renders the libraries and tracks the API returns', async () => {
    await mountModal()
    const options = wrapper.findAll('option').map(o => o.text())
    expect(options).toContain('Music')

    const rows = wrapper.findAll('.plex-track')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Zither Blues')
    expect(rows[0].text()).toContain('Ackerman')
    expect(rows[0].text()).toContain('Long Player')
    // The lyric badge marks the one track that has lyrics on the server.
    expect(rows[0].find('.plex-track__badge').exists()).toBe(true)
    expect(rows[1].find('.plex-track__badge').exists()).toBe(false)
  })

  it('never renders a token, only the fact that one is set', async () => {
    await mountModal()
    const token = wrapper.find('input[type="password"]')
    expect(token.element.value).toBe('')
    expect(token.attributes('placeholder')).toContain('Token set')
    expect(wrapper.html()).not.toContain('sekrit')
  })

  it('disables the connection fields when the environment owns them', async () => {
    getSettings.mockResolvedValue({ data: { ...SETTINGS, source: 'env' } })
    await mountModal()
    expect(wrapper.text()).toContain("Configured by the server's environment")
    expect(wrapper.find('input[type="text"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('input[type="password"]').attributes('disabled')).toBeDefined()
  })

  it('omits the token from a URL-only save so the stored one survives', async () => {
    setSettings.mockResolvedValue({ data: { ...SETTINGS } })
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[0].trigger('click')
    await flushPromises()
    expect(setSettings).toHaveBeenCalledWith({ url: 'http://other.lan:32400' })
  })

  it('Test saves unsaved fields first, then tests the stored connection', async () => {
    setSettings.mockResolvedValue({ data: { ...SETTINGS, url: 'http://other.lan:32400', token_set: true } })
    test_.mockResolvedValue({ data: { ok: true, libraries: [{ key: '1', title: 'Music' }] } })
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.find('input[type="password"]').setValue('tok')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(setSettings).toHaveBeenCalledWith({ url: 'http://other.lan:32400', token: 'tok' })
    expect(test_).toHaveBeenCalled()
    expect(setSettings.mock.invocationCallOrder[0]).toBeLessThan(test_.mock.invocationCallOrder[0])
    expect(wrapper.text()).toContain('Saved. Connected — 1 music library found.')
    expect(wrapper.find('input[type="password"]').element.value).toBe('')
  })

  it('Test does not save when nothing changed', async () => {
    test_.mockResolvedValue({ data: { ok: true, libraries: [] } })
    await mountModal()
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(setSettings).not.toHaveBeenCalled()
    expect(test_).toHaveBeenCalled()
  })

  it('imports exactly the selected tracks and refreshes the library', async () => {
    await mountModal()
    const boxes = wrapper.findAll('.plex-track__check')
    await boxes[1].setValue(true)
    await flushPromises()

    const importBtn = wrapper.find('.plex-btn--primary')
    expect(importBtn.text()).toBe('Import 1 track')

    await importBtn.trigger('click')
    await flushPromises()

    expect(importTracks).toHaveBeenCalledTimes(1)
    const body = importTracks.mock.calls[0][0]
    expect(body.tracks).toHaveLength(1)
    expect(body.tracks[0]).toMatchObject({
      rating_key: '5502',
      title: 'Second Take',
      part_key: '/library/parts/9002/1/file.mp3',
      has_lyrics: false,
    })
    expect(fetchSongs).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Queued 1 import')
  })

  it('selects every track on the page', async () => {
    await mountModal()
    const selectAll = wrapper.findAll('.plex-btn').find(b => b.text().includes('Select all'))
    await selectAll.trigger('click')
    await flushPromises()
    expect(wrapper.find('.plex-btn--primary').text()).toBe('Import 2 tracks')
  })

  it('warns only when a selected track has lyrics this install will not use', async () => {
    await mountModal()
    // Nothing selected yet — nothing to warn about.
    expect(wrapper.text()).not.toContain('not used as an alignment reference')

    await wrapper.findAll('.plex-track__check')[1].setValue(true)   // no lyrics
    await flushPromises()
    expect(wrapper.text()).not.toContain('not used as an alignment reference')

    await wrapper.findAll('.plex-track__check')[0].setValue(true)   // has lyrics
    await flushPromises()
    expect(wrapper.text()).toContain('not used as an alignment reference')
    expect(wrapper.text()).toContain('KARAOKE_PLEX_LYRICS')
  })

  it('shows the server-supplied message when a call fails', async () => {
    test_.mockRejectedValue(apiError('The media server rejected the token.', 401))
    await mountModal()
    const testBtn = wrapper.findAll('.plex-btn').find(b => b.text().includes('Test'))
    await testBtn.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('rejected the token')
  })

  it('asks the SERVER to filter, one param per field', async () => {
    await mountModal()
    listTracks.mockClear()

    await wrapper.find('input[aria-label="Filter by artist"]').setValue('ackerman')
    await new Promise(r => setTimeout(r, 300))   // the 250ms debounce
    await flushPromises()
    expect(listTracks).toHaveBeenLastCalledWith(
      '2', expect.objectContaining({ artist: 'ackerman' }),
    )
    expect(listTracks.mock.calls.at(-1)[1].title).toBeUndefined()

    await wrapper.find('input[aria-label="Filter by title"]').setValue('zither')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    // Both fields together: the server ANDs them.
    expect(listTracks).toHaveBeenLastCalledWith(
      '2', expect.objectContaining({ artist: 'ackerman', title: 'zither', offset: 0 }),
    )
  })

  it('keeps reading the window as a window, filtered or not', async () => {
    // The filter is the server's now, so `total` counts matches and the label
    // is true either way — the old "N matches on this page" reading described
    // a page-local filter that no longer exists.
    listTracks.mockResolvedValue({ data: { ...TRACKS, total: 4210 } })
    await mountModal()
    expect(wrapper.find('.plex-paging__label').text()).toBe('1–100 of 4210')

    listTracks.mockResolvedValue({
      data: { ...TRACKS, tracks: [TRACKS.tracks[0]], total: 1 },
    })
    await wrapper.find('input[aria-label="Filter by title"]').setValue('zither')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    expect(wrapper.find('.plex-paging__label').text()).toBe('1–1 of 1')
  })

  it('distinguishes an empty library from an empty filter result', async () => {
    listTracks.mockResolvedValue({ data: { ...TRACKS, tracks: [], total: 0 } })
    await mountModal()
    expect(wrapper.text()).toContain('No tracks to show.')

    await wrapper.find('input[aria-label="Filter by artist"]').setValue('nobody')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    expect(wrapper.text()).toContain('No tracks match.')
  })

  it('keeps a selection across a page change', async () => {
    listTracks.mockResolvedValue(fullPage(250))
    await mountModal()
    await wrapper.findAll('.plex-track__check')[0].setValue(true)
    await flushPromises()
    expect(wrapper.find('.plex-btn--primary').text()).toBe('Import 1 track')

    listTracks.mockResolvedValue(fullPage(250, 100))
    const next = wrapper.findAll('.plex-btn').find(b => b.text().includes('Next'))
    await next.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Track 100')
    // The pick was made on a row that is no longer on screen; it still counts.
    expect(wrapper.find('.plex-btn--primary').text()).toBe('Import 1 track')
  })

  it('offers a next page only when this one was full', async () => {
    // A short page is the end of the results even when `total` disagrees —
    // a filter can make that count stale between two requests.
    listTracks.mockResolvedValue({ data: { ...TRACKS, total: 4210 } })
    await mountModal()
    const next = () => wrapper.findAll('.plex-btn').find(b => b.text().includes('Next'))
    expect(next().attributes('disabled')).toBeDefined()

    listTracks.mockResolvedValue(fullPage(4210))
    await wrapper.find('input[aria-label="Filter by artist"]').setValue('a')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    expect(next().attributes('disabled')).toBeUndefined()
  })

  it('will not save an emptied URL just because Test was pressed', async () => {
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(setSettings).not.toHaveBeenCalled()
    expect(test_).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Enter a server URL first.')
  })

  it('does not write settings the environment owns', async () => {
    getSettings.mockResolvedValue({ data: { ...SETTINGS, source: 'env' } })
    test_.mockResolvedValue({ data: { ok: true, libraries: [] } })
    await mountModal()
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(setSettings).not.toHaveBeenCalled()
    expect(test_).toHaveBeenCalled()
  })

  it('does not test a connection whose save failed', async () => {
    setSettings.mockRejectedValue(apiError('That URL is not a valid server address.'))
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(test_).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('not a valid server address')
  })

  it('says the save landed even when the test after it did not', async () => {
    setSettings.mockResolvedValue({ data: { ...SETTINGS, url: 'http://other.lan:32400' } })
    test_.mockRejectedValue(apiError('Connection refused.', 502))
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    // Otherwise the operator retypes credentials that are already stored.
    expect(wrapper.text()).toContain('Saved, but')
    expect(wrapper.text()).toContain('Connection refused.')
  })

  it('waits for the save to land before testing, and locks Save while it does', async () => {
    let release = null
    setSettings.mockReturnValue(new Promise(resolve => { release = resolve }))
    test_.mockResolvedValue({ data: { ok: true, libraries: [] } })
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()

    expect(test_).not.toHaveBeenCalled()
    // Save writes the same two fields — it must read as busy for the whole
    // write, and only `saving` produces that label.
    expect(wrapper.findAll('.plex-btn')[0].text()).toBe('Saving…')

    release({ data: { ...SETTINGS, url: 'http://other.lan:32400' } })
    await flushPromises()
    expect(test_).toHaveBeenCalled()
  })

  it('drops a selection made against the previous server', async () => {
    listTracks.mockResolvedValue({ data: { ...TRACKS, total: 250 } })
    await mountModal()
    await wrapper.findAll('.plex-track__check')[0].setValue(true)
    await flushPromises()
    expect(wrapper.find('.plex-btn--primary').text()).toBe('Import 1 track')

    // Rating keys are per-server; a pick made on the old one means nothing here.
    setSettings.mockResolvedValue({ data: { ...SETTINGS, url: 'http://other.lan:32400' } })
    listLibraries.mockResolvedValue({ data: { libraries: [] } })
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('.plex-btn--primary').text()).toBe('Import 0 tracks')
    expect(wrapper.find('.plex-btn--primary').attributes('disabled')).toBeDefined()
  })

  it('settles the URL box on whatever the server stored', async () => {
    // The server normalizes (a trailing slash, for one). If the box kept the
    // typed form, every later Test would save again.
    setSettings.mockResolvedValue({ data: { ...SETTINGS, url: 'http://other.lan:32400' } })
    test_.mockResolvedValue({ data: { ok: true, libraries: [] } })
    await mountModal()
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400/')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('input[type="text"]').element.value).toBe('http://other.lan:32400')

    setSettings.mockClear()
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('says something when the opening library load fails', async () => {
    // The quiet mount-time load used to swallow this, leaving a configured
    // server looking like one with no music on it.
    listLibraries.mockRejectedValue(apiError('connect ECONNREFUSED 10.0.0.5:32400', 502))
    await mountModal()
    expect(wrapper.text()).toContain('Could not list libraries')
    expect(wrapper.text()).toContain('press Test connection')
    // The fixed line, not the server's own text, and no address in it.
    expect(wrapper.text()).not.toContain('ECONNREFUSED')
  })

  it('does not read a spaces-only token as "forget the stored one"', async () => {
    test_.mockResolvedValue({ data: { ok: true, libraries: [] } })
    await mountModal()
    await wrapper.find('input[type="password"]').setValue('   ')
    await wrapper.findAll('.plex-btn')[1].trigger('click')
    await flushPromises()
    // Nothing changed, so nothing is written — and certainly not a blank
    // token, which is the explicit delete.
    expect(setSettings).not.toHaveBeenCalled()
    expect(test_).toHaveBeenCalled()
  })

  it('sends a trimmed token when one was actually typed', async () => {
    setSettings.mockResolvedValue({ data: { ...SETTINGS } })
    await mountModal()
    await wrapper.find('input[type="password"]').setValue('  tok  ')
    await wrapper.findAll('.plex-btn')[0].trigger('click')
    await flushPromises()
    expect(setSettings).toHaveBeenCalledWith({
      url: 'http://plex.lan:32400', token: 'tok',
    })
  })

  it('ignores a stale response that lands after a newer one', async () => {
    await mountModal()
    let releaseOld = null
    listTracks.mockReturnValueOnce(new Promise(resolve => { releaseOld = resolve }))
    await wrapper.find('input[aria-label="Filter by artist"]').setValue('ac')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()

    listTracks.mockResolvedValue({
      data: { ...TRACKS, tracks: [{ ...TRACKS.tracks[0], title: 'Newer Row' }], total: 1 },
    })
    await wrapper.find('input[aria-label="Filter by artist"]').setValue('ackerman')
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    expect(wrapper.text()).toContain('Newer Row')

    // The first request finally answers. Its rows describe a filter the
    // operator has already moved on from, so they must not reach the screen.
    releaseOld({ data: { ...TRACKS, tracks: [{ ...TRACKS.tracks[1], title: 'Stale Row' }], total: 900 } })
    await flushPromises()
    expect(wrapper.text()).toContain('Newer Row')
    expect(wrapper.text()).not.toContain('Stale Row')
    expect(wrapper.find('.plex-paging__label').text()).toBe('1–1 of 1')
  })

  it('caps what it sends to what the API accepts', async () => {
    await mountModal()
    listTracks.mockClear()
    await wrapper.find('input[aria-label="Filter by title"]').setValue('x'.repeat(250))
    await new Promise(r => setTimeout(r, 300))
    await flushPromises()
    expect(listTracks.mock.calls.at(-1)[1].title).toHaveLength(200)
  })

  it('clears the filter boxes along with the rest on a retarget', async () => {
    setSettings.mockResolvedValue({ data: { ...SETTINGS, url: 'http://other.lan:32400' } })
    listLibraries.mockResolvedValue({ data: { libraries: [] } })
    await mountModal()
    await wrapper.find('input[aria-label="Filter by artist"]').setValue('ackerman')
    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('input[aria-label="Filter by artist"]').element.value).toBe('')
  })

  it('speaks Import, never the acquisition verb', async () => {
    await mountModal()
    expect(wrapper.text()).toContain('Import from your Plex library')
    expect(wrapper.text().toLowerCase()).not.toContain('down' + 'load')
  })
})

describe('inside the shared dialog', () => {
  it('is named by its heading and held open while settings save', async () => {
    let finish
    setSettings.mockReturnValue(new Promise((r) => { finish = r }))
    const onClose = vi.fn()
    wrapper = mount(Modal, {
      props: { visible: true, size: 'lg', onClose },
      slots: { default: () => h(PlexImportModal) },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    await flushPromises()
    const dialog = wrapper.find('dialog')
    expect(wrapper.find(`#${dialog.attributes('aria-labelledby')}`).text()).toBe('Import from your Plex library')

    await wrapper.find('input[type="text"]').setValue('http://other.lan:32400')
    await wrapper.findAll('.plex-btn')[0].trigger('click')
    await dialog.trigger('keydown', { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    finish({ data: { ...SETTINGS } })
    await flushPromises()
    await dialog.trigger('keydown', { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
