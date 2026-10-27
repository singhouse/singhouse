// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UndoButton from '@/components/ui/UndoButton.vue'

describe('UndoButton', () => {
  it('is an icon-only button named "Undo" that emits click', async () => {
    const w = mount(UndoButton)
    const btn = w.find('button')
    expect(btn.attributes('type')).toBe('button')
    expect(btn.attributes('aria-label')).toBe('Undo')
    expect(btn.find('svg').exists()).toBe(true)
    expect(btn.text()).toBe('')
    await btn.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })

  it('carries the label as its tooltip under a stable "Undo" name', () => {
    const label = 'Undo advance — bring back Sam, Jump'
    const btn = mount(UndoButton, { props: { label } }).find('button')
    expect(btn.attributes('title')).toBe(label)
    expect(btn.attributes('aria-label')).toBe('Undo')
    // Non-standard ARIA is not used.
    expect(btn.attributes('aria-description')).toBeUndefined()
  })

  it('falls back to a plain "Undo" tooltip without a label', () => {
    const btn = mount(UndoButton).find('button')
    expect(btn.attributes('title')).toBe('Undo')
    expect(btn.attributes('aria-label')).toBe('Undo')
  })

  it('disabled blocks the click', async () => {
    const w = mount(UndoButton, { props: { disabled: true } })
    const btn = w.find('button')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  it('busy disables, marks aria-busy and shows the pending icon', async () => {
    const w = mount(UndoButton, { props: { busy: true } })
    const btn = w.find('button')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('aria-busy')).toBe('true')
    expect(btn.find('.ui-undo__spinner').exists()).toBe(true)
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()

    await w.setProps({ busy: false })
    expect(btn.attributes('aria-busy')).toBeUndefined()
    expect(btn.find('.ui-undo__spinner').exists()).toBe(false)
    expect(btn.attributes('disabled')).toBeUndefined()
  })
})
