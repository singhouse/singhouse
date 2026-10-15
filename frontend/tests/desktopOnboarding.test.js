// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useDesktopOnboarding } from '../src/composables/useDesktopOnboarding'
import DesktopOnboarding from '../src/components/DesktopOnboarding.vue'
import onboardingSource from '../src/components/DesktopOnboarding.vue?raw'
import modalSetupSource from '../src/components/DesktopModalSetup.vue?raw'

function bridge(overrides = {}) {
  return {
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'welcome', choice: 'local' }),
    setOnboardingState: vi.fn().mockResolvedValue({}),
    getLyricsLookup: vi.fn().mockResolvedValue({ enabled: false }),
    setLyricsLookup: vi.fn(async enabled => ({ enabled })),
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
    await setup.stop()
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
  it('keeps explicit route choice available after local installation is ready', async () => {
    const desktop = bridge({
      getSetupStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, ready: true, planId: 'installed' }),
    })
    const setup = useDesktopOnboarding(desktop)
    await setup.chooseProcessing()
    expect(setup.plan.value.ready).toBe(true)
    expect(setup.step.value).toBe('choose')
    await setup.refresh()
    expect(setup.step.value).toBe('choose')
    setup.choice.value = 'modal'
    await setup.continueChoice()
    expect(setup.step.value).toBe('modal')
    expect(desktop.startSetup).not.toHaveBeenCalled()
  })
  it.each(['ready', 'modal', 'choose'])('does not inherit local readiness when reopening Modal from %s', async savedStep => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: savedStep, choice: 'modal' }),
      getSetupStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, ready: true }),
      getModalStatus: vi.fn().mockResolvedValue({ active: false }),
    })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(setup.step.value).toBe(savedStep === 'choose' ? 'choose' : 'modal')
    await setup.refresh()
    expect(setup.step.value).not.toBe('ready')
    expect(desktop.getModalStatus).toHaveBeenCalledTimes(savedStep === 'choose' ? 1 : 2)
  })
  it('uses confirmed backend Modal activation for Modal readiness', async () => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'modal', choice: 'modal' }),
      getSetupStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      getModalStatus: vi.fn().mockResolvedValue({ active: true }),
    })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(setup.step.value).toBe('ready')
    await setup.refresh()
    expect(setup.step.value).toBe('ready')
    desktop.getModalStatus.mockResolvedValue({ active: false })
    await setup.refresh()
    expect(setup.step.value).toBe('modal')
  })
  it('preserves running and restart lifecycle with Modal selected without claiming local readiness afterward', async () => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'modal', choice: 'modal' }),
      getSetupStatus: vi.fn().mockResolvedValue({ state: 'running' }),
      getModalStatus: vi.fn().mockResolvedValue({ active: true }),
    })
    const setup = useDesktopOnboarding(desktop)
    await setup.initialize()
    expect(setup.step.value).toBe('progress')
    expect(desktop.getModalStatus).not.toHaveBeenCalled()
    await setup.chooseProcessing()
    expect(setup.step.value).toBe('progress')
    desktop.getSetupStatus.mockResolvedValue({ state: 'restart-required' })
    await setup.refresh()
    expect(setup.step.value).toBe('restart')
    desktop.getModalStatus.mockResolvedValue({ active: false })
    desktop.getSetupStatus.mockResolvedValue({ state: 'ready' })
    await setup.refresh()
    expect(setup.step.value).toBe('modal')
  })
  it('ignores a pending Modal response after a newer route selection', async () => {
    let resolveModal
    const desktop = bridge({
      getModalStatus: vi.fn(() => new Promise(resolve => { resolveModal = resolve })),
    })
    const setup = useDesktopOnboarding(desktop)
    setup.choice.value = 'modal'
    setup.step.value = 'modal'
    const pending = setup.refresh()
    await flushPromises()
    await setup.chooseProcessing()
    expect(setup.step.value).toBe('choose')
    resolveModal({ active: true })
    await pending
    expect(setup.step.value).toBe('choose')
  })
  it('ignores pending local readiness after a newer explicit route selection', async () => {
    let resolveStatus
    const desktop = bridge({ getSetupStatus: vi.fn(() => new Promise(resolve => { resolveStatus = resolve })) })
    const setup = useDesktopOnboarding(desktop)
    setup.step.value = 'progress'
    const pending = setup.refresh()
    await setup.chooseProcessing()
    resolveStatus({ state: 'ready' })
    await pending
    expect(setup.step.value).toBe('choose')
  })
  it('ignores a pending Modal response when the selected route changes directly', async () => {
    let resolveModal
    const desktop = bridge({ getModalStatus: vi.fn(() => new Promise(resolve => { resolveModal = resolve })) })
    const setup = useDesktopOnboarding(desktop)
    setup.choice.value = 'modal'
    setup.step.value = 'modal'
    const pending = setup.refresh()
    await flushPromises()
    setup.choice.value = 'local'
    resolveModal({ active: true })
    await pending
    expect(setup.step.value).toBe('modal')
  })
  it('shows bridge failures while leaving navigation available', async () => {
    const setup = useDesktopOnboarding(bridge({ preflightSetup: vi.fn().mockRejectedValue(new Error('Disk check failed')) }))
    expect(await setup.chooseProcessing()).toBe(false)
    expect(setup.error.value).toBe('Disk check failed')
    expect(setup.busy.value).toBe(false)
    expect(setup.localAvailable.value).toBe(false)
    expect(await setup.skip()).toBe(true)
  })
  it('invalidates a previous consent plan when a new preflight fails', async () => {
    const desktop = bridge()
    const setup = useDesktopOnboarding(desktop)
    expect(setup.localAvailable.value).toBe(false)
    await setup.chooseProcessing()
    await setup.continueChoice()
    expect(setup.canStart.value).toBe(true)
    desktop.preflightSetup.mockRejectedValueOnce(new Error('Hardware check failed'))
    expect(await setup.continueChoice()).toBe(false)
    expect(setup.canStart.value).toBe(false)
    expect(await setup.start()).toBe(false)
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await setup.continueChoice()
    expect(setup.canStart.value).toBe(true)
  })
})

