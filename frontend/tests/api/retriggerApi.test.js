// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Wire contract for the two routes that made ingest-time choices re-runnable.
// Both are jobs, so what matters here is that they reach the right
// path with the right body — a typo in either is a 404 the UI reports as a
// generic failure.

import { beforeEach, describe, expect, it } from 'vitest'
import client, { lyricsSetsApi, songApi } from '@/api/client'

let lastConfig

function okAdapter(config) {
  lastConfig = config
  return Promise.resolve({
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  })
}

beforeEach(() => {
  lastConfig = undefined
  client.defaults.adapter = okAdapter
})

describe('lyricsSetsApi.page', () => {
  it('posts to the set it is re-paging', async () => {
    await lyricsSetsApi.page(7, 42, { activate: true })
    expect(lastConfig.url).toBe('/songs/7/lyrics/42/page')
    expect(lastConfig.method).toBe('post')
    expect(JSON.parse(lastConfig.data)).toEqual({ activate: true })
  })

  it('sends an empty body when the caller passes none', async () => {
    await lyricsSetsApi.page(7, 42)
    expect(JSON.parse(lastConfig.data)).toEqual({})
  })
})

describe('songApi.resplit', () => {
  it('posts the model ID to the song stems route', async () => {
    await songApi.resplit(3, { karaoke_model: 'mdxnet_kara2' })
    expect(lastConfig.url).toBe('/songs/3/stems/resplit')
    expect(lastConfig.method).toBe('post')
    expect(JSON.parse(lastConfig.data)).toEqual({ karaoke_model: 'mdxnet_kara2' })
  })
})

describe('the LLM flags on the re-sync routes', () => {
  it('travel in the transcribe body', async () => {
    await lyricsSetsApi.transcribe(1, {
      whisper_model: 'heart', llm_paging: true,
    })
    expect(lastConfig.url).toBe('/songs/1/lyrics/transcribe')
    expect(JSON.parse(lastConfig.data)).toEqual({
      whisper_model: 'heart', llm_paging: true,
    })
  })

  it('travel in the realign body', async () => {
    await lyricsSetsApi.realign(1, { whisper_model: 'heart', llm_paging: true })
    expect(lastConfig.url).toBe('/songs/1/lyrics/realign')
    expect(JSON.parse(lastConfig.data)).toEqual({
      whisper_model: 'heart', llm_paging: true,
    })
  })
})
