// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { createSession, replaySession } from '../../src/editor/session.js'
import { docToLrc, docToPlain } from '../../src/editor/export.js'
import { normalizeDoc } from '../../src/editor/model.js'
import { rawTranscriptionDoc } from './helpers.js'

describe('createSession', () => {
  it('applies ops and tracks dirty state', () => {
    const s = createSession(rawTranscriptionDoc())
    expect(s.dirty).toBe(false)
    s.apply({ type: 'splitLine', lineIdx: 0, wordIdx: 2 })
    expect(s.dirty).toBe(true)
    expect(s.doc.lines.length).toBe(4)
  })

  it('a failed op leaves state unchanged', () => {
    const s = createSession(rawTranscriptionDoc())
    expect(() => s.apply({ type: 'splitLine', lineIdx: 0, wordIdx: 0 })).toThrow(RangeError)
    expect(s.doc).toEqual(s.initialDoc)
    expect(s.dirty).toBe(false)
  })

  it('undo/redo replay the op log', () => {
    const s = createSession(rawTranscriptionDoc())
    s.apply({ type: 'splitLine', lineIdx: 0, wordIdx: 2 })
    s.apply({ type: 'editWordText', lineIdx: 1, wordIdx: 0, text: 'GIVE' })
    const edited = s.doc

    s.undo()
    expect(s.doc.lines[1][0].text).toBe('give')
    s.undo()
    expect(s.doc).toEqual(s.initialDoc)
    expect(s.canUndo).toBe(false)

    s.redo()
    s.redo()
    expect(s.doc).toEqual(edited)
    expect(s.canRedo).toBe(false)
  })

  it('a new op clears the redo stack', () => {
    const s = createSession(rawTranscriptionDoc())
    s.apply({ type: 'mergeLines', lineIdx: 0 })
    s.undo()
    s.apply({ type: 'mergeLines', lineIdx: 1 })
    expect(s.canRedo).toBe(false)
  })

  it('exportSession round-trips through replaySession', () => {
    const s = createSession(rawTranscriptionDoc())
    s.apply({ type: 'splitLine', lineIdx: 2, wordIdx: 3 })
    s.apply({ type: 'deleteWords', lineIdx: 0, fromWordIdx: 0 })
    expect(replaySession(s.exportSession())).toEqual(s.doc)
  })
})

describe('export helpers', () => {
  it('docToPlain joins words per line', () => {
    const plain = docToPlain(normalizeDoc(rawTranscriptionDoc()))
    expect(plain.split('\n')[0]).toBe('never gonna give you up')
  })

  it('docToLrc stamps line start times', () => {
    const lrc = docToLrc(normalizeDoc(rawTranscriptionDoc()))
    expect(lrc.split('\n')[0]).toBe('[00:10.00] never gonna give you up')
    expect(lrc.split('\n')[1]).toBe('[00:14.00] never gonna let you down')
  })
})