describe('desktop setup screens', () => {
  it('offers a retry after failed preflight without recommending local setup', async () => {
    const desktop = bridge({ preflightSetup: vi.fn().mockRejectedValueOnce(new Error('Hardware check failed'))
      .mockResolvedValue({ available: true, planId: 'retry' }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.choice').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Hardware check failed')
    expect(wrapper.text()).not.toContain('Recommended')
    await wrapper.findAll('button').find(button => button.text() === 'Check local setup again').trigger('click')
    await flushPromises()
    expect(wrapper.find('.choice').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it('separates offline model copies from downloads without reducing disk requirements', async () => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: 'offline', modelSource: 'offline',
        diskRequiredBytes: 10 * 1024 ** 3, components: [
          { label: 'Runtime', sourceMode: 'catalog', bytes: 1024 ** 3 },
          { label: 'Models', sourceMode: 'offline', bytes: 4 * 1024 ** 3 },
        ] }),
    })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const facts = Object.fromEntries(wrapper.findAll('.facts > div').map(row => [row.find('dt').text(), row.find('dd').text()]))
    expect(facts['Transfer size']).toBe('1.0 GiB')
    expect(facts['Local model files']).toBe('4.0 GiB')
    expect(facts['Space needed']).toBe('10.0 GiB')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('shows the install location with its free space and changes it through the fixed desktop action', async () => {
    const first = { available: true, planId: 'plan-a', installLocation: '/data/karaoke', freeBytes: 20 * 1024 ** 3,
      diskRequiredBytes: 10 * 1024 ** 3, diskFreeBytes: 20 * 1024 ** 3, components: [] }
    const second = { ...first, planId: 'plan-b', installLocation: '/mnt/media/karaoke-tools', freeBytes: 300 * 1024 ** 3, diskFreeBytes: 300 * 1024 ** 3 }
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }),
      preflightSetup: vi.fn().mockResolvedValue(first),
      chooseInstallLocation: vi.fn().mockResolvedValue(second),
    })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const row = wrapper.find('[data-testid=onboarding-install-location]')
    expect(row.text()).toContain('Install to')
    expect(row.find('strong').text()).toBe('/data/karaoke')
    const facts = () => Object.fromEntries(wrapper.findAll('.facts > div').map(item => [item.find('dt').text(), item.find('dd').text()]))
    expect(facts().Available).toBe('20.0 GiB')
    const change = row.find('button')
    expect(change.text()).toBe('Change…')
    await change.trigger('click')
    await flushPromises()
    expect(desktop.chooseInstallLocation).toHaveBeenCalledTimes(1)
    expect(desktop.chooseInstallLocation).toHaveBeenCalledWith()
    expect(wrapper.find('[data-testid=onboarding-install-location] strong').text()).toBe('/mnt/media/karaoke-tools')
    expect(facts().Available).toBe('300.0 GiB')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await wrapper.find('.primary').trigger('click')
    await flushPromises()
    expect(desktop.startSetup).toHaveBeenCalledWith({ consent: true, planId: 'plan-b' })
    wrapper.unmount()
  })
  it('omits the install location row when the plan does not report one', async () => {
    const desktop = bridge({ getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('[data-testid=onboarding-install-location]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('states a private-smoke qualification before consent and nothing extra otherwise', async () => {
    const notice = 'Private test build: local processing in this build passed a single-song smoke test only.'
    for (const [qualificationScope, shown] of [['private-smoke', true], ['full', false], [null, false], [undefined, false]]) {
      const desktop = bridge({
        getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }),
        preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: `scope-${qualificationScope}`, qualificationScope,
          components: [{ label: 'Runtime', bytes: 1024, sources: ['https://example.test/runtime'] }] }),
      })
      globalThis.window.karaokeDesktop = desktop
      const wrapper = mount(DesktopOnboarding)
      await flushPromises()
      expect(wrapper.text()).toContain('Install the processing tools and models')
      expect(wrapper.text().includes(notice), String(qualificationScope)).toBe(shown)
      expect(wrapper.text().includes('full release qualification'), String(qualificationScope)).toBe(shown)
      expect(desktop.startSetup).not.toHaveBeenCalled()
      wrapper.unmount()
    }
  })
  it('warns before consenting to an unqualified hardware test without starting setup', async () => {
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: 'hardware-test', qualificationScope: 'hardware-test',
        components: [{ label: 'Runtime', bytes: 1024, sources: ['https://example.test/runtime'] }] }),
    })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('has not passed a real-song test or release qualification')
    expect(wrapper.text()).toContain('before enabling it')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    wrapper.unmount()
  })
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
    await wrapper.find('[data-testid=onboarding-lyrics-continue]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Save and check your connection')
    expect(desktop.startSetup).not.toHaveBeenCalled()
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('shows the setup stages with the current stage status, bar and compact count in a nonmodal card', async () => {
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running', phase: 'models', stage: 'models',
      message: 'Installing separation and Heart model files.', progress: { file: 'model.bin', received: 410, total: 1000 } }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('dialog').attributes('open')).toBeDefined()
    const stages = wrapper.findAll('[data-testid="onboarding-stages"] > li')
    expect(stages.map(stage => stage.find('span:not(.dot)').text())).toEqual(['Retrieve tools', 'Unpack and check', 'Models', 'Verify'])
    expect(stages.map(stage => stage.classes().includes('done'))).toEqual([true, true, false, false])
    expect(stages.map(stage => stage.find('.dot').text())).toEqual(['✓', '✓', '', ''])
    expect(stages[2].attributes('aria-current')).toBe('step')
    expect(wrapper.findAll('.detail')).toHaveLength(1)
    expect(stages[2].find('.status').text()).toBe('Installing separation and Heart model files.')
    expect(stages[2].find('progress').attributes('value')).toBe('41')
    expect(stages[2].find('.count').text()).toBe('41%')
    expect(wrapper.text()).not.toMatch(/bytes|1,000|410 \/|model\.bin|MiB|GiB/)
    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-cancel"]').exists()).toBe(false)
    expect(wrapper.find('.library').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-pause"]').text()).toBe('Pause')
    expect(wrapper.find('[data-testid="onboarding-stop"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('counts archive parts during retrieval and ticks stages as setup moves on', async () => {
    const cases = [
      [{ state: 'running', stage: 'retrieve', progress: { file: 'tools.pack.gz.002', phase: 'retrieve', part: 2, parts: 6, received: 410, total: 1000 } }, 0, 'part 2 of 6 · 41%'],
      [{ state: 'running', stage: 'retrieve', progress: { file: 'tools.pack.gz.001', phase: 'retrieve', part: 1, parts: 1, received: 100, total: 1000 } }, 0, '10%'],
      [{ state: 'running', stage: 'unpack', progress: { file: 'python/bin/python3', phase: 'extract', received: 750, total: 1000 } }, 1, '75%'],
      [{ state: 'running', stage: 'verify', message: 'Verifying all local processing components.' }, 3, null],
    ]
    for (const [status, current, count] of cases) {
      globalThis.window.karaokeDesktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue(status) })
      const wrapper = mount(DesktopOnboarding)
      await flushPromises()
      const stages = wrapper.findAll('[data-testid="onboarding-stages"] > li')
      expect(stages.map(stage => stage.classes().includes('done'))).toEqual([0, 1, 2, 3].map(index => index < current))
      expect(stages[current].classes()).toContain('current')
      if (count) expect(stages[current].find('.count').text()).toBe(count)
      else {
        expect(stages[current].find('.count').exists()).toBe(false)
        expect(stages[current].find('progress').attributes('value')).toBeUndefined()
      }
      expect(wrapper.text()).not.toContain(status.progress?.file ?? 'no file')
      expect(wrapper.text()).not.toMatch(/bytes|download/i)
      wrapper.unmount()
    }
  })
  it('pauses in place, offers Resume and a secondary stop, and resumes with the same request', async () => {
    const running = { state: 'running', phase: 'runtime', stage: 'retrieve', message: 'Installing the local processing runtime.',
      progress: { phase: 'retrieve', part: 2, parts: 6, received: 410, total: 1000 } }
    const pausedStatus = { ...running, state: 'paused', phase: 'paused', message: 'Setup paused.', retryable: true }
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue(running),
      pauseSetup: vi.fn().mockResolvedValue(pausedStatus),
      startSetup: vi.fn().mockResolvedValue(running) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const hook = id => wrapper.find(`[data-testid="${id}"]`)
    await hook('onboarding-pause').trigger('click')
    await flushPromises()
    expect(desktop.pauseSetup).toHaveBeenCalledOnce()
    expect(desktop.cancelSetup).not.toHaveBeenCalled()
    expect(hook('onboarding-dialog').attributes('data-step')).toBe('progress')
    expect(hook('onboarding-pause').text()).toBe('Resume')
    expect(hook('onboarding-stop').text()).toBe('Stop setup')
    expect(wrapper.find('.stages .status').text()).toBe('Setup paused.')
    expect(wrapper.find('.stages .count').text()).toBe('part 2 of 6 · 41%')
    expect(wrapper.find('.panel').classes()).toContain('paused')
    // Resuming needs a plan: one is checked first when the card was reopened mid-setup.
    await hook('onboarding-pause').trigger('click')
    await flushPromises()
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    expect(desktop.startSetup).toHaveBeenCalledWith({ consent: true, planId: 'plan-1' })
    expect(hook('onboarding-pause').text()).toBe('Pause')
    expect(hook('onboarding-stop').exists()).toBe(false)
    wrapper.unmount()
  })
  it('stopping a paused setup returns to the processing choice', async () => {
    const pausedStatus = { state: 'paused', phase: 'paused', stage: 'models', message: 'Setup paused.', retryable: true }
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue(pausedStatus),
      cancelSetup: vi.fn().mockResolvedValue({ state: 'idle', phase: 'preflight' }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding, { props: { open: false } })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('progress')
    desktop.getSetupStatus.mockResolvedValue({ state: 'idle', phase: 'preflight' })
    await wrapper.find('[data-testid="onboarding-stop"]').trigger('click')
    await flushPromises()
    expect(desktop.cancelSetup).toHaveBeenCalledOnce()
    expect(desktop.startSetup).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('choose')
    expect(wrapper.emitted('open')).toHaveLength(1)
    wrapper.unmount()
  })
  it('hides the card to a slim indicator and shows it again without touching setup', async () => {
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running', stage: 'models', message: 'Installing separation and Heart model files.',
      progress: { received: 410, total: 1000 } }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding, { attachTo: globalThis.document.body })
    await flushPromises()
    const hook = id => wrapper.find(`[data-testid="${id}"]`)
    const calls = () => ({ pause: desktop.pauseSetup?.mock.calls.length ?? 0, cancel: desktop.cancelSetup.mock.calls.length,
      start: desktop.startSetup.mock.calls.length, saved: desktop.setOnboardingState.mock.calls.length })
    const before = calls()
    await hook('onboarding-hide').trigger('click')
    await flushPromises()
    expect(hook('onboarding-stages').exists()).toBe(false)
    expect(hook('onboarding-mini').text()).toContain('Models')
    expect(hook('onboarding-mini').find('progress').attributes('value')).toBe('41')
    expect(globalThis.document.activeElement).toBe(hook('onboarding-show').element)
    expect(hook('onboarding-dialog').attributes('data-step')).toBe('progress')
    desktop.getSetupStatus.mockResolvedValue({ state: 'paused', stage: 'models', message: 'Setup paused.', progress: { received: 410, total: 1000 } })
    await wrapper.vm.$.setupState.setup.refresh()
    await flushPromises()
    expect(hook('onboarding-mini').text().replace(/\s+/g, ' ')).toContain('ModelsPaused')
    await hook('onboarding-show').trigger('click')
    await flushPromises()
    expect(hook('onboarding-mini').exists()).toBe(false)
    expect(hook('onboarding-stages').exists()).toBe(true)
    expect(globalThis.document.activeElement).toBe(hook('onboarding-hide').element)
    expect(calls()).toEqual(before)
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
    await wrapper.find('[data-testid=onboarding-lyrics-continue]').trigger('click')
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

