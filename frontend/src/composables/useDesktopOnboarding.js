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
  let navigationGeneration = 0
  const navigation = () => ({ generation: navigationGeneration, step: step.value, choice: choice.value })
  const currentNavigation = snapshot => snapshot.generation === navigationGeneration
    && snapshot.step === step.value && snapshot.choice === choice.value
  const localAvailable = computed(() => plan.value?.available !== false)
  const canStart = computed(() => plan.value?.available === true && !!plan.value?.planId && !busy.value)

  async function persist(skipped = false) {
    await bridge.setOnboardingState({ step: step.value, choice: choice.value, skipped })
  }
  async function guarded(action) {
    if (busy.value) return false
    busy.value = true
    navigationGeneration += 1
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
    else if (next?.state === 'ready') {
      if (next.restartRequired) step.value = 'restart'
      else applyLocalReady()
    }
    else if (next?.state === 'error' || next?.state === 'cancelled') step.value = 'error'
  }
  function applyLocalReady() {
    if (choice.value === 'local') step.value = 'ready'
    else if (['ready', 'progress', 'restart'].includes(step.value)) step.value = 'modal'
  }
  function applyPlan(next) {
    plan.value = next
    if (next?.restartRequired) step.value = 'restart'
    else if (next?.ready) applyLocalReady()
  }
  async function applyModalStatus() {
    if (choice.value !== 'modal' || !bridge.getModalStatus
        || ['running', 'restart-required'].includes(status.value?.state)
        || status.value?.restartRequired) return
    const snapshot = navigation()
    const modal = await bridge.getModalStatus()
    if (!currentNavigation(snapshot)) return
    // Only actual backend activation may establish readiness for this route.
    if (modal?.active === true) step.value = 'ready'
    else if (step.value === 'ready') step.value = 'modal'
  }
  async function refresh() {
    let snapshot = navigation()
    try {
      const live = await bridge.getSetupStatus()
      if (!currentNavigation(snapshot)) return
      const choosing = step.value === 'choose'
      applyStatus(live)
      if (choosing && status.value?.state === 'ready' && !status.value.restartRequired) step.value = 'choose'
      snapshot = navigation()
      if (step.value !== 'choose') await applyModalStatus()
    } catch (cause) {
      if (!currentNavigation(snapshot)) return
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
      if (['ready', 'restart', 'progress'].includes(step.value)) step.value = choice.value === 'modal' ? 'modal' : 'choose'
      applyStatus(live)
      if (['choose', 'consent', 'error'].includes(step.value)) applyPlan(await bridge.preflightSetup())
      await applyModalStatus()
    })
  }
  async function chooseProcessing() {
    return guarded(async () => {
      step.value = 'choose'
      // An explicit request to choose a route must remain on the choice
      // screen even when the local runtime is already usable.
      plan.value = await bridge.preflightSetup()
      if (status.value?.state === 'running' || status.value?.state === 'restart-required') applyStatus(status.value)
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
