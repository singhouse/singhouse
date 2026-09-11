// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Wire contract for the export slice: the song fetch asks for a blob with a
// long-call timeout, only sends the params the caller chose (no card flag
// unless explicitly overridden), and a failed blob request still rejects
// with the server's JSON detail — the error body arrives as a Blob, and the
// client must decode it rather than surface axios's generic status line.

import { beforeEach, describe, expect, it } from 'vitest'
import client, { exportApi } from '@/api/client'

let lastConfig

function okAdapter(config) {
  lastConfig = config
  return Promise.resolve({
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  })
}

function blobErrorAdapter(status, detail) {
  return (config) => {
    lastConfig = config
    const err = new Error(`Request failed with status code ${status}`)
    err.response = {
      status,
      data: new Blob([JSON.stringify({ detail })], { type: 'application/json' }),
      headers: {},
      config,
    }
    err.config = config
    return Promise.reject(err)
  }
}

beforeEach(() => {
  lastConfig = undefined
  client.defaults.adapter = okAdapter
})

describe('exportApi.exportSong', () => {
  it('requests a blob with the long-call timeout', async () => {
    await exportApi.exportSong(7, { format: 'mp3g', audio: 'karaoke' })
    expect(lastConfig.url).toBe('/export/songs/7')
    expect(lastConfig.responseType).toBe('blob')
    expect(lastConfig.timeout).toBe(300000)
  })

  it('sends only the chosen params — no card flag by default', async () => {
    await exportApi.exportSong(7, { format: 'cdg' })
    expect(lastConfig.params).toEqual({ format: 'cdg' })
    expect('card' in lastConfig.params).toBe(false)
    expect('audio' in lastConfig.params).toBe(false)
  })

  it('passes an explicit card override through', async () => {
    await exportApi.exportSong(7, { format: 'mp3g', audio: 'instrumental', card: false })
    expect(lastConfig.params).toEqual({ format: 'mp3g', audio: 'instrumental', card: false })
  })

  it('decodes a JSON detail wrapped in a Blob error body', async () => {
    client.defaults.adapter = blobErrorAdapter(501, 'Export capability is not installed')
    await expect(exportApi.exportSong(7, { format: 'mp3g', audio: 'karaoke' }))
      .rejects.toMatchObject({ message: 'Export capability is not installed', status: 501 })
  })

  it('falls back to the axios message when the Blob body is not JSON', async () => {
    client.defaults.adapter = (config) => {
      const err = new Error('Request failed with status code 500')
      err.response = { status: 500, data: new Blob(['<html>oops</html>']), headers: {}, config }
      err.config = config
      return Promise.reject(err)
    }
    await expect(exportApi.exportSong(7, { format: 'mp3g' }))
      .rejects.toMatchObject({ message: 'Request failed with status code 500', status: 500 })
  })
})

describe('exportApi settings', () => {
  it('reads the stored attribution-card preference', async () => {
    await exportApi.getSettings()
    expect(lastConfig.method).toBe('get')
    expect(lastConfig.url).toBe('/export/settings')
  })

  it('writes the preference as attribution_card', async () => {
    await exportApi.setSettings(false)
    expect(lastConfig.method).toBe('put')
    expect(lastConfig.url).toBe('/export/settings')
    expect(JSON.parse(lastConfig.data)).toEqual({ attribution_card: false })
  })
})
