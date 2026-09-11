// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Interaction contract for the chip editor: keyboard/mouse gestures emit the
// right op objects. The ops themselves are tested in ops.test.js — here we
// only care that the UI translates intent into ops correctly.

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import RegroupEditor from '../../src/components/editor/RegroupEditor.vue'
import { normalizeDoc } from '../../src/editor/model.js'
import { rawTranscriptionDoc } from './helpers.js'

function mountEditor() {
  return mount(RegroupEditor, {
    props: { doc: normalizeDoc(rawTranscriptionDoc()) },
    attachTo: document.body,
  })
}

// gap elements per line: line 0 has words 0..4 → gaps 0..5 rendered in order
function gapsOfLine(wrapper, lineIdx) {
  return wrapper.findAll('.re-line')[lineIdx].findAll('.re-gap')
}

describe('RegroupEditor interactions', () => {
  it('renders one row per line with word chips', () => {
    const wrapper = mountEditor()
    expect(wrapper.findAll('.re-line').length).toBe(3)
    expect(wrapper.findAll('.re-line')[0].findAll('.re-chip').map((c) => c.text())).toEqual([
      'never', 'gonna', 'give', 'you', 'up',
    ])
  })

  it('click gap + Enter emits splitLine at that gap', async () => {
    const wrapper = mountEditor()
    await gapsOfLine(wrapper, 0)[2].trigger('click') // before word 2
    await wrapper.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('op')).toEqual([[{ type: 'splitLine', lineIdx: 0, wordIdx: 2 }]])
  })

  it('Enter at a line edge is a no-op', async () => {
    const wrapper = mountEditor()
    await gapsOfLine(wrapper, 0)[0].trigger('click') // line start
    await wrapper.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('op')).toBeUndefined()
  })

  it('Backspace at line start emits mergeLines with the previous line', async () => {
    const wrapper = mountEditor()
    await gapsOfLine(wrapper, 1)[0].trigger('click')
    await wrapper.trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('op')).toEqual([[{ type: 'mergeLines', lineIdx: 0 }]])
  })

  it('Backspace on the first line is a no-op', async () => {
    const wrapper = mountEditor()
    await gapsOfLine(wrapper, 0)[0].trigger('click')
    await wrapper.trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('op')).toBeUndefined()
  })

  it('clicking a word selects it and emits seek at its start time', async () => {
    const wrapper = mountEditor()
    const chip = wrapper.findAll('.re-line')[1].findAll('.re-chip')[2] // "let", starts at 15.0
    await chip.trigger('click')
    expect(chip.classes()).toContain('is-selected')
    expect(wrapper.emitted('seek')).toEqual([[15]])
  })

  it('Delete removes the selected word', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.re-line')[0].findAll('.re-chip')[4].trigger('click')
    await wrapper.trigger('keydown', { key: 'Delete' })
    expect(wrapper.emitted('op')).toEqual([
      [{ type: 'deleteWords', lineIdx: 0, fromWordIdx: 4 }],
    ])
  })

  it('double-click → type → Enter emits editWordText', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.re-chip')[0].trigger('dblclick')
    const input = wrapper.find('input.re-edit-input')
    expect(input.exists()).toBe(true)
    await input.setValue('NEVER')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('op')).toEqual([
      [{ type: 'editWordText', lineIdx: 0, wordIdx: 0, text: 'NEVER' }],
    ])
  })

  it('double-click → Esc cancels without emitting', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.re-chip')[0].trigger('dblclick')
    const input = wrapper.find('input.re-edit-input')
    await input.setValue('nope')
    await input.trigger('keydown.esc')
    expect(wrapper.emitted('op')).toBeUndefined()
    expect(wrapper.find('input.re-edit-input').exists()).toBe(false)
  })

  it('caret + i → type → Enter emits insertWord at the gap', async () => {
    const wrapper = mountEditor()
    await gapsOfLine(wrapper, 1)[1].trigger('click')
    await wrapper.trigger('keydown', { key: 'i' })
    const input = wrapper.find('input.re-edit-input')
    await input.setValue('oh')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('op')).toEqual([
      [{ type: 'insertWord', lineIdx: 1, wordIdx: 1, text: 'oh' }],
    ])
  })

  it('Ctrl+Z / Ctrl+Shift+Z emit undo/redo', async () => {
    const wrapper = mountEditor()
    await wrapper.trigger('keydown', { key: 'z', ctrlKey: true })
    await wrapper.trigger('keydown', { key: 'z', ctrlKey: true, shiftKey: true })
    expect(wrapper.emitted('undo')).toHaveLength(1)
    expect(wrapper.emitted('redo')).toHaveLength(1)
  })

  it('clamps stale selection when the doc shrinks under it', async () => {
    const wrapper = mountEditor()
    const doc = wrapper.props('doc')
    await wrapper.findAll('.re-line')[2].findAll('.re-chip')[6].trigger('click')
    // simulate parent applying a merge that removes line 2
    const { mergeLines } = await import('../../src/editor/ops.js')
    await wrapper.setProps({ doc: mergeLines(doc, { lineIdx: 1 }) })
    await wrapper.trigger('keydown', { key: 'Delete' })
    const ops = wrapper.emitted('op')
    expect(ops).toHaveLength(1)
    // still addresses a real word in the shrunk doc
    const { lineIdx, fromWordIdx } = ops[0][0]
    expect(lineIdx).toBeLessThan(2)
    expect(fromWordIdx).toBeLessThan(12)
  })
})
