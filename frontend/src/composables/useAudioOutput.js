// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref } from 'vue'

const STORAGE_KEY = 'karaoke.audio-output'

// Output routing is deliberately independent of transport, clocks and graphs.
export function useAudioOutput() {
  const enabled = typeof window !== 'undefined' && window.karaokeDesktop?.isDesktop === true
  const devices = ref([])
  const selectedId = ref('')
  const status = ref('idle')
  const error = ref('')
  const enumerationError = ref('')
  const supported = ref(false)
  const missing = computed(() => !!selectedId.value && !devices.value.some(d => d.deviceId === selectedId.value))
  let context = null
  let queue = Promise.resolve()
  let revision = 0
  let enumerationRevision = 0
  let listening = false
  const media = enabled ? window.navigator?.mediaDevices : null
  if (enabled) {
    try { selectedId.value = window.localStorage.getItem(STORAGE_KEY) || '' } catch { /* Storage may be unavailable; retain the session selection. */ }
  }

  function errorText(e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'Audio output permission denied. Check desktop or system permissions.'
    if (e?.name === 'NotFoundError') return 'Selected output is disconnected or unavailable. Choose another output.'
    return 'Could not change audio output. Check the device and try again.'
  }

  async function refresh() {
    if (!enabled) return
    const request = ++enumerationRevision
    if (!media?.enumerateDevices) {
      enumerationError.value = 'Audio device listing is unavailable in this desktop runtime.'
      return
    }
    try {
      const result = await media.enumerateDevices()
      if (request !== enumerationRevision) return
      devices.value = result.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
      enumerationError.value = ''
    } catch (e) {
      if (request === enumerationRevision) enumerationError.value = errorText(e)
    }
  }

  function apply() {
    if (!enabled || !context) return Promise.resolve()
    const target = context
    const id = selectedId.value
    const request = ++revision
    if (!supported.value) {
      status.value = 'unsupported'
      return Promise.resolve()
    }
    status.value = 'pending'
    error.value = ''
    // Serialize calls: an older slow request must never win over a newer one.
    queue = queue.then(async () => {
      if (target !== context || request !== revision) return
      try {
        if (target.sinkId !== id) await target.setSinkId(id)
        if (target !== context || request !== revision) return
        status.value = 'ready'
      } catch (e) {
        if (target !== context || request !== revision) return
        status.value = 'error'
        error.value = errorText(e)
      }
    })
    return queue
  }

  function select(id) {
    if (!enabled || typeof id !== 'string') return Promise.resolve()
    selectedId.value = id === 'default' ? '' : id
    try { window.localStorage.setItem(STORAGE_KEY, selectedId.value) } catch { /* Storage may be unavailable; retain the session selection. */ }
    return apply()
  }

  function attach(nextContext) {
    if (!enabled) return Promise.resolve()
    detach()
    context = nextContext
    supported.value = typeof context?.setSinkId === 'function'
    return apply()
  }

  function detach() {
    context = null
    revision++
    queue = Promise.resolve()
    status.value = 'idle'
    error.value = ''
    supported.value = false
  }

  function start() {
    if (!enabled || listening) return
    listening = true
    media?.addEventListener?.('devicechange', refresh)
    void refresh()
  }

  function stop() {
    media?.removeEventListener?.('devicechange', refresh)
    listening = false
    enumerationRevision++
    detach()
  }

  return { enabled, devices, selectedId, status, error, enumerationError, supported, missing,
    select, attach, detach, refresh, start, stop }
}
