// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The add-files dialog groups files by whether they need processing and gives
// each audio file its own reference lyrics. These tests drive the real store
// and the real request builder with only the HTTP client stubbed, so what they
// assert is the form data each file is actually sent with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const probe = vi.hoisted(() => ({ duration: vi.fn() }))
vi.mock('@/utils/uploadRouting', async (importOriginal) => ({
  ...(await importOriginal()),
  probeMediaDuration: probe.duration,
}))

import client from '@/api/client'
import UploadZone from '@/components/UploadZone.vue'
import { useFeaturesStore } from '@/stores/features'

const WARNING = 'Without reference lyrics, timing and words may be transcribed incorrectly. Paste lyrics for best results.'
const MATCH_TEXT = 'synthetic line one\nsynthetic line two'

let wrapper
let lookup
let post

function audio(name) {
  return new File(['x'], name, { type: 'audio/mpeg' })
}
function video(name) {
  return new File(['x'], name, { type: 'video/mp4' })
}

async function drop(...files) {
  await wrapper.find('.drop-zone').trigger('drop', { dataTransfer: { files } })
  await flushPromises()
}

function rowFor(name) {
  const row = wrapper.findAll('.upload-item--pending').find(r => r.text().includes(name))
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

async function addAll() {
  await wrapper.find('.upload-footer__add').trigger('click')
  await flushPromises()
}

// file name -> the plain_lyrics field of its /separate request (null if absent)
function sentLyrics() {
  const out = {}
  for (const [url, form] of post.mock.calls) {
    if (url !== '/separate') continue
    out[form.get('file').name] = form.get('plain_lyrics')
  }
  return out
}

async function enableLookup() {
  useFeaturesStore().lyricsLookup = { enabled: true, provider: 'lrclib', label: 'LRCLIB', env: '' }
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  probe.duration.mockReset()
  probe.duration.mockResolvedValue(null)
  lookup = vi.fn(async () => ({ data: { found: false, plain_lyrics: null, synced: false } }))
  vi.spyOn(client, 'get').mockImplementation((url, config) => {
    if (url === '/lyrics/lookup') return lookup(config.params)
    if (url === '/features') return Promise.resolve({ data: {} })
    if (url.startsWith('/jobs/')) return new Promise(() => {})
    return Promise.resolve({ data: { songs: [], total: 0 } })
  })
  post = vi.spyOn(client, 'post').mockImplementation(async () => ({ data: { job_id: 'job-1' } }))
  wrapper = mount(UploadZone)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

describe('layout', () => {
  it('lists the formats under the two readiness headings', () => {
    const routes = wrapper.find('.dz-routes').text()
    expect(routes).toContain('READY TO PLAY')
    expect(routes).toContain('Karaoke video MP4 · WebM · MOV · MKV up to 2GB · CDG up to 30 min · MP3+G ZIP up to 550MB')
    expect(routes).toContain('NEEDS PROCESSING')
    expect(routes).toContain('Audio MP3 · FLAC · WAV · M4A · OGG up to 500MB · processed on this computer')
  })

  it('labels the footer action with the file count', async () => {
    const add = () => wrapper.find('.upload-footer__add')
    expect(add().text()).toBe('Add 0 files')
    expect(add().element.disabled).toBe(true)
    await drop(audio('A - One.mp3'))
    expect(add().text()).toBe('Add 1 file')
    await drop(video('Clip.mp4'), audio('B - Two.mp3'))
    expect(add().text()).toBe('Add 3 files')
    expect(add().element.disabled).toBe(false)
    expect(wrapper.find('.upload-footer').text()).toContain('Cancel')
  })

  it('shows name, duration and size once the probe knows the duration', async () => {
    probe.duration.mockImplementation(async f => (f.name === 'Clip.mp4' ? 238 : null))
    await drop(video('Clip.mp4'), audio('A - One.mp3'), new File(['x'], 'song.cdg'))
    expect(rowFor('Clip.mp4').find('.pending-filename').text()).toBe('Clip.mp4 · 3:58 · 1 KB')
    expect(rowFor('A - One.mp3').find('.pending-filename').text()).toBe('A - One.mp3 · 1 KB')
    // Only audio and video are probed; CDG packets carry no player metadata.
    expect(probe.duration.mock.calls.map(([f]) => f.name)).toEqual(['Clip.mp4', 'A - One.mp3'])
  })

  it('stays quiet when the probe fails', async () => {
    probe.duration.mockRejectedValue(new Error('decode'))
    await drop(audio('A - One.mp3'))
    expect(rowFor('A - One.mp3').find('.pending-filename').text()).toBe('A - One.mp3 · 1 KB')
    expect(wrapper.find('.upload-error').exists()).toBe(false)
  })

  it('has no batch-wide lyrics box', async () => {
    await drop(audio('A - One.mp3'), audio('B - Two.mp3'))
    expect(wrapper.findAll('textarea')).toHaveLength(2)
    expect(wrapper.find('.ingest-options__lyrics').exists()).toBe(false)
  })

  it('cancel clears the selection and asks to close', async () => {
    await drop(audio('A - One.mp3'))
    await wrapper.find('.upload-footer__cancel').trigger('click')
    expect(wrapper.find('.upload-item--pending').exists()).toBe(false)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('grouping', () => {
  it('puts a video under Ready to play and audio under Needs processing', async () => {
    await drop(video('Clip.mp4'), audio('A - One.mp3'))
    const ready = wrapper.find('.pending-group--ready')
    const proc = wrapper.find('.pending-group--process')
    expect(ready.find('.group-head').text()).toBe('Ready to play')
    expect(proc.find('.group-head').text()).toBe('Needs processing')
    expect(ready.text()).toContain('Clip.mp4')
    expect(proc.text()).toContain('A - One.mp3')
  })

  it('gives a karaoke video row no lyrics control', async () => {
    await drop(video('Clip.mp4'), audio('A - One.mp3'))
    const videoRow = rowFor('Clip.mp4')
    expect(videoRow.find('.btn-paste-toggle').exists()).toBe(false)
    expect(videoRow.find('textarea').exists()).toBe(false)
    expect(videoRow.find('.lyr-chip').exists()).toBe(false)
    expect(rowFor('A - One.mp3').find('.btn-paste-toggle').text()).toBe('Paste lyrics')
  })

  it('hides a group with no files in it', async () => {
    await drop(audio('A - One.mp3'))
    expect(wrapper.find('.pending-group--ready').exists()).toBe(false)
    expect(wrapper.find('.pending-group--process').exists()).toBe(true)
  })
})

describe('per-file pasted lyrics', () => {
  it('opens a lyrics box under that row only', async () => {
    await drop(audio('A - One.mp3'), audio('B - Two.mp3'))
    const a = rowFor('A - One.mp3')
    await a.find('.btn-paste-toggle').trigger('click')
    expect(a.find('.btn-paste-toggle').text()).toBe('Hide lyrics')
    expect(a.find('.row-panel').element.style.display).toBe('')
    expect(rowFor('B - Two.mp3').find('.row-panel').element.style.display).toBe('none')
  })

  it('sends lyrics pasted on one row only with that file', async () => {
    await drop(audio('A - One.mp3'), audio('B - Two.mp3'))
    const a = rowFor('A - One.mp3')
    await a.find('.btn-paste-toggle').trigger('click')
    await a.find('textarea').setValue('  synthetic pasted words  ')
    expect(a.find('.lyr-chip').text()).toBe('Lyrics: pasted')
    expect(rowFor('B - Two.mp3').find('.lyr-chip').text()).toBe('No reference lyrics')

    await addAll()
    expect(sentLyrics()).toEqual({
      'A - One.mp3': 'synthetic pasted words',
      'B - Two.mp3': null,
    })
  })

  it('shows the warning once per row without reference lyrics', async () => {
    await drop(audio('A - One.mp3'), audio('B - Two.mp3'), video('Clip.mp4'))
    await rowFor('A - One.mp3').find('textarea').setValue('synthetic pasted words')
    const count = wrapper.text().split(WARNING).length - 1
    expect(count).toBe(1)
    expect(rowFor('B - Two.mp3').find('.row-warn').text()).toBe(WARNING)
    expect(rowFor('A - One.mp3').find('.row-warn').exists()).toBe(false)
  })
})

describe('third-party lookup', () => {
  it('is never called and never shows a match while the feature is off', async () => {
    await drop(audio('A - One.mp3'))
    expect(lookup).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('LRCLIB match')
    expect(rowFor('A - One.mp3').find('.lyr-chip').text()).toBe('No reference lyrics')
  })

  it('fills the row\'s editable box with a match when the feature is on', async () => {
    lookup.mockResolvedValue({ data: { found: true, plain_lyrics: MATCH_TEXT, synced: true } })
    await enableLookup()
    await drop(audio('A - One.mp3'))
    expect(lookup).toHaveBeenCalledWith({ artist: 'A', title: 'One' })
    const a = rowFor('A - One.mp3')
    expect(a.find('.lyr-chip').text()).toBe('Lyrics: LRCLIB match')
    expect(a.find('.btn-paste-toggle').text()).toBe('Show lyrics')
    expect(a.find('textarea').element.value).toBe(MATCH_TEXT)
    expect(a.find('textarea').attributes('readonly')).toBeUndefined()
    expect(a.find('.row-warn').exists()).toBe(false)
  })

  it('shows Looking up while the lookup is in flight', async () => {
    let resolve
    lookup.mockImplementation(() => new Promise(r => { resolve = r }))
    await enableLookup()
    await drop(audio('A - One.mp3'))
    expect(rowFor('A - One.mp3').find('.lyr-chip').text()).toBe('Looking up…')
    resolve({ data: { found: false, plain_lyrics: null, synced: false } })
    await flushPromises()
    expect(rowFor('A - One.mp3').find('.lyr-chip').text()).toBe('No reference lyrics')
  })

  it('sends no lyrics for an unedited match, so ingest looks up on its own', async () => {
    lookup.mockResolvedValue({ data: { found: true, plain_lyrics: MATCH_TEXT, synced: true } })
    await enableLookup()
    await drop(audio('A - One.mp3'))
    await addAll()
    expect(sentLyrics()).toEqual({ 'A - One.mp3': null })
  })

  it('marks an edited match as edited and sends the edited text', async () => {
    lookup.mockResolvedValue({ data: { found: true, plain_lyrics: MATCH_TEXT, synced: true } })
    await enableLookup()
    await drop(audio('A - One.mp3'))
    const a = rowFor('A - One.mp3')
    await a.find('textarea').setValue(`${MATCH_TEXT}\nsynthetic line three`)
    expect(a.find('.lyr-chip').text()).toBe('Lyrics: edited')
    await addAll()
    expect(sentLyrics()).toEqual({ 'A - One.mp3': `${MATCH_TEXT}\nsynthetic line three` })
  })

  it('falls back to no reference lyrics when the lookup fails', async () => {
    lookup.mockRejectedValue(new Error('Request failed with status code 502'))
    await enableLookup()
    await drop(audio('A - One.mp3'))
    const a = rowFor('A - One.mp3')
    expect(a.find('.lyr-chip').text()).toBe('No reference lyrics')
    expect(wrapper.find('.upload-error').exists()).toBe(false)
  })

  it('skips the lookup for a row without an artist', async () => {
    await enableLookup()
    await drop(audio('untitled.mp3'))
    expect(lookup).not.toHaveBeenCalled()
  })

  it('never replaces text the user pasted while the lookup was running', async () => {
    let resolve
    lookup.mockImplementation(() => new Promise(r => { resolve = r }))
    await enableLookup()
    await drop(audio('A - One.mp3'))
    await rowFor('A - One.mp3').find('textarea').setValue('synthetic pasted words')
    resolve({ data: { found: true, plain_lyrics: MATCH_TEXT, synced: false } })
    await flushPromises()
    const a = rowFor('A - One.mp3')
    expect(a.find('textarea').element.value).toBe('synthetic pasted words')
    expect(a.find('.lyr-chip').text()).toBe('Lyrics: pasted')
  })
})
