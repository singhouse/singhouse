// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract for the single-song CD+G / MP3+G export dialog: the attribution
// card preference round-trips through the server settings endpoint, the
// export call carries the chosen format and audio (and never a card flag),
// a finished export saves the server-named file through an anchor, and a
// failed one surfaces the server's JSON detail — even when that detail
// arrives wrapped in a Blob. The copy stays in Export/Save vocabulary.

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

function cardBox() {
  return document.body.querySelector('input[type="checkbox"]')
}

async function choose(value) {
  const el = radio(value)
  el.checked = true
  el.dispatchEvent(new Event('change'))
  await flushPromises()
}

function confirmBtn() {
  return document.body.querySelector('.modal__footer .ui-btn--primary')
}

async function openModal(song = SONG) {
  const w = mount(SongExportModal, { props: { song: null }, attachTo: document.body })
  await w.setProps({ song })
  await flushPromises()
  return w
}

beforeEach(() => {
  getSettings.mockReset()
  setSettings.mockReset()
  exportSong.mockReset()
  getSettings.mockResolvedValue({ data: { attribution_card: true } })
  setSettings.mockResolvedValue({ data: { attribution_card: true } })

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
  document.body.innerHTML = ''
})

describe('vocabulary', () => {
  it('speaks Export, never the banned verb, in everything it renders', async () => {
    wrapper = await openModal()
    const card = bodyEl('.modal-card')
    expect(card.textContent).toContain('Export')
    expect(card.textContent).not.toMatch(/download/i)
    expect(card.innerHTML).not.toMatch(/download/i)
  })

  it('keeps the banned verb out of both component sources, except the anchor property', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const file of [
      resolve(here, '../../src/components/SongExportModal.vue'),
      resolve(here, '../../src/components/SongList.vue'),
    ]) {
      const source = readFileSync(file, 'utf8').replaceAll('a.download = ', '')
      expect(source).not.toMatch(/download/i)
    }
  })
})

describe('attribution card setting', () => {
  it('loads the stored preference when the dialog opens', async () => {
    getSettings.mockResolvedValue({ data: { attribution_card: false } })
    wrapper = await openModal()
    expect(getSettings).toHaveBeenCalled()
    expect(cardBox().checked).toBe(false)
  })

  it('persists a toggle to the server', async () => {
    getSettings.mockResolvedValue({ data: { attribution_card: false } })
    wrapper = await openModal()

    cardBox().checked = true
    cardBox().dispatchEvent(new Event('change'))
    await flushPromises()

    expect(setSettings).toHaveBeenCalledWith(true)
    expect(cardBox().checked).toBe(true)
  })

  it('reverts the toggle when the server refuses it', async () => {
    getSettings.mockResolvedValue({ data: { attribution_card: false } })
    setSettings.mockRejectedValue(Object.assign(new Error('nope'), { status: 500 }))
    wrapper = await openModal()

    cardBox().checked = true
    cardBox().dispatchEvent(new Event('change'))
    await flushPromises()

    expect(cardBox().checked).toBe(false)
  })
})

describe('export request', () => {
  it('sends the default format and audio, and no card flag', async () => {
    exportSong.mockResolvedValue({
      data: new Blob(['zip-bytes']),
      headers: { 'content-disposition': 'attachment; filename="Ackerman - Zither Blues.zip"' },
    })
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(exportSong).toHaveBeenCalledWith(7, { format: 'mp3g', audio: 'karaoke' })
    const args = exportSong.mock.calls[0][1]
    expect('card' in args).toBe(false)
  })

  it('sends instrumental audio when chosen', async () => {
    exportSong.mockResolvedValue({
      data: new Blob(['zip-bytes']),
      headers: { 'content-disposition': 'attachment; filename="x.zip"' },
    })
    wrapper = await openModal()

    await choose('instrumental')
    confirmBtn().click()
    await flushPromises()

    expect(exportSong).toHaveBeenCalledWith(7, { format: 'mp3g', audio: 'instrumental' })
  })

  it('hides the audio choice for CD+G-only and sends no audio', async () => {
    exportSong.mockResolvedValue({
      data: new Blob(['cdg-bytes']),
      headers: { 'content-disposition': 'attachment; filename="x.cdg"' },
    })
    wrapper = await openModal()

    await choose('cdg')
    expect(radio('karaoke')).toBeNull()

    confirmBtn().click()
    await flushPromises()
    expect(exportSong).toHaveBeenCalledWith(7, { format: 'cdg', audio: undefined })
  })
})

