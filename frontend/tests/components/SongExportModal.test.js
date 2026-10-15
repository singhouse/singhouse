// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract for the single-song export dialog: format and audio are chosen
// from option cards (Video is the default), the
// attribution card is always requested and never a dialog setting, the
// browser build saves the server-named file through an anchor, the desktop
// build writes into a folder chosen through the host's picker, and "Save as
// defaults" remembers the choices. A video export shows its progress with a
// Cancel, and hands the finished file to the same destinations.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const getSettings = vi.fn()
const setSettings = vi.fn()
const exportSong = vi.fn()
const openVideo = vi.fn()
const finishVideo = vi.fn()
const videoStatus = vi.fn()
const videoFile = vi.fn()
const cancelVideo = vi.fn()
const putVideoFrames = vi.fn()
const getSong = vi.fn()
const renderVideo = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  exportApi: {
    getSettings: (...a) => getSettings(...a),
    setSettings: (...a) => setSettings(...a),
    exportSong: (...a) => exportSong(...a),
    openVideo: (...a) => openVideo(...a),
    finishVideo: (...a) => finishVideo(...a),
    videoStatus: (...a) => videoStatus(...a),
    videoFile: (...a) => videoFile(...a),
    cancelVideo: (...a) => cancelVideo(...a),
    putVideoFrames: (...a) => putVideoFrames(...a),
  },
  songApi: {
    get: (...a) => getSong(...a),
  },
}))

vi.mock('@/export/videoRender.js', () => ({
  renderVideo: (...a) => renderVideo(...a),
}))

import SongExportModal from '@/components/SongExportModal.vue'
import { useHostSettings } from '@/stores/hostSettings'

const SONG = { id: 7, title: 'Zither Blues', artist: 'Ackerman', status: 'ready' }
const DEFAULTS_KEY = 'karaoke:exportDefaults'

let wrapper = null
let savedAnchor = null
let origCreateObjectURL
let origRevokeObjectURL

function bodyEl(selector) {
  return document.body.querySelector(selector)
}

function radio(value) {
  return document.body.querySelector(`input[value="${value}"]`)
}

function optionText(value) {
  return radio(value).closest('label').textContent.replace(/\s+/g, ' ').trim()
}

async function choose(value) {
  const el = radio(value)
  el.checked = true
  el.dispatchEvent(new Event('change'))
  await flushPromises()
}

function buttons() {
  return [...document.body.querySelectorAll('.modal__footer button')]
}

function button(label) {
  return [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === label)
}

function confirmBtn() {
  return button('Export')
}

function defaultsBox() {
  return bodyEl('.modal__footer input[type="checkbox"]')
}

async function check(box) {
  box.checked = true
  box.dispatchEvent(new Event('change'))
  await flushPromises()
}

async function openModal(song = SONG) {
  const w = mount(SongExportModal, { props: { song: null }, attachTo: document.body })
  await w.setProps({ song })
  await flushPromises()
  return w
}

function okExport(name = 'Ackerman - Zither Blues.zip', data = new Blob(['zip-bytes'])) {
  exportSong.mockResolvedValue({
    data,
    headers: { 'content-disposition': `attachment; filename="${name}"` },
  })
}

beforeEach(() => {
  getSettings.mockReset()
  setSettings.mockReset()
  exportSong.mockReset()
  for (const fn of [openVideo, finishVideo, videoStatus, videoFile, cancelVideo, putVideoFrames, getSong, renderVideo]) {
    fn.mockReset()
  }
  cancelVideo.mockResolvedValue({})
  localStorage.clear()
  setActivePinia(createPinia())
  delete window.karaokeDesktop

  savedAnchor = null
  origCreateObjectURL = URL.createObjectURL
  origRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:fake-export')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    savedAnchor = this
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  URL.createObjectURL = origCreateObjectURL
  URL.revokeObjectURL = origRevokeObjectURL
  vi.restoreAllMocks()
  delete window.karaokeDesktop
  localStorage.clear()
  document.body.innerHTML = ''
})

