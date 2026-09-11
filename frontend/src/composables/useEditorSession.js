// SPDX-License-Identifier: AGPL-3.0-only
// Vue reactivity wrapper around the framework-free editor session
// (src/editor/session.js). The session object mutates internally; we bump a
// version counter on every change so computeds depending on it re-evaluate.

import { computed, ref, shallowRef } from 'vue'

import { createSession } from '@/editor/session.js'

export function useEditorSession() {
  const session = shallowRef(null)
  const version = ref(0)
  const lastError = ref(null)

  function load(rawDoc) {
    session.value = createSession(rawDoc)
    version.value++
    lastError.value = null
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

  return {
    load,
    close,
    apply,
    undo,
    redo,
    exportSession,
    doc,
    canUndo,
    canRedo,
    dirty,
    opCount,
    validation,
    lastError,
  }
}
