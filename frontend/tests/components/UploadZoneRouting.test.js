// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The drop zone feeds three different ingest routes, and picking the wrong one
// is expensive: the server's answer to a mismatch is a 415 that arrives only
// after the whole file — up to 2GB of it — has crossed the wire.
//
// @/utils/uploadRouting owns the decision and is unit-tested on its own
// (tests/utils/uploadRouting.test.js). What this file pins is the WIRING: a
// dropped file reaches the route its classification names, a container we
// cannot import is refused here with a reason rather than queued, and the
// transcription options — meaningless for prepared media whose lyrics are
// already in the picture — stay out of a prepared-only batch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: {
    list: vi.fn(async () => ({ data: { songs: [] } })),
    lookupLyrics: vi.fn(async () => ({ data: { found: false, plain_lyrics: null, synced: false } })),
  },
  lyricsSetsApi: {},
  featuresApi: { get: vi.fn(async () => ({ data: { llm_paging: false } })) },
}))

import UploadZone from '@/components/UploadZone.vue'
import { useSongsStore } from '@/stores/songs'
import { useFeaturesStore } from '@/stores/features'

let store
let wrapper

// Routing reads name/type/size only; a real File adds nothing here and the
// store actions that would consume one are spies.
function file(name, type, size = 4096) {
  return { name, type, size }
}

async function drop(...files) {
  await wrapper.find('.drop-zone').trigger('drop', { dataTransfer: { files } })
}

const ADD = '.upload-footer__add'

async function dropAndSubmit(f) {
  await drop(f)
  await wrapper.find(ADD).trigger('click')
}

beforeEach(() => {
  setActivePinia(createPinia())
  store = useSongsStore()
  vi.spyOn(store, 'uploadSong').mockResolvedValue(undefined)
  vi.spyOn(store, 'importVideoSong').mockResolvedValue(undefined)
  vi.spyOn(store, 'importCdgSong').mockResolvedValue(undefined)
  wrapper = mount(UploadZone)
})

