// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref } from 'vue'

const steps = new Set(['welcome', 'choose', 'consent', 'modal', 'progress', 'error', 'restart', 'ready'])

export function useDesktopOnboarding(bridge = globalThis.window?.karaokeDesktop) {
  const step = ref('welcome')
  const choice = ref('local')
  const plan = ref(null)
  const status = ref(null)
  const busy = ref(false)
  const error = ref('')
  const localAvailable = computed(() => plan.value?.available !== false)
  const canStart = computed(() => plan.value?.available === true && !!plan.value?.planId && !busy.value)

  async function persist(skipped = false) {
    await bridge.setOnboardingState({ step: step.value, choice: choice.value, skipped })
  }
  async function guarded(action) {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    try { await action(); return true } catch (cause) {
      error.value = cause?.message || 'Setup could not continue. Please try again.'
      return false
    } finally { busy.value = false }
  }
  function applyStatus(next) {
    status.value = next
    if (next?.state === 'restart-required') step.value = 'restart'
    else if (next?.state === 'running') step.value = 'progress'
    else if (next?.state === 'ready') step.value = next.restartRequired ? 'restart' : 'ready'
    else if (next?.state === 'error' || next?.state === 'cancelled') step.value = 'error'
  }
  function applyPlan(next) {
    plan.value = next
    if (next?.restartRequired) step.value = 'restart'
    else if (next?.ready) step.value = 'ready'
  }
  async function refresh() {
    try { applyStatus(await bridge.getSetupStatus()) } catch (cause) {
      error.value = cause?.message || 'Unable to read setup progress.'
    }
  }
  async function initialize() {
    return guarded(async () => {
      const saved = await bridge.getOnboardingState()
      if (steps.has(saved?.step)) step.value = saved.step
      choice.value = saved?.choice === 'modal' ? 'modal' : 'local'
      const live = await bridge.getSetupStatus()
      // Readiness always comes from the runtime, never from saved navigation.
      if (['ready', 'restart', 'progress'].includes(step.value)) step.value = 'choose'
      applyStatus(live)
      if (['choose', 'consent', 'error'].includes(step.value)) applyPlan(await bridge.preflightSetup())
    })
  }
  async function chooseProcessing() {
    return guarded(async () => {
      step.value = 'choose'
      applyPlan(await bridge.preflightSetup())
      if (!localAvailable.value) choice.value = 'modal'
      await persist()
    })
  }
  async function continueChoice() {
    return guarded(async () => {
      if (choice.value === 'local') {
        applyPlan(await bridge.preflightSetup())
        if (['ready', 'restart'].includes(step.value)) { await persist(); return }
        if (!localAvailable.value) return
      }
      step.value = choice.value === 'modal' ? 'modal' : 'consent'
      await persist()
    })
  }
  async function start() {
    if (!canStart.value) return false
    return guarded(async () => {
      const next = await bridge.startSetup({ consent: true, planId: plan.value.planId })
      step.value = 'progress'
      applyStatus(next)
      await persist()
    })
  }
  async function cancel() {
    return guarded(async () => { applyStatus(await bridge.cancelSetup()); await persist() })
  }
  async function chooseModelSource(mode) {
    return guarded(async () => {
      applyPlan(await bridge.chooseModelSource(mode))
      await persist()
    })
  }
  async function openHelp(topic) { return guarded(() => bridge.openSetupHelp(topic)) }
  async function restart() { return guarded(() => bridge.restartApp()) }
  async function skip() { return guarded(() => persist(true)) }
  async function complete() { return guarded(() => persist(false)) }
  return { step, choice, plan, status, busy, error, localAvailable, canStart,
    initialize, refresh, chooseProcessing, continueChoice, start, cancel, restart, skip, complete, openHelp, chooseModelSource }
}
