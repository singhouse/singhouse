// SPDX-License-Identifier: AGPL-3.0-only
// Editing session = (initialDoc, opLog). Undo/redo is replay: ops are pure,
// so state N is just initialDoc run through ops[0..N-1]. Docs cache the
// current state to avoid O(n) replay per keystroke; undo replays from the
// start (docs are a few hundred words — replay is microseconds).
//
// Framework-free so it unit-tests headlessly; the Vue layer wraps an
// instance in a shallowRef and bumps it on change.

import { normalizeDoc } from './model.js'
import { applyOp, applyOps } from './ops.js'
import { validateDoc } from './validate.js'

export function createSession(rawDoc) {
  const initialDoc = normalizeDoc(rawDoc)
  let doc = initialDoc
  let opLog = []
  let redoStack = []

  return {
    get doc() {
      return doc
    },
    get initialDoc() {
      return initialDoc
    },
    get opLog() {
      return opLog.slice()
    },
    get canUndo() {
      return opLog.length > 0
    },
    get canRedo() {
      return redoStack.length > 0
    },
    get dirty() {
      return opLog.length > 0
    },

    /** Apply an op; throws (leaving state unchanged) on invalid params. */
    apply(op) {
      doc = applyOp(doc, op)
      opLog.push(op)
      redoStack = []
      return doc
    },

    undo() {
      if (!opLog.length) return doc
      redoStack.push(opLog.pop())
      doc = applyOps(initialDoc, opLog)
      return doc
    },

    redo() {
      if (!redoStack.length) return doc
      const op = redoStack.pop()
      doc = applyOp(doc, op)
      opLog.push(op)
      return doc
    },

    validate() {
      return validateDoc(doc)
    },

    /** Serializable record of the whole session — a reproducible test case. */
    exportSession() {
      return { initialDoc, ops: opLog.slice() }
    },
  }
}

/** Rebuild the final doc from an exported session record. */
export function replaySession({ initialDoc, ops }) {
  return applyOps(initialDoc, ops)
}
