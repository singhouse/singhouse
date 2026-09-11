// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The Plex-lyrics flag in the capability store. Same property the lrclib flag
// has and for the same reason: OFF is the default and survives every failure
// mode, because "we could not find out" must never render as "the operator
// opted in".

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const get = vi.fn()

vi.mock('@/api/client', () => ({
  featuresApi: { get: (...a) => get(...a) },
}))

import { useFeaturesStore } from '@/stores/features'

describe('features store — plex lyrics', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    get.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('is off before anything loads', () => {
    expect(useFeaturesStore().plexLyricsEnabled).toBe(false)
  })

  it('reflects the server when opted in', async () => {
    get.mockResolvedValue({
      data: { plex_lyrics: { enabled: true, env: 'KARAOKE_PLEX_LYRICS' } },
    })
    const features = useFeaturesStore()
    await features.load()
    expect(features.plexLyricsEnabled).toBe(true)
    expect(features.plexLyricsEnv).toBe('KARAOKE_PLEX_LYRICS')
  })

  it('stays off when the payload omits the key', async () => {
    get.mockResolvedValue({ data: { cdg_export: true } })
    const features = useFeaturesStore()
    await features.load()
    expect(features.plexLyricsEnabled).toBe(false)
  })

  it('stays off when the request fails', async () => {
    get.mockRejectedValue(new Error('network down'))
    const features = useFeaturesStore()
    await features.load()
    expect(features.plexLyricsEnabled).toBe(false)
  })

  it('names the variable even before a payload arrives', () => {
    // The modal prints this in its "not used as a reference" note, so it must
    // be a real variable name rather than an empty string.
    expect(useFeaturesStore().plexLyricsEnv).toBe('KARAOKE_PLEX_LYRICS')
  })
})
