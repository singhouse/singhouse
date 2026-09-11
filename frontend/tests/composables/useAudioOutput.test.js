// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioOutput } from '../../src/composables/useAudioOutput.js'

const device = (deviceId, label = '') => ({ kind: 'audiooutput', deviceId, label })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const ctx = () => {
  const context = { sinkId: '', state: 'running' }
  context.setSinkId = vi.fn(async id => { context.sinkId = id })
  return context
}
let media
beforeEach(() => {
  window.localStorage.clear()
  window.karaokeDesktop = { isDesktop: true }
  media = new EventTarget()
  media.enumerateDevices = vi.fn(async () => [device('a'), device('b'), { kind: 'audioinput', deviceId: 'mic' }])
  media.getUserMedia = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: media })
})
afterEach(() => { delete window.karaokeDesktop; vi.unstubAllGlobals() })

describe('desktop audio output routing', () => {
  it('is inert in a normal browser and leaves the default output untouched', async () => {
    delete window.karaokeDesktop
    const output = useAudioOutput()
    const context = ctx()
    output.start()
    await output.attach(context)
    await output.select('a')
    expect(output.enabled).toBe(false)
    expect(context.setSinkId).not.toHaveBeenCalled()
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })

  it('preserves the default then reapplies a chosen output on a recreated context', async () => {
    const output = useAudioOutput()
    const first = ctx()
    await output.attach(first)
    expect(first.setSinkId).not.toHaveBeenCalled()
    await output.select('a')
    expect(first.sinkId).toBe('a')
    output.detach()
    const second = ctx()
    await output.attach(second)
    expect(second.sinkId).toBe('a')
    expect(useAudioOutput().selectedId.value).toBe('a')
  })

  it('enumerates outputs without capture and updates disconnection on devicechange', async () => {
    const output = useAudioOutput()
    output.start()
    await vi.waitFor(() => expect(output.devices.value).toHaveLength(2))
    await output.select('a')
    expect(output.missing.value).toBe(false)
    media.enumerateDevices.mockResolvedValue([device('b')])
    media.dispatchEvent(new Event('devicechange'))
    await vi.waitFor(() => expect(output.missing.value).toBe(true))
    expect(media.getUserMedia).not.toHaveBeenCalled()
    output.stop()
    media.enumerateDevices.mockClear()
    media.dispatchEvent(new Event('devicechange'))
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })

  it.each(['NotAllowedError', 'NotFoundError', 'AbortError'])('reports %s without claiming success or forgetting the preference', async name => {
    const output = useAudioOutput()
    const context = ctx()
    await output.attach(context)
    context.setSinkId.mockRejectedValue({ name })
    await output.select('a')
    expect(output.status.value).toBe('error')
    expect(output.error.value).toMatch(/denied|disconnected|Could not/)
    expect(output.selectedId.value).toBe('a')
    expect(context.sinkId).toBe('')
  })

  it('reports unsupported output switching', async () => {
    const output = useAudioOutput()
    await output.attach({})
    expect(output.status.value).toBe('unsupported')
  })

  it('serializes competing changes so the latest selection wins', async () => {
    const output = useAudioOutput()
    const context = ctx()
    const pending = deferred()
    await output.attach(context)
    context.setSinkId.mockImplementationOnce(async id => { await pending.promise; context.sinkId = id })
    const first = output.select('a')
    await Promise.resolve()
    const second = output.select('b')
    expect(context.setSinkId).toHaveBeenCalledTimes(1)
    pending.resolve()
    await Promise.all([first, second])
    expect(context.sinkId).toBe('b')
    expect(output.status.value).toBe('ready')
  })

  it('does not let a disposed context delay or overwrite its replacement', async () => {
    const output = useAudioOutput()
    const old = ctx()
    const pending = deferred()
    await output.attach(old)
    old.setSinkId.mockReturnValue(pending.promise)
    const selection = output.select('a')
    await Promise.resolve()
    output.detach()
    const replacement = ctx()
    await output.attach(replacement)
    expect(replacement.sinkId).toBe('a')
    pending.reject({ name: 'InvalidStateError' })
    await selection
    expect(output.status.value).toBe('ready')
    expect(output.error.value).toBe('')
  })

  it('ignores stale enumeration results including completion after stop', async () => {
    const output = useAudioOutput()
    const pending = deferred()
    media.enumerateDevices.mockReturnValueOnce(pending.promise)
    const stale = output.refresh()
    await output.refresh()
    output.stop()
    pending.resolve([device('stale')])
    await stale
    expect(output.devices.value.map(d => d.deviceId)).toEqual(['a', 'b'])
  })
})