describe('desktop setup after reopening', () => {
  const checking = { state: 'checking', phase: 'verification', message: 'Checking your local processing setup…', retryable: false }
  function deferred() {
    let resolve, reject
    const promise = new Promise((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }
  function reopened(outcome, extra = {}) {
    const pending = deferred()
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'progress', choice: 'local' }),
      getSetupStatus: vi.fn().mockResolvedValueOnce(checking).mockResolvedValue(outcome),
      preflightSetup: vi.fn(() => pending.promise),
      ...extra,
    })
    globalThis.window.karaokeDesktop = desktop
    return { desktop, pending }
  }
  const forbidden = text => expect(text).not.toMatch(/Setup cancelled\.|interrupted/i)

  it('shows a calm busy check while a slow verification runs, then goes straight to ready', async () => {
    const { desktop, pending } = reopened({ state: 'ready', restartRequired: false })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const dialog = wrapper.find('[data-testid="onboarding-dialog"]')
    expect(dialog.attributes('data-step')).toBe('checking')
    expect(dialog.attributes('aria-busy')).toBe('false')
    // The indeterminate progress conveys the check; a static busy live region would never be announced.
    expect(wrapper.find('[role="status"]').attributes('aria-busy')).toBeUndefined()
    expect(wrapper.find('[role="status"] progress').attributes('value')).toBeUndefined()
    expect(wrapper.text()).toContain('Checking your local processing setup…')
    forbidden(wrapper.text())
    expect(wrapper.find('[data-testid="onboarding-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-cancel"]').exists()).toBe(false)
    expect(wrapper.find('.alert').exists()).toBe(false)
    expect(wrapper.find('.library').attributes('disabled')).toBeUndefined()
    for (let tick = 0; tick < 5; tick += 1) { await flushPromises(); forbidden(wrapper.text()) }
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    pending.resolve({ available: true, ready: true, components: [] })
    await flushPromises()
    expect(dialog.attributes('data-step')).toBe('ready')
    expect(dialog.attributes('aria-busy')).toBe('false')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    forbidden(wrapper.text())
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    expect(desktop.startSetup).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('lands on the retryable error path with honest copy when verification fails', async () => {
    const message = 'Review setup to check and repair the installation.'
    const { pending } = reopened({ state: 'error', phase: 'verification', message, error: message, retryable: true })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    pending.resolve({ available: true, ready: false, restartRequired: false, planId: 'repair', components: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('error')
    expect(wrapper.find('h1').text()).toBe('Local processing could not be verified.')
    expect(wrapper.text()).toContain(message)
    forbidden(wrapper.text())
    expect(wrapper.find('[data-testid="onboarding-retry"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it('never claims cancellation when the verification request itself fails', async () => {
    const { pending } = reopened(checking)
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    pending.reject(new Error('Setup service unavailable'))
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('error')
    expect(wrapper.find('h1').text()).toBe('Local processing could not be verified.')
    expect(wrapper.text()).toContain('Review setup to check and repair the installation.')
    expect(wrapper.text()).toContain('Setup service unavailable')
    forbidden(wrapper.text())
    wrapper.unmount()
  })
  it('shows the restart step when verification still requires reopening', async () => {
    const { pending } = reopened({ state: 'restart-required', restartRequired: true })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    pending.resolve({ available: true, ready: false, restartRequired: true, components: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('restart')
    expect(wrapper.find('[data-testid="onboarding-restart"]').exists()).toBe(true)
    wrapper.unmount()
  })
  // The library hosts the wizard and closes it on `close`, as the app shell does.
  const Host = defineComponent(() => {
    const open = ref(true)
    return () => (open.value ? h(DesktopOnboarding, { onClose: () => { open.value = false } }) : h('p', 'Library'))
  })
  it('lets a user leave during the check without reopening setup or starting a poll', async () => {
    const { desktop, pending } = reopened({ state: 'ready' })
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const wrapper = mount(Host)
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('checking')
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(desktop.setOnboardingState).toHaveBeenLastCalledWith({ step: 'choose', choice: 'local', skipped: true })
    expect(wrapper.find('[data-testid="onboarding-dialog"]').exists()).toBe(false)
    pending.resolve({ available: true, ready: true })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('Library')
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1500)).toHaveLength(0)
    expect(desktop.setOnboardingState).toHaveBeenCalledOnce()
    intervals.mockRestore()
    wrapper.unmount()
  })
  it('still settles the check when leaving fails and the check screen stays', async () => {
    const { desktop, pending } = reopened({ state: 'ready' }, { setOnboardingState: vi.fn().mockRejectedValue(new Error('Could not save')) })
    const wrapper = mount(Host)
    await flushPromises()
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Could not save')
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('checking')
    pending.resolve({ available: true, ready: true })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('ready')
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('starts the poll only after a check that settles while mounted', async () => {
    const { pending } = reopened({ state: 'ready' })
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1500)).toHaveLength(0)
    pending.resolve({ available: true, ready: true })
    await flushPromises()
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1500)).toHaveLength(1)
    intervals.mockRestore()
    wrapper.unmount()
  })
  it('a remounted wizard joins the check still running in the setup service', async () => {
    // Mirrors the setup service: preflights during a check share one verification.
    const verification = deferred()
    let state = checking, verifications = 0, shared = null
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'progress', choice: 'local' }),
      getSetupStatus: vi.fn(async () => state),
      preflightSetup: vi.fn(() => {
        if (state.state !== 'checking') return Promise.resolve({ available: true, ready: true })
        shared ??= (verifications += 1, verification.promise.then(plan => { state = { state: 'ready' }; return plan }))
        return shared
      }),
    })
    globalThis.window.karaokeDesktop = desktop
    const first = mount(Host)
    await flushPromises()
    await first.find('.library').trigger('click')
    await flushPromises()
    const second = mount(DesktopOnboarding)
    await flushPromises()
    expect(second.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('checking')
    forbidden(second.text())
    verification.resolve({ available: true, ready: true })
    await flushPromises()
    expect(second.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('ready')
    expect(first.find('[data-testid="onboarding-dialog"]').exists()).toBe(false)
    expect(desktop.preflightSetup).toHaveBeenCalledTimes(2)
    expect(verifications).toBe(1)
    first.unmount(); second.unmount()
  })
  it('shows readiness from the plan when the settled status cannot be read', async () => {
    const { desktop, pending } = reopened({ state: 'ready' })
    const setup = useDesktopOnboarding(desktop)
    const initialized = setup.initialize()
    await flushPromises()
    desktop.getSetupStatus.mockRejectedValue(new Error('status unavailable'))
    pending.resolve({ available: true, ready: true })
    await initialized
    expect(setup.step.value).toBe('ready')
    expect(setup.error.value).toBe('')
  })
  it('does not show a failure alert on ready when live verification already settled ready', async () => {
    const { pending } = reopened({ state: 'ready', restartRequired: false })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    pending.reject(new Error('Reply lost'))
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('ready')
    expect(wrapper.find('.alert').exists()).toBe(false)
    wrapper.unmount()
  })
  it('a status refresh that finds a check starts and settles it', async () => {
    const pending = deferred()
    const desktop = bridge({
      getSetupStatus: vi.fn().mockResolvedValueOnce(checking).mockResolvedValue({ state: 'ready' }),
      preflightSetup: vi.fn(() => pending.promise),
    })
    const setup = useDesktopOnboarding(desktop)
    setup.step.value = 'progress'
    const refreshed = setup.refresh()
    await flushPromises()
    expect(setup.step.value).toBe('checking')
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    pending.resolve({ available: true, ready: true })
    await refreshed
    expect(setup.step.value).toBe('ready')
  })
  it('shares one verification when status is refreshed during a check', async () => {
    const { desktop, pending } = reopened(checking)
    const setup = useDesktopOnboarding(desktop)
    const initialized = setup.initialize()
    await flushPromises()
    const refreshed = setup.refresh()
    await flushPromises()
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
    desktop.getSetupStatus.mockResolvedValue({ state: 'ready' })
    pending.resolve({ available: true, ready: true })
    await Promise.all([initialized, refreshed])
    expect(setup.step.value).toBe('ready')
    expect(desktop.preflightSetup).toHaveBeenCalledOnce()
  })
  it('keeps interrupted checkpoints on the existing cancelled path', async () => {
    globalThis.window.karaokeDesktop = bridge({
      getSetupStatus: vi.fn().mockResolvedValue({ state: 'cancelled', message: 'Setup was interrupted. Retry to verify and resume saved files.', retryable: true }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, ready: false, planId: 'resume', components: [] }),
    })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('error')
    expect(wrapper.text()).toContain('Setup cancelled.')
    wrapper.unmount()
  })
})

