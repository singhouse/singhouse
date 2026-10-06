// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract for the single-song export dialog: format and audio are chosen
// from option cards (Video is the default but not yet exportable), the
// attribution card is always requested and never a dialog setting, the
// browser build saves the server-named file through an anchor, the desktop
// build writes into a folder chosen through the host's picker, and "Save as
// defaults" remembers the choices.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const getSettings = vi.fn()
const setSettings = vi.fn()
const exportSong = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  exportApi: {
    getSettings: (...a) => getSettings(...a),
    setSettings: (...a) => setSettings(...a),
    exportSong: (...a) => exportSong(...a),
  },
}))

import SongExportModal from '@/components/SongExportModal.vue'

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
  localStorage.clear()
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

describe('video format', () => {
  it('disables Export while Video is selected and explains why', async () => {
    wrapper = await openModal()
    expect(confirmBtn().disabled).toBe(true)
    expect(confirmBtn().getAttribute('title')).toBe('Video export is not available yet')

    await choose('mp3g')
    expect(confirmBtn().disabled).toBe(false)
    expect(confirmBtn().hasAttribute('title')).toBe(false)

    await choose('video')
    expect(confirmBtn().disabled).toBe(true)
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

  it('opens on Video with Export disabled when that is the stored default', async () => {
    bridge.getExportDefaults.mockResolvedValue({ folder: '/x/karaoke', format: 'video', audio: 'karaoke' })
    wrapper = await openModal()
    expect(radio('video').checked).toBe(true)
    expect(confirmBtn().disabled).toBe(true)
    expect(bridge.exportSong).not.toHaveBeenCalled()
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