describe('saving the result', () => {
  it('saves the blob under the server-chosen filename and closes', async () => {
    const payload = new Blob(['zip-bytes'])
    exportSong.mockResolvedValue({
      data: payload,
      headers: { 'content-disposition': 'attachment; filename="Ackerman - Zither Blues.zip"' },
    })
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(URL.createObjectURL).toHaveBeenCalledWith(payload)
    expect(savedAnchor).not.toBeNull()
    expect(savedAnchor.getAttribute('href')).toBe('blob:fake-export')
    expect(savedAnchor.getAttribute('download')).toBe('Ackerman - Zither Blues.zip')
    // The object URL is revoked on a delay so the click's navigation can
    // finish; immediately after the save it must still be live. (The
    // deferred revoke itself is cleanup, not contract — not awaited here.)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeTruthy()
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

    confirmBtn().click()
    await flushPromises()

    expect(savedAnchor.getAttribute('download')).toBe('Søng One.zip')
  })

  it('falls back to an id-based name when the header is missing', async () => {
    exportSong.mockResolvedValue({ data: new Blob(['zip-bytes']), headers: {} })
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(savedAnchor.getAttribute('download')).toBe('export-song-7.zip')
  })
})

describe('errors', () => {
  it('renders the JSON detail from a Blob error body', async () => {
    exportSong.mockRejectedValue({
      response: {
        status: 409,
        data: new Blob([JSON.stringify({ detail: 'Song has no word sync' })],
          { type: 'application/json' }),
      },
    })
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(bodyEl('.export-error').textContent).toContain('Song has no word sync')
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('renders the server detail from an already-normalised error', async () => {
    exportSong.mockRejectedValue(
      Object.assign(new Error('Export capability is not installed on this server'), { status: 501 }),
    )
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(bodyEl('.export-error').textContent)
      .toContain('Export capability is not installed on this server')
  })

  it('labels a transport failure generically', async () => {
    exportSong.mockRejectedValue(new Error('timeout of 300000ms exceeded'))
    wrapper = await openModal()

    confirmBtn().click()
    await flushPromises()

    expect(bodyEl('.export-error').textContent).toContain('Export failed')
    expect(bodyEl('.export-error').textContent).toContain('timeout of 300000ms exceeded')
  })
})

describe('dialog behaviour', () => {
  it('is a dialog named Export CD+G that starts on the format choice', async () => {
    wrapper = await openModal()
    const dialog = bodyEl('dialog.modal-overlay')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Export CD+G')
    expect(document.activeElement).toBe(radio('mp3g'))
  })

  it('Escape closes when idle', async () => {
    wrapper = await openModal()
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('holds the dialog open while an export is running', async () => {
    let finish
    exportSong.mockReturnValue(new Promise((r) => { finish = r }))
    wrapper = await openModal()
    confirmBtn().click()
    await flushPromises()

    const dialog = bodyEl('dialog.modal-overlay')
    expect(confirmBtn().disabled).toBe(true)
    expect(bodyEl('.modal__close').disabled).toBe(true)
    expect(bodyEl('.modal__footer .ui-btn--ghost').disabled).toBe(true)
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeFalsy()
    expect(dialog.contains(document.activeElement)).toBe(true)

    finish({ data: new Blob(['x']), headers: { get: () => null } })
    await flushPromises()
  })
})