describe('desktop setup test hooks and sizes', () => {
  it('exposes stable hooks through the setup sequence', async () => {
    const desktop = bridge()
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const hook = id => wrapper.find(`[data-testid="${id}"]`)
    expect(hook('onboarding-dialog').attributes('data-step')).toBe('welcome')
    await hook('onboarding-get-started').trigger('click')
    await flushPromises()
    expect(hook('onboarding-choice-local').exists()).toBe(true)
    await hook('onboarding-continue').trigger('click')
    await flushPromises()
    await hook('onboarding-lyrics-continue').trigger('click')
    await flushPromises()
    expect(hook('onboarding-consent-components').text()).toContain('Processing model')
    await hook('onboarding-install').trigger('click')
    await flushPromises()
    expect(hook('onboarding-dialog').attributes('data-step')).toBe('progress')
    expect(hook('onboarding-pause').exists()).toBe(true)
    expect(hook('onboarding-hide').exists()).toBe(true)
    wrapper.unmount()
  })
  it('names retrieval and installed sizes only where they differ', async () => {
    globalThis.window.karaokeDesktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'consent', choice: 'local' }),
      preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: 'sizes', components: [
        { label: 'Local processing runtime', bytes: 543 * 1024 ** 2, installedBytes: 1.9 * 1024 ** 3, sources: ['https://example.test/runtime'] },
        { label: 'Same size runtime', bytes: 5 * 1024 ** 2, installedBytes: 5 * 1024 ** 2, sources: ['https://example.test/same'] },
        { label: 'Processing model', bytes: 1024, sources: ['https://example.test/model'] },
      ] }),
    })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    const rows = wrapper.find('[data-testid="onboarding-consent-components"]').findAll('li').map(row => row.text().replace(/\s+/g, ' '))
    expect(rows[0]).toContain(`Local processing runtime · 543 MiB (${(543 * 1024 ** 2).toLocaleString()} bytes) to retrieve, 1.9 GiB installed`)
    expect(rows[1]).toContain(`Same size runtime · 5 MiB (${(5 * 1024 ** 2).toLocaleString()} bytes)Source`)
    expect(rows[1]).not.toContain('installed')
    expect(rows[2]).toContain('Processing model · 1 MiB (1,024 bytes)Source')
    expect(rows[2]).not.toContain('installed')
    wrapper.unmount()
  })
})

