// SPDX-License-Identifier: AGPL-3.0-only
// Vue reactivity wrapper around the framework-free editor session
// (src/editor/session.js). The session object mutates internally; we bump a
// version counter on every change so computeds depending on it re-evaluate.
// Unsaved state is derived from the session's op log, so undoing back to zero
// edits is clean again.

import { computed, ref, shallowRef } from 'vue'

import { createSession } from '@/editor/session.js'

export function useEditorSession() {
  const session = shallowRef(null)
  const version = ref(0)
  const lastError = ref(null)
  // idle | saving | failed — the outcome of the last save of this session.
  const saveState = ref('idle')
  const saveError = ref('')

  function load(rawDoc) {
    session.value = createSession(rawDoc)
    version.value++
    lastError.value = null
    saveState.value = 'idle'
    saveError.value = ''
  }

  function close() {
    session.value = null
    version.value++
  }

  function apply(op) {
    if (!session.value) return
    try {
      session.value.apply(op)
      lastError.value = null
    } catch (err) {
      // Invalid op params (stale indices from a racing UI) — state unchanged.
      lastError.value = String(err?.message || err)
    }
    version.value++
  }

  function undo() {
    session.value?.undo()
    version.value++
    if (saveState.value === 'failed') {
      saveState.value = 'idle'
      saveError.value = ''
    }
  }

  function redo() {
    session.value?.redo()
    version.value++
  }

  const doc = computed(() => {
    version.value
    return session.value?.doc ?? null
  })
  const canUndo = computed(() => {
    version.value
    return session.value?.canUndo ?? false
  })
  const canRedo = computed(() => {
    version.value
    return session.value?.canRedo ?? false
  })
  const dirty = computed(() => {
    version.value
    return session.value?.dirty ?? false
  })
  const opCount = computed(() => {
    version.value
    return session.value?.opLog.length ?? 0
  })
  const validation = computed(() => {
    version.value
    return session.value ? session.value.validate() : { errors: [], warnings: [], ok: true }
  })

  function exportSession() {
    return session.value?.exportSession() ?? null
  }

  /** Run a save task, tracking its state. Resolves to the task's result, or
   *  null when it failed (the edits stay in the session). */
  async function trackSave(task) {
    saveState.value = 'saving'
    saveError.value = ''
    try {
      const result = await task()
      saveState.value = 'idle'
      return result
    } catch (err) {
      saveState.value = 'failed'
      saveError.value = String(err?.response?.data?.detail ?? err?.message ?? err)
      return null
    }
  }

  return {
    load,
    close,
    apply,
    undo,
    redo,
    exportSession,
    trackSave,
    doc,
    canUndo,
    canRedo,
    dirty,
    opCount,
    validation,
    lastError,
    saveState,
    saveError,
  }
}
