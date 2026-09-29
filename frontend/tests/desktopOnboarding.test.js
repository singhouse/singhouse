// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { useDesktopOnboarding } from '../src/composables/useDesktopOnboarding'
import DesktopOnboarding from '../src/components/DesktopOnboarding.vue'

function bridge(overrides = {}) {
  return {
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'welcome', choice: 'local' }),
    setOnboardingState: vi.fn().mockResolvedValue({}),
    getSetupStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
    preflightSetup: vi.fn().mockResolvedValue({ planId: 'plan-1', available: true, components: [{ label: 'Processing model', bytes: 1024, sources: ['https://example.test/model'], terms: 'MIT' }] }),
    startSetup: vi.fn().mockResolvedValue({ state: 'running', phase: 'download' }),
    cancelSetup: vi.fn().mockResolvedValue({ state: 'cancelled' }),
    openSetupHelp: vi.fn().mockResolvedValue({}),
    restartApp: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}
afterEach(() => { delete globalThis.window.karaokeDesktop; vi.useRealTimers() })

describe('desktop setup consent and recovery', () => {
  it('requires a preflight and explicit consent before starting components', async () => {
    const desktop = bridge()
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(await setup.start()).toBe(false)
    await setup.chooseProcessing()
    await setup.continueChoice()
    expect(setup.step.value).toBe('consent')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await setup.start()
    expect(desktop.startSetup).toHaveBeenCalledWith({ consent: true, planId: 'plan-1' })
    expect(setup.step.value).toBe('progress')
  })
  it('does not trust persisted readiness and does not start setup when skipped', async () => {
    const desktop = bridge({ getOnboardingState: vi.fn().mockResolvedValue({ step: 'ready', choice: 'local' }) })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(setup.step.value).toBe('choose')
    await setup.skip()
    expect(desktop.setOnboardingState).toHaveBeenLastCalledWith({ step: 'choose', choice: 'local', skipped: true })
    expect(desktop.startSetup).not.toHaveBeenCalled()
  })
  it('resumes the actual running state and only shows readiness when verified', async () => {
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running', phase: 'verify' }) })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(setup.step.value).toBe('progress')
    desktop.getSetupStatus.mockResolvedValue({ state: 'restart-required' })
    await setup.refresh()
    expect(setup.step.value).toBe('restart')
    desktop.getSetupStatus.mockResolvedValue({ state: 'ready' })
    await setup.refresh()
    expect(setup.step.value).toBe('ready')
  })
  it('rechecks preflight before retrying cancelled setup', async () => {
    const desktop = bridge()
    const setup = useDesktopOnboarding(desktop)
    await setup.chooseProcessing()
    await setup.start()
    await setup.cancel()
    expect(setup.step.value).toBe('error')
    desktop.preflightSetup.mockResolvedValue({ available: false, reason: 'Not enough disk space' })
    await setup.chooseProcessing()
    expect(setup.localAvailable.value).toBe(false)
    expect(setup.choice.value).toBe('modal')
    expect(await setup.start()).toBe(false)
    expect(desktop.startSetup).toHaveBeenCalledTimes(1)
  })
  it('checks the installed runtime after restart and routes verified ready without downloading', async () => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'restart' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, ready: true, components: [] }),
    })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    expect(setup.step.value).toBe('ready')
    expect(desktop.startSetup).not.toHaveBeenCalled()
  })
  it('shows bridge failures while leaving navigation available', async () => {
    const setup = useDesktopOnboarding(bridge({ preflightSetup: vi.fn().mockRejectedValue(new Error('Disk check failed')) }))
    expect(await setup.chooseProcessing()).toBe(false)
    expect(setup.error.value).toBe('Disk check failed')
    expect(setup.busy.value).toBe(false)
    expect(await setup.skip()).toBe(true)
  })
})

describe('desktop setup screens', () => {
  it('keeps both cards visible and explains unavailable local setup', async () => {
    const desktop = bridge({ preflightSetup: vi.fn().mockResolvedValue({ available: false, reason: 'A qualified runtime is unavailable.' }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    const cards = wrapper.findAll('.choice')
    expect(cards).toHaveLength(2)
    expect(cards[0].attributes('disabled')).toBeDefined()
    expect(cards[0].text()).toContain('A qualified runtime is unavailable.')
    expect(cards[1].attributes('aria-pressed')).toBe('true')
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Save and check your connection')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('shows per-file byte progress and uses a modal dialog', async () => {
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running', progress: { file: 'model.bin', received: 250, total: 1000 } }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('dialog').attributes('open')).toBeDefined()
    expect(wrapper.find('progress').attributes('value')).toBe('25')
    expect(wrapper.text()).toContain('model.bin · 250 / 1,000 bytes (25% of this file)')
    wrapper.unmount()
  })
  it('renders real download details before a consent action', async () => {
    const desktop = bridge()
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('https://example.test/model')
    expect(wrapper.text()).toContain('Terms: MIT')
    expect(wrapper.text()).toContain('1,024 bytes')
    expect(wrapper.text()).toContain('Not yet known')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('progress').attributes('value')).toBeUndefined()
    wrapper.unmount()
  })
})