describe('optional lookup and background setup', () => {
  it('keeps lookup off until explicit save, preserves errors, and returns to welcome', async () => {
    const desktop = bridge()
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    await wrapper.find('[data-testid=onboarding-get-started]').trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '← Back to welcome').trigger('click')
    await flushPromises()
    expect(wrapper.find('dialog').attributes('data-step')).toBe('welcome')
    await wrapper.find('[data-testid=onboarding-get-started]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid=onboarding-continue]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=onboarding-lrclib]').element.checked).toBe(false)
    expect(desktop.setLyricsLookup).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('LRCLIB is a third-party lyrics service.')
    await wrapper.find('[data-testid=onboarding-lrclib]').setValue(true)
    desktop.setLyricsLookup.mockRejectedValueOnce(new Error('Could not save preference'))
    await wrapper.find('[data-testid=onboarding-lyrics-continue]').trigger('click')
    await flushPromises()
    expect(wrapper.find('dialog').attributes('data-step')).toBe('lyrics')
    expect(wrapper.text()).toContain('Could not save preference')
    await wrapper.find('[data-testid=onboarding-lyrics-continue]').trigger('click')
    await flushPromises()
    expect(desktop.setLyricsLookup).toHaveBeenLastCalledWith(true)
    expect(wrapper.emitted('lyrics-saved')).toHaveLength(1)
    expect(wrapper.find('[data-testid=onboarding-installation-notices]').attributes('open')).toBeUndefined()
    expect(desktop.startSetup).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('retains progress while the library is open, then allows dismissing ready and reopening preferences', async () => {
    vi.useFakeTimers()
    const desktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running' }) })
    globalThis.window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding, { props: { open: false } })
    await flushPromises()
    expect(wrapper.find('dialog').attributes('open')).toBeDefined()
    expect(wrapper.find('dialog').attributes('aria-modal')).toBe('false')
    expect(wrapper.find('dialog').classes()).toContain('compact')
    desktop.getSetupStatus.mockResolvedValue({ state: 'ready' })
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(wrapper.find('dialog').attributes('data-step')).toBe('ready')
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(wrapper.find('dialog').attributes('open')).toBeUndefined()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.find('dialog').attributes('data-step')).toBe('choose')
    expect(wrapper.find('dialog').attributes('aria-modal')).toBe('true')
    wrapper.unmount()
  })
})


