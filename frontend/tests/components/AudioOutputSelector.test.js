// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AudioOutputSelector from '../../src/components/AudioOutputSelector.vue'
import { useAudioOutput } from '../../src/composables/useAudioOutput.js'
import { useAudioEngine } from '../../src/composables/useAudioEngine.js'

afterEach(() => { delete window.karaokeDesktop; window.localStorage.clear(); vi.unstubAllGlobals() })

it('does not expose desktop controls in a browser', () => {
  const wrapper = mount(AudioOutputSelector, { props: { output: useAudioOutput() } })
  expect(wrapper.find('select').exists()).toBe(false)
  wrapper.unmount()
})

it('shows unnamed devices and explicit unavailable/denied states', async () => {
  window.karaokeDesktop = { isDesktop: true }
  const output = useAudioOutput()
  output.devices.value = [{ deviceId: 'a', label: '' }]
  const context = { sinkId: '', setSinkId: vi.fn().mockRejectedValue({ name: 'NotAllowedError' }) }
  await output.attach(context)
  const wrapper = mount(AudioOutputSelector, { props: { output } })
  expect(wrapper.text()).toContain('Audio output 1')
  await wrapper.get('select').setValue('a')
  await vi.waitFor(() => expect(wrapper.text()).toContain('permission denied'))
  expect(wrapper.text()).not.toContain('Output applied.')
  output.devices.value = []
  await wrapper.vm.$nextTick()
  expect(wrapper.text()).toContain('Saved output (unavailable)')
  wrapper.unmount()
})

it('reapplies output across actual engine cleanup and initialization without playing', async () => {
  window.karaokeDesktop = { isDesktop: true }
  const instances = []
  class FakeContext {
    constructor() {
      this.sinkId = ''
      this.close = vi.fn(async () => {})
      this.resume = vi.fn()
      this.setSinkId = vi.fn(async id => { this.sinkId = id })
      instances.push(this)
    }
    createAnalyser() { return { disconnect: vi.fn() } }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  const engine = useAudioEngine()
  await engine.initContext()
  await engine.output.select('speakers')
  engine.cleanup()
  await engine.initContext()
  expect(instances).toHaveLength(2)
  expect(instances[1].sinkId).toBe('speakers')
  expect(instances[1].resume).not.toHaveBeenCalled()
  expect(engine.playerState.value).toBe('stopped')
  expect(engine.currentTime.value).toBe(0)
  engine.cleanup()
})


it('keeps output-control keys away from window transport shortcuts without cancelling native behavior', () => {
  window.karaokeDesktop = { isDesktop: true }
  const output = useAudioOutput()
  output.supported.value = true
  output.status.value = 'error' // Render the retry action as well as refresh.
  const wrapper = mount(AudioOutputSelector, { props: { output }, attachTo: document.body })
  const globalShortcut = vi.fn()
  window.addEventListener('keydown', globalShortcut)
  try {
    const targets = wrapper.findAll('summary, button, select')
    expect(targets).toHaveLength(4)
    for (const target of targets) {
      for (const code of ['Space', 'Home', 'ArrowLeft', 'ArrowRight']) {
        const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true })
        target.element.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
      }
    }
    expect(globalShortcut).not.toHaveBeenCalled()
    // Prove the window listener is live and unrelated transport keys still reach it.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    expect(globalShortcut).toHaveBeenCalledTimes(1)
  } finally {
    window.removeEventListener('keydown', globalShortcut)
    wrapper.unmount()
  }
})