describe('layout', () => {
  it('titles the dialog Export and shows the song', async () => {
    wrapper = await openModal()
    expect(bodyEl('.modal__header h3').textContent).toBe('Export')
    expect(bodyEl('.export-form__song').textContent).toBe('Zither Blues')
  })

  it('offers exactly two format cards with their sub-headings, Video first and default', async () => {
    wrapper = await openModal()
    const formats = [...document.body.querySelectorAll('input[name="export-format"]')]
    expect(formats.map(i => i.value)).toEqual(['video', 'mp3g'])
    expect(optionText('video')).toBe('Video720p MP4')
    expect(optionText('mp3g')).toBe('MP3+G (.zip)For traditional karaoke software')
    expect(radio('video').checked).toBe(true)
    expect(radio('cdg')).toBeNull()
  })

  it('offers two audio cards with their sub-headings', async () => {
    wrapper = await openModal()
    const audio = [...document.body.querySelectorAll('input[name="export-audio"]')]
    expect(audio.map(i => i.value)).toEqual(['karaoke', 'instrumental'])
    expect(optionText('karaoke')).toBe('Karaoke mixInstrumental and backing vocals')
    expect(optionText('instrumental')).toBe('InstrumentalInstrumental only')
    expect(radio('karaoke').checked).toBe(true)
  })

  it('has Save as defaults, Cancel and Export, and no attribution control or summary', async () => {
    wrapper = await openModal()
    expect(defaultsBox().closest('label').textContent.trim()).toBe('Save as defaults')
    expect(buttons().map(b => b.textContent.trim())).toEqual(['Cancel', 'Export'])
    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    expect(bodyEl('.modal-card').textContent).not.toMatch(/attribution|card/i)
  })

  it('never reads or writes the server-side export settings', async () => {
    wrapper = await openModal()
    await choose('mp3g')
    okExport()
    confirmBtn().click()
    await flushPromises()
    expect(getSettings).not.toHaveBeenCalled()
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('Cancel closes the dialog', async () => {
    wrapper = await openModal()
    button('Cancel').click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})

const SESSION = 'AbCdEfGh_ij-KLmnOPqrstuvWXyz0123'
const DETAIL = {
  id: 7,
  word_sync: { lines: [[{ text: 'Lorem', start: 0.5, end: 1.0 }]] },
  stems: { karaoke: '/api/songs/7/stems/karaoke.flac', instrumental: '/api/songs/7/stems/instrumental.flac' },
}

function framesSession(frames = 90) {
  openVideo.mockResolvedValue({ data: { session: SESSION, mode: 'frames', duration: frames / 30, frames_expected: frames } })
  getSong.mockResolvedValue({ data: DETAIL })
  finishVideo.mockResolvedValue({ data: { ready: true, filename: 'Ackerman - Zither Blues.mp4', bytes: 10 } })
  videoFile.mockResolvedValue({
    data: new Blob(['mp4-bytes']),
    headers: { 'content-disposition': 'attachment; filename="Ackerman - Zither Blues.mp4"' },
  })
}

// A renderer that runs until released, and behaves like the real one on
// abort: it cancels the session and rejects with an AbortError.
function heldRenderer() {
  const held = {}
  renderVideo.mockImplementation(options => new Promise((resolve, reject) => {
    held.options = options
    held.finish = resolve
    options.signal.addEventListener('abort', async () => {
      await options.api.cancel(options.session)
      reject(new DOMException('Export cancelled', 'AbortError'))
    })
  }))
  return held
}

function progressLine() {
  return bodyEl('.export-progress__line')?.textContent.trim()
}

describe('video format', () => {
  it('enables Export with Video selected and no unavailable note', async () => {
    wrapper = await openModal()
    expect(radio('video').checked).toBe(true)
    expect(confirmBtn().disabled).toBe(false)
    expect(confirmBtn().hasAttribute('title')).toBe(false)
  })

  it('renders the song with the chosen audio, backdrop and stage model, showing progress and Cancel', async () => {
    framesSession(90)
    const held = heldRenderer()
    useHostSettings().backdrop = 'aurora'
    wrapper = await openModal()
    await choose('instrumental')
    confirmBtn().click()
    await flushPromises()

    expect(openVideo).toHaveBeenCalledWith(7, { audio: 'instrumental' })
    expect(getSong).toHaveBeenCalledWith(7)
    const options = held.options
    expect(options.session).toBe(SESSION)
    expect(options.frameCount).toBe(90)
    expect(options.backdrop).toBe('aurora')
    expect(options.audioUrl).toBe('/api/songs/7/stems/instrumental.flac')
    expect(options.model.pages.length).toBeGreaterThan(0)

    expect(bodyEl('.export-form')).toBeNull()
    expect(progressLine()).toBe('Rendering video… 0%')
    expect(buttons().map(b => b.textContent.trim())).toEqual(['Cancel'])
    expect(bodyEl('.modal__close')).toBeNull()

    options.onProgress(0.427)
    await flushPromises()
    expect(progressLine()).toBe('Rendering video… 43%')
    expect(bodyEl('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('43')
  })

  it('Cancel sends DELETE for the session and returns to the form without an error', async () => {
    framesSession()
    const held = heldRenderer()
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(held.options).toBeTruthy()

    button('Cancel').click()
    await flushPromises()
    expect(held.options.signal.aborted).toBe(true)
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(finishVideo).not.toHaveBeenCalled()
    expect(bodyEl('.export-progress')).toBeNull()
    expect(bodyEl('.export-form')).not.toBeNull()
    expect(bodyEl('.export-error')).toBeNull()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('Cancel while the video is being finished stops before anything is saved', async () => {
    framesSession()
    renderVideo.mockResolvedValue()
    let finished
    finishVideo.mockReturnValue(new Promise(resolve => { finished = resolve }))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(finishVideo).toHaveBeenCalledWith(SESSION)
    expect(progressLine()).toBe('Rendering video… 0%')

    button('Cancel').click()
    await flushPromises()
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    finished({ data: { ready: true, filename: 'x.mp4', bytes: 1 } })
    await flushPromises()

    expect(videoFile).not.toHaveBeenCalled()
    expect(savedAnchor).toBeNull()
    expect(bodyEl('.export-progress')).toBeNull()
    expect(bodyEl('.export-form')).not.toBeNull()
    expect(bodyEl('.export-error')).toBeNull()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('Escape cancels a running export', async () => {
    framesSession()
    const held = heldRenderer()
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(held.options.signal.aborted).toBe(true)
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(bodyEl('.export-form')).not.toBeNull()
  })

  it('in the browser, finishes, saves the server-named MP4 and removes the session', async () => {
    framesSession()
    const held = heldRenderer()
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    held.finish()
    await flushPromises()

    expect(finishVideo).toHaveBeenCalledWith(SESSION)
    expect(videoFile).toHaveBeenCalledWith(SESSION)
    expect(savedAnchor.getAttribute('download')).toBe('Ackerman - Zither Blues.mp4')
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('shows the server refusal when the session cannot open', async () => {
    openVideo.mockRejectedValue(Object.assign(new Error('No karaoke mix found for this song; try Instrumental'), { status: 409 }))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toBe('No karaoke mix found for this song; try Instrumental')
    expect(renderVideo).not.toHaveBeenCalled()
    expect(cancelVideo).not.toHaveBeenCalled()
  })

  it('removes the session when rendering fails', async () => {
    framesSession()
    renderVideo.mockRejectedValue(Object.assign(new Error('Expected frame 30, got 60'), { status: 409 }))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toBe('Expected frame 30, got 60')
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(finishVideo).not.toHaveBeenCalled()
  })

  it('a prepared video shows Preparing video… and waits for the session without rendering', async () => {
    openVideo.mockResolvedValue({ data: { session: SESSION, mode: 'remux', ready: false } })
    let ready
    videoStatus.mockReturnValue(new Promise(resolve => { ready = resolve }))
    videoFile.mockResolvedValue({ data: new Blob(['v']), headers: { 'content-disposition': 'attachment; filename="A - B.mp4"' } })
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()

    expect(progressLine()).toBe('Preparing video…')
    expect(document.body.textContent).not.toContain('Rendering video')
    expect(renderVideo).not.toHaveBeenCalled()
    expect(getSong).not.toHaveBeenCalled()
    ready({ data: { state: 'ready', received: 0, frames_expected: 0, filename: 'A - B.mp4' } })
    await flushPromises()
    expect(videoStatus).toHaveBeenCalledWith(SESSION)
    expect(finishVideo).not.toHaveBeenCalled()
    expect(savedAnchor.getAttribute('download')).toBe('A - B.mp4')
  })

  it('shows no progress line until the session has opened', async () => {
    let opened
    openVideo.mockReturnValue(new Promise(resolve => { opened = resolve }))
    videoStatus.mockReturnValue(new Promise(() => {}))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-progress')).toBeNull()
    opened({ data: { session: SESSION, mode: 'remux', ready: false } })
    await flushPromises()
    expect(progressLine()).toBe('Preparing video…')
  })

  it('cancelling a prepared video deletes its session', async () => {
    openVideo.mockResolvedValue({ data: { session: SESSION, mode: 'remux', ready: false } })
    videoStatus.mockResolvedValue({ data: { state: 'encoding', received: 0, frames_expected: 0 } })
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    button('Cancel').click()
    await flushPromises()
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(videoFile).not.toHaveBeenCalled()
    expect(bodyEl('.export-form')).not.toBeNull()
  })
})

describe('browser build', () => {
  it('shows where the browser saves files and no Browse button', async () => {
    wrapper = await openModal()
    expect(bodyEl('.export-path__input').value).toBe("Where your browser saves files")
    expect(button('Browse…')).toBeUndefined()
  })

  it('saves the MP3+G blob under the server-chosen filename with the card requested', async () => {
    const payload = new Blob(['zip-bytes'])
    okExport('Ackerman - Zither Blues.zip', payload)
    wrapper = await openModal()
    await choose('mp3g')

    confirmBtn().click()
    await flushPromises()

    expect(exportSong).toHaveBeenCalledWith(7, { format: 'mp3g', audio: 'karaoke', card: true })
    expect(URL.createObjectURL).toHaveBeenCalledWith(payload)
    expect(savedAnchor).not.toBeNull()
    expect(savedAnchor.getAttribute('href')).toBe('blob:fake-export')
    expect(savedAnchor.getAttribute('download')).toBe('Ackerman - Zither Blues.zip')
    // The object URL is revoked on a delay so the click's navigation can
    // finish; immediately after the save it must still be live.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('sends instrumental audio when chosen', async () => {
    okExport('x.zip')
    wrapper = await openModal()
    await choose('mp3g')
    await choose('instrumental')
    confirmBtn().click()
    await flushPromises()
    expect(exportSong).toHaveBeenCalledWith(7, { format: 'mp3g', audio: 'instrumental', card: true })
  })

  it('prefers the RFC 5987 encoded filename when present', async () => {
    exportSong.mockResolvedValue({
      data: new Blob(['zip-bytes']),
      headers: {
        'content-disposition':
          `attachment; filename="fallback.zip"; filename*=UTF-8''S%C3%B8ng%20One.zip`,
      },
    })
    wrapper = await openModal()
    await choose('mp3g')
    confirmBtn().click()
    await flushPromises()
    expect(savedAnchor.getAttribute('download')).toBe('Søng One.zip')
  })

  it('falls back to an id-based name when the header is missing', async () => {
    exportSong.mockResolvedValue({ data: new Blob(['zip-bytes']), headers: {} })
    wrapper = await openModal()
    await choose('mp3g')
    confirmBtn().click()
    await flushPromises()
    expect(savedAnchor.getAttribute('download')).toBe('export-song-7.zip')
  })

  it('remembers format and audio in this browser when Save as defaults is checked', async () => {
    okExport()
    wrapper = await openModal()
    await choose('mp3g')
    await choose('instrumental')
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(DEFAULTS_KEY))).toEqual({ format: 'mp3g', audio: 'instrumental' })

    wrapper.unmount()
    document.body.innerHTML = ''
    wrapper = await openModal()
    expect(radio('mp3g').checked).toBe(true)
    expect(radio('instrumental').checked).toBe(true)
  })

  it('leaves stored defaults alone when the export fails', async () => {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ format: 'mp3g', audio: 'karaoke' }))
    exportSong.mockRejectedValue(Object.assign(new Error('Song has no word sync'), { status: 409 }))
    wrapper = await openModal()
    await choose('instrumental')
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toContain('Song has no word sync')
    expect(JSON.parse(localStorage.getItem(DEFAULTS_KEY))).toEqual({ format: 'mp3g', audio: 'karaoke' })
  })

  it('leaves stored defaults alone when Save as defaults is unchecked', async () => {
    okExport()
    wrapper = await openModal()
    await choose('mp3g')
    confirmBtn().click()
    await flushPromises()
    expect(localStorage.getItem(DEFAULTS_KEY)).toBeNull()
  })
})

describe('desktop build', () => {
  let bridge

  beforeEach(() => {
    bridge = {
      isDesktop: true,
      getExportDefaults: vi.fn().mockResolvedValue({ folder: '/data/someone/Music/karaoke', label: '~/Music/karaoke', format: 'mp3g', audio: 'karaoke' }),
      chooseExportFolder: vi.fn().mockResolvedValue({ folder: '/data/someone/Desktop/gig', label: '~/Desktop/gig', format: 'mp3g', audio: 'karaoke' }),
      saveExportDefaults: vi.fn().mockResolvedValue({}),
      exportSong: vi.fn().mockResolvedValue({ path: '/data/someone/Music/karaoke/Ackerman - Zither Blues.zip' }),
    }
    window.karaokeDesktop = bridge
  })

  it('loads defaults from the host and shows the folder label with Browse', async () => {
    wrapper = await openModal()
    expect(bridge.getExportDefaults).toHaveBeenCalled()
    expect(radio('mp3g').checked).toBe(true)
    expect(bodyEl('.export-path__input').value).toBe('~/Music/karaoke')
    expect(bodyEl('.export-path__input').getAttribute('title')).toBe('/data/someone/Music/karaoke')
    expect(button('Browse…')).toBeTruthy()
  })

  it('Browse asks the host for a folder and shows the choice', async () => {
    wrapper = await openModal()
    button('Browse…').click()
    await flushPromises()
    expect(bridge.chooseExportFolder).toHaveBeenCalledWith()
    expect(bodyEl('.export-path__input').value).toBe('~/Desktop/gig')
    expect(bodyEl('.export-path__input').getAttribute('title')).toBe('/data/someone/Desktop/gig')
  })

  it('shows the full folder when the host sends no label', async () => {
    bridge.getExportDefaults.mockResolvedValue({ folder: '/srv/exports', format: 'mp3g', audio: 'karaoke' })
    wrapper = await openModal()
    expect(bodyEl('.export-path__input').value).toBe('/srv/exports')
  })

  it('writes through the host without a path or a browser save, then shows the saved path', async () => {
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()

    expect(bridge.exportSong).toHaveBeenCalledWith({ songId: 7, format: 'mp3g', audio: 'karaoke' })
    expect(exportSong).not.toHaveBeenCalled()
    expect(savedAnchor).toBeNull()
    expect(bodyEl('.export-form')).toBeNull()
    expect(bodyEl('.modal__body').textContent.trim()).toBe('/data/someone/Music/karaoke/Ackerman - Zither Blues.zip')
    expect(buttons().map(b => b.textContent.trim())).toEqual(['Done'])
    expect(wrapper.emitted('close')).toBeFalsy()

    button('Done').click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('persists format and audio through the host when Save as defaults is checked', async () => {
    wrapper = await openModal()
    await choose('instrumental')
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    expect(bridge.saveExportDefaults).toHaveBeenCalledWith({ format: 'mp3g', audio: 'instrumental' })
    expect(localStorage.getItem(DEFAULTS_KEY)).toBeNull()
  })

  it('does not persist defaults when the export fails', async () => {
    bridge.exportSong.mockRejectedValue(new Error(
      "Error invoking remote method 'export:write': Error: Song has no word sync"))
    wrapper = await openModal()
    await choose('instrumental')
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toBe('Song has no word sync')
    expect(bridge.saveExportDefaults).not.toHaveBeenCalled()
  })

  it('persists defaults only after the write finished', async () => {
    let finish
    bridge.exportSong.mockReturnValue(new Promise(resolve => { finish = resolve }))
    wrapper = await openModal()
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    expect(bridge.saveExportDefaults).not.toHaveBeenCalled()
    finish({ path: '/data/someone/Music/karaoke/x.zip' })
    await flushPromises()
    expect(bridge.saveExportDefaults).toHaveBeenCalledWith({ format: 'mp3g', audio: 'karaoke' })
  })

  it('does not persist when Save as defaults is unchecked', async () => {
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bridge.saveExportDefaults).not.toHaveBeenCalled()
  })

  it('writes a finished video through the host channel and shows the saved path', async () => {
    bridge.getExportDefaults.mockResolvedValue({ folder: '/x/exports', format: 'video', audio: 'karaoke' })
    bridge.writeVideoExport = vi.fn().mockResolvedValue({ path: '/x/exports/Ackerman - Zither Blues.mp4' })
    framesSession()
    const held = heldRenderer()
    wrapper = await openModal()
    expect(radio('video').checked).toBe(true)
    await check(defaultsBox())
    confirmBtn().click()
    await flushPromises()
    held.finish()
    await flushPromises()

    expect(finishVideo).toHaveBeenCalledWith(SESSION)
    expect(bridge.writeVideoExport).toHaveBeenCalledWith({ session: SESSION })
    expect(bridge.exportSong).not.toHaveBeenCalled()
    expect(videoFile).not.toHaveBeenCalled()
    expect(savedAnchor).toBeNull()
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(bridge.saveExportDefaults).toHaveBeenCalledWith({ format: 'video', audio: 'karaoke' })
    expect(bodyEl('.modal__body').textContent.trim()).toBe('/x/exports/Ackerman - Zither Blues.mp4')
    expect(buttons().map(b => b.textContent.trim())).toEqual(['Done'])
  })

  it('Cancel while the video is being finished does not write through the host', async () => {
    bridge.getExportDefaults.mockResolvedValue({ folder: '/x/exports', format: 'video', audio: 'karaoke' })
    bridge.writeVideoExport = vi.fn()
    framesSession()
    renderVideo.mockResolvedValue()
    let finished
    finishVideo.mockReturnValue(new Promise(resolve => { finished = resolve }))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    button('Cancel').click()
    await flushPromises()
    finished({ data: { ready: true, filename: 'x.mp4', bytes: 1 } })
    await flushPromises()

    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
    expect(bridge.writeVideoExport).not.toHaveBeenCalled()
    expect(bodyEl('.export-form')).not.toBeNull()
    expect(bodyEl('.modal__body').textContent).not.toContain('x.mp4')
  })

  it('shows the host error when the video write fails', async () => {
    bridge.getExportDefaults.mockResolvedValue({ folder: '/x/exports', format: 'video', audio: 'karaoke' })
    bridge.writeVideoExport = vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'export:write-video': Error: Could not create the export folder: denied"))
    framesSession()
    renderVideo.mockResolvedValue()
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toBe('Could not create the export folder: denied')
    expect(cancelVideo).toHaveBeenCalledWith(SESSION)
  })

  it('shows the host error without the IPC prefix and keeps the form', async () => {
    bridge.exportSong.mockRejectedValue(new Error(
      "Error invoking remote method 'export:write': Error: Song has no word sync"))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()
    expect(bodyEl('.export-error').textContent).toBe('Song has no word sync')
    expect(bodyEl('.export-form')).not.toBeNull()
  })
})

describe('errors', () => {
  async function failWith(error) {
    exportSong.mockRejectedValue(error)
    wrapper = await openModal()
    await choose('mp3g')
    confirmBtn().click()
    await flushPromises()
  }

  it('renders the JSON detail from a Blob error body', async () => {
    await failWith({
      response: {
        status: 409,
        data: new Blob([JSON.stringify({ detail: 'Song has no word sync' })],
          { type: 'application/json' }),
      },
    })
    expect(bodyEl('.export-error').textContent).toContain('Song has no word sync')
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('renders the server detail from an already-normalised error', async () => {
    await failWith(Object.assign(new Error('Export capability is not installed on this server'), { status: 501 }))
    expect(bodyEl('.export-error').textContent)
      .toContain('Export capability is not installed on this server')
  })

  it('labels a transport failure generically', async () => {
    await failWith(new Error('timeout of 300000ms exceeded'))
    expect(bodyEl('.export-error').textContent).toContain('Export failed')
    expect(bodyEl('.export-error').textContent).toContain('timeout of 300000ms exceeded')
  })
})

describe('vocabulary', () => {
  it('keeps the word out of the dialog', async () => {
    wrapper = await openModal()
    const card = bodyEl('.modal-card')
    const text = card.textContent.replace("Where your browser saves files", '')
    expect(text).toContain('Export')
    expect(text).not.toMatch(/download/i)
    expect(card.innerHTML.replaceAll("Where your browser saves files", '')).not.toMatch(/download/i)
  })

  it('keeps the word out of both component sources, except the anchor property', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const file of [
      resolve(here, '../../src/components/SongExportModal.vue'),
      resolve(here, '../../src/components/SongList.vue'),
    ]) {
      const source = readFileSync(file, 'utf8')
        .replaceAll('a.download = ', '')
        .replaceAll("Where your browser saves files", '')
      expect(source).not.toMatch(/download/i)
    }
  })
})