it('refreshes lookup preferences even when the following installation preflight fails', async () => {
  const desktop = bridge({
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'lyrics' }),
    preflightSetup: vi.fn().mockRejectedValue(new Error('Disk unavailable')),
  })
  globalThis.window.karaokeDesktop = desktop
  const wrapper = mount(DesktopOnboarding)
  await flushPromises()
  await wrapper.find('[data-testid=onboarding-lrclib]').setValue(true)
  await wrapper.find('[data-testid=onboarding-lyrics-continue]').trigger('click')
  await flushPromises()
  expect(desktop.setLyricsLookup).toHaveBeenCalledWith(true)
  expect(wrapper.emitted('lyrics-saved')).toHaveLength(1)
  expect(wrapper.text()).toContain('Disk unavailable')
  wrapper.unmount()
})

it('shows a qualitative machine rating and estimated three-minute-track range with the real settings path', async () => {
  globalThis.window.karaokeDesktop = bridge({
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose' }),
    preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: 'estimated',
      processingEstimate: { level: 2, label: 'Moderate', minutes: [9, 16], evidence: 'measured',
        basis: 'These tools and models use the CPU, even if your computer has a graphics card. Based on one measured run on a 16-core desktop processor; computers with fewer cores may take longer.' } }),
  })
  const wrapper = mount(DesktopOnboarding)
  await flushPromises()
  const estimate = wrapper.find('[aria-label="Local processing estimate"]')
  expect(estimate.text()).toContain('Estimated processing time*')
  expect(estimate.text()).not.toMatch(/rough/i)
  expect(estimate.text()).toContain('9–16 minutes to prepare a 3-minute track')
  expect(wrapper.text()).not.toContain('These tools and models use')
  expect(wrapper.text()).not.toContain('Estimate for vocal separation')
  expect(wrapper.find('.speed-bar').attributes('aria-label')).toBe('Estimated processing speed: Moderate')
  expect(wrapper.findAll('.speed-bar .filled')).toHaveLength(2)
  expect(wrapper.text()).toContain('*Actual processing time varies by hardware and song.')
  expect(wrapper.text()).toContain('You can enable Modal later via Settings → Song processing… → My Modal account.')
  wrapper.unmount()
})

