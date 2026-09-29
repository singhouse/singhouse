// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DesktopModalSetup from '../src/components/DesktopModalSetup.vue'
function bridge(overrides = {}) {
  return {
    getModalStatus: vi.fn().mockResolvedValue({ configured: true, safeStore: true }),
    saveModalConfig: vi.fn().mockResolvedValue({ configured: true }),
    checkModalConnection: vi.fn().mockResolvedValue({ schema: 1, accessChecked: true, compatible: true, qualified: false, ready: false, stages: [] }),
    forgetModalConfig: vi.fn().mockResolvedValue({}), openSetupHelp: vi.fn().mockResolvedValue({}), ...overrides,
  }
}
async function filled(wrapper) {
  for (const [name, value] of Object.entries({ app: 'my-app', environment: 'main', version: '1', tokenId: 'private-id', tokenSecret: 'private-secret' })) await wrapper.find(`[name="${name}"]`).setValue(value)
}
function button(wrapper, label) { return wrapper.findAll('button').find(item => item.text() === label) }
async function view(desktop) { const wrapper = mount(DesktopModalSetup, { props: { bridge: desktop } }); await flushPromises(); return wrapper }
describe('desktop Modal configuration', () => {
  it('loads status without checking or granting consent and uses fixed help topics', async () => {
    const desktop = bridge(), wrapper = await view(desktop)
    expect(desktop.getModalStatus).toHaveBeenCalledOnce()
    expect(desktop.checkModalConnection).not.toHaveBeenCalled()
    expect(wrapper.findAll('input[type="checkbox"]').every(input => !input.element.checked)).toBe(true)
    for (const [label, topic] of [['Open account guide ↗', 'account'], ['Review current pricing ↗', 'pricing'], ['Open deployment guide ↗', 'deployment']]) {
      await button(wrapper, label).trigger('click'); await flushPromises()
      expect(desktop.openSetupHelp).toHaveBeenLastCalledWith(topic)
    }
    wrapper.unmount()
  })
  it('saves unchecked permissions and clears password fields', async () => {
    let captured
    const desktop = bridge({ saveModalConfig: vi.fn(async value => { captured = structuredClone(value) }) }), wrapper = await view(desktop)
    await filled(wrapper)
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(2)
    await wrapper.find('form').trigger('submit'); await flushPromises()
    expect(captured).toEqual({ app: 'my-app', environment: 'main', version: 1, tokenId: 'private-id', tokenSecret: 'private-secret', consent: { uploads: false, usage: false } })
    expect(wrapper.find('[name="tokenId"]').element.value).toBe('')
    expect(wrapper.find('[name="tokenSecret"]').element.value).toBe('')
    expect(desktop.checkModalConnection).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Configuration saved for later')
    wrapper.unmount()
  })
  it('separates access and compatible metadata from qualification', async () => {
    const desktop = bridge(), wrapper = await view(desktop)
    await button(wrapper, 'Check saved connection').trigger('click'); await flushPromises()
    expect(desktop.checkModalConnection).toHaveBeenCalledWith()
    expect(wrapper.text()).toContain('Account access verified')
    expect(wrapper.text()).toContain('Processing is not yet qualified')
    expect(wrapper.text()).toContain('This check does not enable processing')
    desktop.checkModalConnection.mockResolvedValue({ schema: 1, accessChecked: true, compatible: false, qualified: false, ready: false })
    await button(wrapper, 'Check saved connection').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('compatibility has not been established')
    desktop.checkModalConnection.mockRejectedValue(new Error('private-secret'))
    await button(wrapper, 'Check saved connection').trigger('click'); await flushPromises()
    expect(wrapper.text()).not.toContain('Account access verified')
    expect(wrapper.find('[role="alert"]').text()).toContain('could not be checked')
    expect(wrapper.text()).not.toContain('private-secret')
    wrapper.unmount()
  })
  it('clears credentials on failed save and unmount and sanitizes errors', async () => {
    const desktop = bridge({ saveModalConfig: vi.fn().mockRejectedValue(new Error('private-secret')) }), wrapper = await view(desktop)
    await filled(wrapper)
    await wrapper.find('form').trigger('submit'); await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('could not be saved')
    expect(wrapper.text()).not.toContain('private-secret')
    expect(wrapper.find('[name="tokenSecret"]').element.value).toBe('')
    await filled(wrapper)
    const input = wrapper.find('[name="tokenSecret"]').element
    wrapper.unmount()
    expect(input.value).toBe('')
  })
  it('forgets local credentials with an accurate remote-job warning', async () => {
    const desktop = bridge(), wrapper = await view(desktop)
    await filled(wrapper)
    await button(wrapper, 'Forget local credentials').trigger('click'); await flushPromises()
    expect(desktop.forgetModalConfig).toHaveBeenCalledWith()
    expect(wrapper.find('[name="tokenSecret"]').element.value).toBe('')
    expect(wrapper.text()).toContain('does not revoke your remote token or stop running jobs')
    expect(desktop.checkModalConnection).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('blocks saving when secure storage is unavailable', async () => {
    const desktop = bridge({ getModalStatus: vi.fn().mockResolvedValue({ configured: false, safeStore: false }) }), wrapper = await view(desktop)
    await filled(wrapper)
    await wrapper.find('form').trigger('submit')
    expect(desktop.saveModalConfig).not.toHaveBeenCalled()
    expect(button(wrapper, 'Save configuration').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('continues only with an active backend connection without another cloud check', async () => {
    const desktop = bridge({ getModalStatus: vi.fn().mockResolvedValue({ configured: true, safeStore: true, active: true, releaseSupported: true }) })
    const wrapper = await view(desktop)
    await button(wrapper, 'Continue →').trigger('click')
    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(button(wrapper, 'Restart to apply saved settings')).toBeUndefined()
    expect(desktop.checkModalConnection).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('requests a guarded restart without claiming readiness', async () => {
    const desktop = bridge({ getModalStatus: vi.fn().mockResolvedValue({ configured: true, safeStore: true, active: false, releaseSupported: true }) })
    const wrapper = await view(desktop)
    expect(button(wrapper, 'Continue →')).toBeUndefined()
    await button(wrapper, 'Restart to apply saved settings').trigger('click')
    expect(wrapper.emitted('restart')).toHaveLength(1)
    expect(wrapper.emitted('ready')).toBeUndefined()
    expect(desktop.checkModalConnection).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('does not suggest restarting an unsupported deployment into readiness', async () => {
    const wrapper = await view(bridge())
    expect(button(wrapper, 'Continue →')).toBeUndefined()
    expect(button(wrapper, 'Restart to apply saved settings')).toBeUndefined()
    wrapper.unmount()
  })
  it('can remove unreadable credentials without requiring the unavailable keyring', async () => {
    const desktop = bridge({ getModalStatus: vi.fn().mockResolvedValue({ configured: false, safeStore: false, error: 'unavailable' }),
      forgetModalConfig: vi.fn().mockResolvedValue({ configured: false, error: null }) })
    const wrapper = await view(desktop)
    expect(button(wrapper, 'Forget local credentials').attributes('disabled')).toBeUndefined()
    await button(wrapper, 'Forget local credentials').trigger('click'); await flushPromises()
    expect(desktop.forgetModalConfig).toHaveBeenCalledOnce()
    expect(desktop.getModalStatus).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Local credentials removed')
    wrapper.unmount()
  })
})
