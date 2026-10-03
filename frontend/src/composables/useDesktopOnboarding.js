// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref } from 'vue'

const steps = new Set(['welcome', 'choose', 'lyrics', 'consent', 'modal', 'progress', 'error', 'restart', 'ready'])

export function useDesktopOnboarding(bridge = globalThis.window?.karaokeDesktop) {
  const step = ref('welcome')
  const choice = ref('local')
  const plan = ref(null)
  const status = ref(null)
  const busy = ref(false)
  const error = ref('')
  const lyricsEnabled = ref(false)
  let navigationGeneration = 0
  let pendingCheck = null
  const navigation = () => ({ generation: navigationGeneration, step: step.value, choice: choice.value })
  const currentNavigation = snapshot => snapshot.generation === navigationGeneration
    && snapshot.step === step.value && snapshot.choice === choice.value
  const localAvailable = computed(() => plan.value?.available === true)
  const canStart = computed(() => plan.value?.available === true && !!plan.value?.planId && !busy.value)

  async function persist(skipped = false) {
    // A check is transient; reopening setup checks again from live status.
    const saved = step.value !== 'checking' ? step.value : choice.value === 'modal' ? 'modal' : 'choose'
    await bridge.setOnboardingState({ step: saved, choice: choice.value, skipped })
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
    else if (next?.state === 'checking') step.value = 'checking'
    else if (next?.state === 'ready') {
      if (next.restartRequired) step.value = 'restart'
      else applyLocalReady()
    }
    else if (next?.state === 'error' || next?.state === 'cancelled') step.value = 'error'
  }
  function applyLocalReady() {
    if (choice.value === 'local') step.value = 'ready'
    else if (['ready', 'progress', 'restart', 'checking'].includes(step.value)) step.value = 'modal'
  }
  function applyPlan(next) {
    plan.value = next
    if (next?.restartRequired) step.value = 'restart'
    else if (next?.ready) applyLocalReady()
  }
  async function preflight() {
    // A failed refresh must not leave an earlier consent plan actionable.
    plan.value = null
    return bridge.preflightSetup()
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
  // A finished setup awaiting reopening is re-verified once. Only the live
  // preflight result can show readiness; anything short of it is repairable.
  // The outcome applies while the check screen is still showing; an action
  // that failed without leaving it must not strand the check.
  function verifyCheck() {
    pendingCheck ??= (async () => {
      let next = null, failure = null
      try { next = await preflight() } catch (cause) { failure = cause }
      if (step.value !== 'checking') return
      const live = await bridge.getSetupStatus().catch(() => null)
      if (step.value !== 'checking') return
      const settled = live && !['checking', 'idle'].includes(live.state)
      // Live verification already established readiness; a lost reply is not a failure.
      if (failure && !(settled && live.state === 'ready' && !live.restartRequired)) {
        error.value = failure?.message || 'Setup could not be checked. Please try again.'
      }
      if (settled) status.value = live
      if (next) applyPlan(next)
      if (step.value === 'checking') {
        if (settled) applyStatus(live)
        else {
          const message = 'Review setup to check and repair the installation.'
          applyStatus({ state: 'error', phase: 'verification', message, error: message, retryable: true })
        }
      }
      const settledNavigation = navigation()
      try { await applyModalStatus() } catch (cause) {
        if (currentNavigation(settledNavigation)) error.value = cause?.message || 'Unable to read setup progress.'
      }
    })().finally(() => { pendingCheck = null })
    return pendingCheck
  }
  async function refresh() {
    let snapshot = navigation()
    try {
      const live = await bridge.getSetupStatus()
      if (!currentNavigation(snapshot)) return
      const choosing = step.value === 'choose'
      applyStatus(live)
      if (choosing && status.value?.state === 'ready' && !status.value.restartRequired) step.value = 'choose'
      if (step.value === 'checking') return verifyCheck()
      snapshot = navigation()
      if (step.value !== 'choose') await applyModalStatus()
    } catch (cause) {
      if (!currentNavigation(snapshot)) return
      error.value = cause?.message || 'Unable to read setup progress.'
    }
  }
  async function initialize() {
    let checking = false
    const initialized = await guarded(async () => {
      const saved = await bridge.getOnboardingState()
      if (bridge.getLyricsLookup) lyricsEnabled.value = (await bridge.getLyricsLookup()).enabled === true
      if (steps.has(saved?.step)) step.value = saved.step
      choice.value = saved?.choice === 'modal' ? 'modal' : 'local'
      const live = await bridge.getSetupStatus()
      // Readiness always comes from the runtime, never from saved navigation.
      if (['ready', 'restart', 'progress'].includes(step.value)) step.value = choice.value === 'modal' ? 'modal' : 'choose'
      applyStatus(live)
      // The check runs outside the busy guard so the library stays reachable.
      if (step.value === 'checking') { checking = true; return }
      if (['choose', 'consent', 'error'].includes(step.value)) applyPlan(await preflight())
      await applyModalStatus()
    })
    if (checking) await verifyCheck()
    return initialized
  }
  async function chooseProcessing() {
    return guarded(async () => {
      step.value = 'choose'
      // An explicit request to choose a route must remain on the choice
      // screen even when the local runtime is already usable.
      plan.value = await preflight()
      if (status.value?.state === 'running' || status.value?.state === 'restart-required') applyStatus(status.value)
      if (!localAvailable.value) choice.value = 'modal'
      await persist()
    })
  }
  async function welcome() {
    return guarded(async () => { step.value = 'welcome'; await persist() })
  }
  async function chooseLyrics() {
    return guarded(async () => {
      if (bridge.getLyricsLookup) lyricsEnabled.value = (await bridge.getLyricsLookup()).enabled === true
      step.value = 'lyrics'
      await persist()
    })
  }
  async function saveLyrics() {
    return guarded(async () => {
      if (!bridge.setLyricsLookup) throw new Error('Lyrics lookup settings are unavailable. Update the desktop application and try again.')
      lyricsEnabled.value = (await bridge.setLyricsLookup(lyricsEnabled.value)).enabled === true
    })
  }
  async function continueChoice() {
    return guarded(async () => {
      if (choice.value === 'local') {
        applyPlan(await preflight())
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
    lyricsEnabled, welcome, chooseLyrics, saveLyrics, initialize, refresh, chooseProcessing, continueChoice, start, cancel, restart, skip, complete, openHelp, chooseModelSource }
}