it('shows extrapolated estimates with the same calm variability note', async () => {
  globalThis.window.karaokeDesktop = bridge({
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose' }),
    preflightSetup: vi.fn().mockResolvedValue({ available: true, planId: 'estimated',
      processingEstimate: { level: 3, label: 'Faster', minutes: [1, 3], evidence: 'extrapolated',
        basis: 'These tools and models use your NVIDIA graphics card; the range is extrapolated from published component timings.' } }),
  })
  const wrapper = mount(DesktopOnboarding)
  await flushPromises()
  const estimate = wrapper.find('[aria-label="Local processing estimate"]')
  expect(estimate.text()).toContain('1–3 minutes to prepare a 3-minute track')
  expect(estimate.text()).not.toContain('uses your NVIDIA graphics card')
  expect(wrapper.findAll('.speed-bar .filled')).toHaveLength(3)
  expect(wrapper.text()).not.toContain('Extrapolated estimate')
  expect(wrapper.text()).toContain('*Actual processing time varies by hardware and song.')
  wrapper.unmount()
})

describe('processing choice summary', () => {
  const GiB = 1024 ** 3
  const estimatedPlan = {
    available: true, planId: 'estimated', diskFreeBytes: 412.6 * GiB,
    hardware: { platform: 'linux', arch: 'x64', cpu: 'Synthetic 8-core processor', cpuCount: 16,
      totalMemoryBytes: 31.2 * GiB, availableMemoryBytes: 22.4 * GiB, gpu: 'Synthetic graphics',
      gpuDevices: [{ name: 'Synthetic graphics', dedicatedMemoryBytes: 12 * GiB }] },
    processingEstimate: { level: 3, label: 'Faster', minutes: [1, 3], evidence: 'extrapolated',
      basis: 'These tools and models use your graphics card.' },
  }
  async function mountChoice(plan = estimatedPlan) {
    globalThis.window.karaokeDesktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose' }),
      preflightSetup: vi.fn().mockResolvedValue(plan),
    })
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    return wrapper
  }
  const modalCard = wrapper => wrapper.findAll('.choice').find(button => button.text().includes('My Modal account'))

  it('shows one local container with a hardware strip, the estimate bar, and its footnote', async () => {
    const wrapper = await mountChoice()
    const estimate = wrapper.find('[aria-label="Local processing estimate"]')
    const strip = estimate.find('dl[aria-label="Computer details"]')
    expect(strip.findAll('dt').map(term => term.text())).toEqual(['CPU', 'GPU', 'RAM', 'Free disk'])
    expect(strip.findAll('dd').map(value => value.text())).toEqual(
      ['Synthetic 8-core processor', 'Synthetic graphics · 12.0 GiB', '31.2 GiB', '412.6 GiB'])
    expect(strip.attributes('title')).toContain('Operating system: Linux · x64')
    expect(estimate.text()).toContain('Estimated processing time*')
    expect(estimate.text()).toContain('1–3 minutes to prepare a 3-minute track')
    expect(estimate.find('.speed-bar').exists()).toBe(true)
    expect(estimate.text()).toContain('*Actual processing time varies by hardware and song.')
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-modal-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-modal-footnote"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="onboarding-continue"]').text()).toBe('Continue →')
    wrapper.unmount()
  })

  it('omits unknown sizes from the hardware strip', async () => {
    const wrapper = await mountChoice({ ...estimatedPlan, diskFreeBytes: null,
      hardware: { ...estimatedPlan.hardware, gpuDevices: [{ name: 'Synthetic graphics', dedicatedMemoryBytes: null }] } })
    const strip = wrapper.find('dl[aria-label="Computer details"]')
    expect(strip.findAll('dt').map(term => term.text())).toEqual(['CPU', 'GPU', 'RAM'])
    expect(strip.findAll('dd').map(value => value.text())).toEqual(['Synthetic 8-core processor', 'Synthetic graphics', '31.2 GiB'])
    expect(strip.text()).not.toContain('Not yet known')
    wrapper.unmount()
  })

  it('shows memory qualification warnings inside the local estimate', async () => {
    const wrapper = await mountChoice({ ...estimatedPlan,
      memoryQualification: { status: 'meets-measured-requirements', reason: 'Synthetic reason.', warnings: ['Synthetic memory warning.'] } })
    const warning = wrapper.find('[aria-label="Local processing estimate"]').findAll('p.quiet').find(line => line.text() === 'Synthetic memory warning.')
    expect(warning).toBeTruthy()
    wrapper.unmount()
  })

  it('swaps the local estimate for the Modal usage summary when Modal is chosen', async () => {
    const wrapper = await mountChoice()
    await modalCard(wrapper).trigger('click')
    expect(wrapper.find('[aria-label="Local processing estimate"]').exists()).toBe(false)
    expect(wrapper.find('.speed-bar').exists()).toBe(false)
    expect(wrapper.find('.estimate-range').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Estimated processing time')
    expect(wrapper.text()).not.toContain('You can enable Modal later')
    const summary = wrapper.find('[data-testid="onboarding-modal-summary"]')
    expect(summary.attributes('aria-label')).toBe('My Modal account')
    expect(summary.text()).toContain('Processing runs in your own Modal account. Audio needed for processing is sent to that deployment.')
    expect(summary.text()).toContain('At the time of writing, $30 of monthly usage is included with a Modal account*')
    expect(summary.text()).toContain('Roughly 200 or more 3–4 minute songs per $30')
    expect(wrapper.find('[data-testid="onboarding-continue"]').text()).toBe('Connect Modal account →')
    expect(wrapper.find('[data-testid="onboarding-modal-footnote"]').text()).toBe('*Subject to change. See Modal’s current pricing and terms.')
    await wrapper.find('[data-testid="onboarding-choice-local"]').trigger('click')
    expect(wrapper.find('[aria-label="Local processing estimate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="onboarding-modal-summary"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

it('uses "tools and models" instead of "pack" in setup copy', () => {
  for (const [name, raw] of [['DesktopOnboarding.vue', onboardingSource], ['DesktopModalSetup.vue', modalSetupSource]]) {
    const source = raw.replace(/<style[\s\S]*?<\/style>/g, '')
    expect(source, name).not.toMatch(/\bpacks?\b/i)
  }
})

it('does not invent a range when the desktop supplies no estimate', async () => {
  globalThis.window.karaokeDesktop = bridge({ getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose' }) })
  const wrapper = mount(DesktopOnboarding)
  await flushPromises()
  expect(wrapper.findAll('.speed-bar .filled')).toHaveLength(0)
  expect(wrapper.find('.estimate-range').exists()).toBe(false)
  expect(wrapper.text()).toContain('A time estimate is unavailable for this setup.')
  wrapper.unmount()
})

describe('responsive setup planning', () => {
  it('shows pending feedback and an enabled library exit while reopening preferences', async () => {
    let resolvePlan
    const desktop = bridge({
      getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose', choice: 'local' }),
      preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })),
    })
    window.karaokeDesktop = desktop
    const wrapper = mount(DesktopOnboarding)
    await flushPromises()
    expect(wrapper.find('[role="status"]').text()).toContain('Checking your local processing setup')
    expect(wrapper.find('.library').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="onboarding-continue"]').attributes('disabled')).toBeDefined()
    await wrapper.find('.library').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    resolvePlan({ available: true, ready: true, planId: 'late' })
    await flushPromises()
    expect(wrapper.find('[data-testid="onboarding-dialog"]').attributes('data-step')).toBe('choose')
    wrapper.unmount()
  })

  it('keeps the library reachable during a slow lyrics continuation and ignores its late result', async () => {
    let resolvePlan
    const desktop = bridge({ preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })) })
    const setup = useDesktopOnboarding(desktop)
    await setup.chooseLyrics()
    await setup.saveLyrics()
    const pending = setup.continueChoice()
    expect(setup.planning.value).toBe(true)
    expect(setup.busy.value).toBe(false)
    expect(setup.canStart.value).toBe(false)
    expect(await setup.skip()).toBe(true)
    resolvePlan({ available: true, ready: true, planId: 'late' })
    expect(await pending).toBe(false)
    expect(setup.step.value).toBe('lyrics')
    expect(setup.plan.value).toBe(null)
    expect(desktop.startSetup).not.toHaveBeenCalled()
  })

  it('does not let an older choice check replace a newer route', async () => {
    let resolvePlan
    const desktop = bridge({ preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })) })
    const setup = useDesktopOnboarding(desktop)
    const pending = setup.chooseProcessing()
    expect(setup.busy.value).toBe(false)
    setup.choice.value = 'modal'
    await setup.continueChoice()
    resolvePlan({ available: true, ready: true, planId: 'late' })
    await pending
    expect(setup.step.value).toBe('modal')
    expect(setup.plan.value).toBe(null)
    expect(setup.planning.value).toBe(false)
  })
})


