// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
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
  it('describes processing tools archive retrieval and unpacking from structured progress fields', async () => {
    const cases = [
      [{ file: 'tools.pack.gz.002', phase: 'retrieve', part: 2, parts: 3, received: 500, total: 1000 },
        'Retrieving the processing tools archive, part 2 of 3 · 500 / 1,000 bytes (50% of this part)'],
      [{ file: 'tools.pack.gz.001', phase: 'retrieve', received: 100, total: 1000 },
        'Retrieving the processing tools archive · 100 / 1,000 bytes (10% of this part)'],
      [{ file: 'python/bin/python3', phase: 'extract', received: 750, total: 1000 },
        'Unpacking and checking processing tools · 750 / 1,000 bytes (75% of the processing tools)'],
    ]
    for (const [progress, line] of cases) {
      globalThis.window.karaokeDesktop = bridge({ getSetupStatus: vi.fn().mockResolvedValue({ state: 'running', progress }) })
      const wrapper = mount(DesktopOnboarding)
      await flushPromises()
      expect(wrapper.find('.quiet').text().replace(/\s+/g, ' ')).toBe(line)
      expect(wrapper.text()).not.toContain(progress.file)
      expect(wrapper.text()).not.toMatch(/download/i)
      wrapper.unmount()
    }
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
    expect(wrapper.find('[role="status"]').attributes('aria-busy')).toBe('true')
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
    const desktop = bridge({ cancelSetup: vi.fn().mockResolvedValue({ state: 'cancelled' }) })
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
    expect(hook('onboarding-consent-components').text()).toContain('Processing model')
    await hook('onboarding-install').trigger('click')
    await flushPromises()
    expect(hook('onboarding-dialog').attributes('data-step')).toBe('progress')
    expect(hook('onboarding-setup-controls').exists()).toBe(true)
    await hook('onboarding-cancel').trigger('click')
    await flushPromises()
    expect(hook('onboarding-retry').exists()).toBe(true)
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