afterEach(() => {
  delete window.karaokeDesktop
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

it('keeps pending audio and metadata when model setup is cancelled or requires reopening', async () => {
  const setup = vi.fn().mockResolvedValue({ installed: false })
  window.karaokeDesktop = { isDesktop: true, prepareHeart: setup }
  await drop(file('Artist - Song.mp3', 'audio/mpeg'))
  await wrapper.find(ADD).trigger('click')
  await flushPromises()
  expect(store.uploadSong).not.toHaveBeenCalled()
  expect(wrapper.find('.upload-item--pending').exists()).toBe(true)
  expect(wrapper.text()).toContain('cancelled')
  setup.mockResolvedValue({ installed: true, restartRequired: true })
  await wrapper.find(ADD).trigger('click')
  await flushPromises()
  expect(store.uploadSong).not.toHaveBeenCalled()
  expect(wrapper.find('.upload-item--pending').exists()).toBe(true)
  expect(wrapper.text()).toContain('Reopen the app')
  expect(wrapper.findAll('input').some(input => input.element.value === 'Artist')).toBe(true)
})

it('never asks for Heart when importing a prepared video', async () => {
  const setup = vi.fn()
  window.karaokeDesktop = { isDesktop: true, prepareHeart: setup }
  await dropAndSubmit(file('clip.mp4', 'video/mp4'))
  expect(setup).not.toHaveBeenCalled()
  expect(store.importVideoSong).toHaveBeenCalledTimes(1)
})

it.each([
  ['song.cdg', 'application/octet-stream'],
  ['song.zip', 'application/zip'],
])('routes %s as one prepared CD+G import without Heart', async (name, type) => {
  const setup = vi.fn()
  window.karaokeDesktop = { isDesktop: true, prepareHeart: setup }
  await dropAndSubmit(file(name, type))
  expect(setup).not.toHaveBeenCalled()
  expect(store.importCdgSong).toHaveBeenCalledTimes(1)
  expect(store.uploadSong).not.toHaveBeenCalled()
})

it.each([false, true])('protects a pending setup from duplicate submit and removal=%s', async (remove) => {
  let complete
  const setup = vi.fn(() => new Promise(resolve => { complete = resolve }))
  window.karaokeDesktop = { isDesktop: true, prepareHeart: setup }
  await drop(file('song.mp3', 'audio/mpeg'))
  await wrapper.find(ADD).trigger('click')
  expect(wrapper.find(ADD).element.disabled).toBe(true)
  // Enter on a metadata field also submits; it must obey the same guard.
  await wrapper.find('.upload-item__fields input').trigger('keydown.enter')
  expect(setup).toHaveBeenCalledTimes(1)
  if (remove) await wrapper.find('.btn-cancel').trigger('click')
  complete({ installed: true, restartRequired: false })
  await flushPromises()
  expect(store.uploadSong).toHaveBeenCalledTimes(remove ? 0 : 1)
})

describe('a dropped file reaches the route its type and container name', () => {
  it('sends a video-typed .mp4 to the video import', async () => {
    await dropAndSubmit(file('clip.mp4', 'video/mp4'))
    expect(store.importVideoSong).toHaveBeenCalledTimes(1)
    expect(store.uploadSong).not.toHaveBeenCalled()
  })

  it('sends a typeless .mp4 to the video import', async () => {
    await dropAndSubmit(file('clip.mp4', ''))
    expect(store.importVideoSong).toHaveBeenCalledTimes(1)
    expect(store.uploadSong).not.toHaveBeenCalled()
  })

  it('sends an AUDIO .mp4 to the separation route, as it always went', async () => {
    // The regression this test exists for: routing on extension alone put an
    // audio/mp4 file on the import route, which refuses audio/* after the
    // upload completes.
    await dropAndSubmit(file('track.mp4', 'audio/mp4'))
    expect(store.uploadSong).toHaveBeenCalledTimes(1)
    expect(store.importVideoSong).not.toHaveBeenCalled()
  })

  it('sends a .mp3 to the separation route', async () => {
    await dropAndSubmit(file('track.mp3', 'audio/mpeg'))
    expect(store.uploadSong).toHaveBeenCalledTimes(1)
    expect(store.importVideoSong).not.toHaveBeenCalled()
  })

  it('routes each file of a mixed batch on its own', async () => {
    await drop(file('track.mp3', 'audio/mpeg'), file('clip.mkv', ''))
    expect(wrapper.findAll('.upload-item--pending')).toHaveLength(2)
    await wrapper.find(ADD).trigger('click')
    await flushPromises()
    expect(store.uploadSong).toHaveBeenCalledTimes(1)
    expect(store.importVideoSong).toHaveBeenCalledTimes(1)
  })
})

describe('a container we cannot import', () => {
  it('is refused here, with the containers that do work named', async () => {
    await drop(file('clip.avi', 'video/x-msvideo'))

    const err = wrapper.find('.upload-error')
    expect(err.exists()).toBe(true)
    for (const label of ['MP4', 'WebM', 'MOV', 'MKV']) {
      expect(err.text()).toContain(label)
    }
  })

  it('never becomes a pending upload', async () => {
    await drop(file('clip.avi', 'video/x-msvideo'))
    expect(wrapper.find('.upload-item--pending').exists()).toBe(false)
    expect(store.importVideoSong).not.toHaveBeenCalled()
  })
})

describe('the ingest options', () => {
  it('stay hidden for a video-only batch', async () => {
    // Transcription and alignment settings have nothing to act on: the words
    // are burned into the picture.
    await drop(file('clip.mp4', 'video/mp4'))
    expect(wrapper.find('.model-select').exists()).toBe(false)
  })

  it('appear as soon as an audio file is waiting', async () => {
    await drop(file('clip.mp4', 'video/mp4'), file('track.mp3', 'audio/mpeg'))
    expect(wrapper.find('.model-select').exists()).toBe(true)
  })

  it('are not sent with a video import', async () => {
    await flushPromises()
    useFeaturesStore().llmPaging = true
    await drop(file('track.mp3', 'audio/mpeg'), file('clip.mp4', 'video/mp4'))
    await wrapper.find('.upload-footer input[type="checkbox"]').setValue(true)
    await wrapper.find(ADD).trigger('click')
    await flushPromises()

    expect(store.importVideoSong).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clip.mp4' }),
      expect.anything(),
      expect.anything(),
    )
    // Three arguments only — no options bag rides along.
    expect(store.importVideoSong.mock.calls[0]).toHaveLength(3)
  })
})


it('shows page grouping only after endpoint configuration is reported', async () => {
  await drop(file('song.mp3', 'audio/mpeg'))
  await flushPromises()
  expect(wrapper.text()).not.toContain('LLM paging')
  expect(wrapper.text()).not.toContain('LLM correction')
  useFeaturesStore().llmPaging = true
  await flushPromises()
  expect(wrapper.text()).toContain('LLM paging')
})
