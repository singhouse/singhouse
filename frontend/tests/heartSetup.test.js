// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest'
import { prepareHeart } from '../src/composables/useHeartSetup'

afterEach(() => vi.unstubAllGlobals())

it('preserves browser and explicit alternative transcription', async () => {
  await prepareHeart()
  const setup = vi.fn()
  vi.stubGlobal('window', { karaokeDesktop: { isDesktop: true, prepareHeart: setup } })
  await prepareHeart('tiny')
  expect(setup).not.toHaveBeenCalled()
})

it.each([
  [{ installed: false }, /cancelled/],
  [{ installed: true, restartRequired: true }, /Reopen the app/],
  [{ installed: false, reason: 'Download failed' }, /Download failed/],
  [undefined, /cancelled/],
])('does not admit an action when setup returns %j', async (result, message) => {
  vi.stubGlobal('window', { karaokeDesktop: { isDesktop: true, prepareHeart: vi.fn().mockResolvedValue(result) } })
  await expect(prepareHeart()).rejects.toThrow(message)
})

it('admits an already installed model only when no restart is needed', async () => {
  vi.stubGlobal('window', { karaokeDesktop: { isDesktop: true,
    prepareHeart: vi.fn().mockResolvedValue({ installed: true, restartRequired: false }) } })
  await expect(prepareHeart()).resolves.toBeUndefined()
})