describe('planning result and persistence failures', () => {
  it('retains local availability when the choice changes during the same choice screen', async () => {
    let resolvePlan
    const desktop = bridge({ preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })) })
    const setup = useDesktopOnboarding(desktop)
    const pending = setup.chooseProcessing()
    setup.choice.value = 'modal'
    resolvePlan({ available: true, ready: true, planId: 'available' })
    expect(await pending).toBe(true)
    expect(setup.localAvailable.value).toBe(true)
    expect(setup.choice.value).toBe('modal')
    expect(setup.step.value).toBe('choose')
  })

  it('reports failure saving the consent screen after planning navigates there', async () => {
    const desktop = bridge({ setOnboardingState: vi.fn().mockRejectedValue(new Error('Preferences could not be saved')) })
    const setup = useDesktopOnboarding(desktop)
    expect(await setup.continueChoice()).toBe(false)
    expect(setup.step.value).toBe('consent')
    expect(setup.error.value).toBe('Preferences could not be saved')
  })

  it('ignores a persistence failure after dismissal supersedes the applied plan', async () => {
    let rejectSave
    const desktop = bridge({ setOnboardingState: vi.fn()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectSave = reject }))
      .mockResolvedValue({}) })
    const setup = useDesktopOnboarding(desktop)
    const pending = setup.continueChoice()
    await flushPromises()
    expect(setup.step.value).toBe('consent')
    await setup.skip()
    rejectSave(new Error('Late save failure'))
    await pending
    expect(setup.error.value).toBe('')
  })
})


it('retains availability without navigating when the restored choice changes during initialization', async () => {
  let resolvePlan
  const desktop = bridge({
    getOnboardingState: vi.fn().mockResolvedValue({ step: 'choose', choice: 'local' }),
    preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })),
  })
  const setup = useDesktopOnboarding(desktop)
  const pending = setup.initialize()
  await flushPromises()
  expect(setup.step.value).toBe('choose')
  setup.choice.value = 'modal'
  resolvePlan({ available: true, ready: true, planId: 'restored-available' })
  await pending
  expect(setup.localAvailable.value).toBe(true)
  expect(setup.choice.value).toBe('modal')
  expect(setup.step.value).toBe('choose')
})


it.each(['ready', 'restart', 'progress'])('retains availability when %s restores to choose and the route changes', async savedStep => {
  let resolvePlan
  const desktop = bridge({
    getOnboardingState: vi.fn().mockResolvedValue({ step: savedStep, choice: 'local' }),
    getSetupStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
    preflightSetup: vi.fn(() => new Promise(resolve => { resolvePlan = resolve })),
  })
  const setup = useDesktopOnboarding(desktop)
  const pending = setup.initialize()
  await flushPromises()
  expect(setup.step.value).toBe('choose')
  setup.choice.value = 'modal'
  resolvePlan({ available: true, ready: true, planId: 'effective-choice' })
  await pending
  expect(setup.localAvailable.value).toBe(true)
  expect(setup.choice.value).toBe('modal')
  expect(setup.step.value).toBe('choose')
})
