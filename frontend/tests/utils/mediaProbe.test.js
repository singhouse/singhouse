// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The add-files rows show a file's playing time when the browser can read it
// from the container metadata. The probe must never reject, must pick a video
// element for karaoke video, and must release its object URL on every path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDuration, probeMediaDuration } from '@/utils/uploadRouting'

let created
let revoke

function fakeElement(tag) {
  const el = {
    tag,
    preload: '',
    duration: NaN,
    src: '',
    onloadedmetadata: null,
    onerror: null,
    removeAttribute: vi.fn(),
  }
  created.push(el)
  return el
}

beforeEach(() => {
  created = []
  vi.spyOn(document, 'createElement').mockImplementation(fakeElement)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe')
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('probeMediaDuration', () => {
  it('reads the duration from metadata and revokes the URL', async () => {
    const p = probeMediaDuration({ name: 'a.mp3', type: 'audio/mpeg', size: 1 })
    const el = created[0]
    expect(el.tag).toBe('audio')
    expect(el.preload).toBe('metadata')
    expect(el.src).toBe('blob:probe')
    el.duration = 252.4
    el.onloadedmetadata()
    await expect(p).resolves.toBe(252.4)
    expect(revoke).toHaveBeenCalledWith('blob:probe')
  })

  it('uses a video element for karaoke video', async () => {
    const p = probeMediaDuration({ name: 'clip.mp4', type: 'video/mp4', size: 1 })
    expect(created[0].tag).toBe('video')
    created[0].duration = 60
    created[0].onloadedmetadata()
    await expect(p).resolves.toBe(60)
  })

  it('resolves null on a decode error', async () => {
    const p = probeMediaDuration({ name: 'a.mp3', type: 'audio/mpeg', size: 1 })
    created[0].onerror()
    await expect(p).resolves.toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:probe')
  })

  it('resolves null for an unknown or infinite duration', async () => {
    const p = probeMediaDuration({ name: 'a.mp3', type: 'audio/mpeg', size: 1 })
    created[0].duration = Infinity
    created[0].onloadedmetadata()
    await expect(p).resolves.toBeNull()
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const p = probeMediaDuration({ name: 'a.mp3', type: 'audio/mpeg', size: 1 }, { timeoutMs: 50 })
    vi.advanceTimersByTime(50)
    await expect(p).resolves.toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:probe')
  })

  it('resolves null when no object URL can be made', async () => {
    URL.createObjectURL.mockImplementation(() => { throw new TypeError('not a blob') })
    await expect(probeMediaDuration({ name: 'a.mp3' })).resolves.toBeNull()
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [9.4, '0:09'],
    [238, '3:58'],
    [3723, '1:02:03'],
  ])('%s -> %s', (sec, out) => {
    expect(formatDuration(sec)).toBe(out)
  })
})
