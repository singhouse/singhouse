// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The drop zone feeds two different ingest routes, and picking the wrong one
// is expensive: the server's answer to a mismatch is a 415 that arrives only
// after the whole file — up to 2GB of it — has crossed the wire.
//
// @/utils/uploadRouting owns the decision and is unit-tested on its own
// (tests/utils/uploadRouting.test.js). What this file pins is the WIRING: a
// dropped file reaches the route its classification names, a container we
// cannot import is refused here with a reason rather than queued, and the
// transcription options — meaningless for a video whose lyrics are already in
// the picture — stay out of a video-only batch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: vi.fn(async () => ({ data: { songs: [] } })) },
  lyricsSetsApi: {},
}))

import UploadZone from '@/components/UploadZone.vue'
import { useSongsStore } from '@/stores/songs'

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

async function dropAndSubmit(f) {
  await drop(f)
  await wrapper.find('.btn-upload').trigger('click')
}

beforeEach(() => {
  setActivePinia(createPinia())
  store = useSongsStore()
  vi.spyOn(store, 'uploadSong').mockResolvedValue(undefined)
  vi.spyOn(store, 'importVideoSong').mockResolvedValue(undefined)
  wrapper = mount(UploadZone)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
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
    const buttons = wrapper.findAll('.btn-upload')
    expect(buttons).toHaveLength(2)
    await buttons[0].trigger('click')
    await wrapper.find('.btn-upload').trigger('click')
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
    expect(wrapper.find('.btn-upload').exists()).toBe(false)
    expect(store.importVideoSong).not.toHaveBeenCalled()
  })
})

describe('the ingest options', () => {
  it('stay hidden for a video-only batch', async () => {
    // Transcription and alignment settings have nothing to act on: the words
    // are burned into the picture.
    await drop(file('clip.mp4', 'video/mp4'))
    expect(wrapper.find('.ingest-options').exists()).toBe(false)
  })

  it('appear as soon as an audio file is waiting', async () => {
    await drop(file('clip.mp4', 'video/mp4'), file('track.mp3', 'audio/mpeg'))
    expect(wrapper.find('.ingest-options').exists()).toBe(true)
  })

  it('are not sent with a video import', async () => {
    await drop(file('track.mp3', 'audio/mpeg'), file('clip.mp4', 'video/mp4'))
    await wrapper.find('.ingest-options input[type="checkbox"]').setValue(true)
    await wrapper.findAll('.btn-upload')[1].trigger('click')

    expect(store.importVideoSong).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clip.mp4' }),
      expect.anything(),
      expect.anything(),
    )
    // Three arguments only — no options bag rides along.
    expect(store.importVideoSong.mock.calls[0]).toHaveLength(3)
  })
})
