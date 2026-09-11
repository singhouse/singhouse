// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Capability flags (GET /api/features). The load-bearing property is that the
// OFF state is the default and survives every failure mode: third-party
// lyrics lookup is opt-in, so "we could not find out" must read as off, never
// as on.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const get = vi.fn()

vi.mock('@/api/client', () => ({
  featuresApi: { get: (...a) => get(...a) },
}))

import { useFeaturesStore } from '@/stores/features'

const ENABLED = {
  data: {
    lyrics_lookup: {
      enabled: true, provider: 'lrclib', label: 'lrclib.net',
    },
  },
}

describe('features store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    get.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('reports lyrics lookup off before anything loads', () => {
    const features = useFeaturesStore()
    expect(features.lyricsLookupEnabled).toBe(false)
    expect(features.loaded).toBe(false)
  })

  it('reflects the server once loaded', async () => {
    get.mockResolvedValue(ENABLED)
    const features = useFeaturesStore()
    await features.load()
    expect(features.lyricsLookupEnabled).toBe(true)
    expect(features.lyricsLookupLabel).toBe('lrclib.net')
  })

  it('stays off when the request fails', async () => {
    get.mockRejectedValue(new Error('network down'))
    const features = useFeaturesStore()
    await features.load()
    expect(features.lyricsLookupEnabled).toBe(false)
  })

  it('stays off when the gate is locked (401)', async () => {
    const err = new Error('not authenticated')
    err.status = 401
    get.mockRejectedValue(err)
    const features = useFeaturesStore()
    await features.load()
    expect(features.lyricsLookupEnabled).toBe(false)
  })

  it('caches: a second load does not re-request', async () => {
    get.mockResolvedValue(ENABLED)
    const features = useFeaturesStore()
    await features.load()
    await features.load()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('force re-requests', async () => {
    get.mockResolvedValue(ENABLED)
    const features = useFeaturesStore()
    await features.load()
    await features.load({ force: true })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent callers', async () => {
    // The AudioPlayer warm-up and its own awaited check can race; without
    // in-flight dedupe both would see loaded===false and fire.
    let resolve
    get.mockReturnValue(new Promise(r => { resolve = r }))
    const features = useFeaturesStore()
    const a = features.load()
    const b = features.load()
    resolve(ENABLED)
    await Promise.all([a, b])
    expect(get).toHaveBeenCalledTimes(1)
    expect(features.lyricsLookupEnabled).toBe(true)
  })

  it('an awaited load settles before the flag is read', async () => {
    // This is the ordering AudioPlayer.loadLyrics depends on: awaiting load()
    // must mean the flag is final, or an enabled lookup gets suppressed.
    get.mockResolvedValue(ENABLED)
    const features = useFeaturesStore()
    await features.load()
    expect(features.lyricsLookupEnabled).toBe(true)
  })

  it('a slow first response cannot overwrite a newer forced one', async () => {
    // Ordering that bites without a generation counter: load() is issued,
    // a forced refresh is issued and answers first, then the original
    // response lands carrying the older state.
    let resolveSlow, resolveFast
    get.mockReturnValueOnce(new Promise(r => { resolveSlow = r }))
    get.mockReturnValueOnce(new Promise(r => { resolveFast = r }))

    const features = useFeaturesStore()
    const slow = features.load()
    const fast = features.load({ force: true })

    resolveFast(ENABLED)
    await fast
    expect(features.lyricsLookupEnabled).toBe(true)

    // The stale response arrives last and must be discarded.
    resolveSlow({ data: { lyrics_lookup: { enabled: false, provider: 'lrclib', label: '' } } })
    await slow
    expect(features.lyricsLookupEnabled).toBe(true)
  })

  it('a forced load does not leave the dedupe slot broken', async () => {
    get.mockResolvedValue(ENABLED)
    const features = useFeaturesStore()
    await features.load()
    await features.load({ force: true })
    get.mockClear()
    // Back to the cached path: no further request.
    await features.load()
    expect(get).not.toHaveBeenCalled()
  })

  it('tolerates a response without the lyrics_lookup key', async () => {
    get.mockResolvedValue({ data: {} })
    const features = useFeaturesStore()
    await features.load()
    expect(features.lyricsLookupEnabled).toBe(false)
    expect(features.loaded).toBe(true)
  })
})
