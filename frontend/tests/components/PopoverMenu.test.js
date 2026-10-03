// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The shared core popover/menu: trigger ARIA, outside-press and Escape close,
// menu keyboarding, and the teleport to <body> that keeps it from being
// clipped by the sidebar's overflow.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import PopoverMenu from '@/components/ui/PopoverMenu.vue'

let wrapper = null

function mountMenu(props = { role: 'menu' }) {
  wrapper = mount({
    components: { PopoverMenu },
    data: () => ({ props }),
    template: `
      <div>
        <button class="outside">outside</button>
        <PopoverMenu v-bind="props" label="Things">
          <template #trigger="{ toggle, attrs }">
            <button class="trig" v-bind="attrs" @click="toggle">Open</button>
          </template>
          <template #default="{ close }">
            <button role="menuitem" class="mi mi-1" @click="close()">One</button>
            <button role="menuitem" class="mi mi-2">Two</button>
            <button role="menuitem" class="mi mi-3">Three</button>
          </template>
        </PopoverMenu>
      </div>`,
  }, { attachTo: document.body })
  return wrapper
}

const panel = () => document.body.querySelector('.ui-pop')

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('PopoverMenu', () => {
  it('teleports its panel to <body> and reflects state on the trigger', async () => {
    mountMenu()
    const trig = wrapper.find('.trig')
    expect(trig.attributes('aria-haspopup')).toBe('menu')
    expect(trig.attributes('aria-expanded')).toBe('false')
    expect(panel()).toBeNull()

    await trig.trigger('click')
    expect(panel()).not.toBeNull()
    expect(panel().parentElement).toBe(document.body)
    expect(panel().getAttribute('role')).toBe('menu')
    expect(trig.attributes('aria-expanded')).toBe('true')
    expect(trig.attributes('aria-controls')).toBe(panel().id)
  })

  it('focuses the first item and moves with the arrow keys', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    await nextTick()
    expect(document.activeElement.classList.contains('mi-1')).toBe(true)

    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement.classList.contains('mi-2')).toBe(true)
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement.classList.contains('mi-3')).toBe(true)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(wrapper.find('.trig').element)
  })

  it('closes on a press outside, but not on one inside', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    panel().querySelector('.mi-2').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(panel()).not.toBeNull()

    wrapper.find('.outside').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(panel()).toBeNull()
  })

  it('hands close() to its content', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    panel().querySelector('.mi-1').click()
    await nextTick()
    expect(panel()).toBeNull()
  })

  it('returns focus when activating an item removes the focused control', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    expect(document.activeElement).toBe(panel().querySelector('.mi-1'))
    panel().querySelector('.mi-1').click()
    await nextTick()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(wrapper.find('.trig').element)
  })

  it('preserves focus explicitly moved to an action destination', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    const destination = wrapper.find('.outside').element
    destination.focus()
    wrapper.findComponent(PopoverMenu).vm.close()
    await nextTick()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(destination)
  })

  it('lets a dialog action select its destination after closing', async () => {
    mountMenu({})
    await wrapper.find('.trig').trigger('click')
    const destination = wrapper.find('.outside').element
    wrapper.findComponent(PopoverMenu).vm.close()
    destination.focus()
    await nextTick()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(destination)
  })

  it('allows navigation actions to opt out of focus restoration', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    const trigger = wrapper.find('.trig').element
    const focusTrigger = vi.spyOn(trigger, 'focus')
    wrapper.findComponent(PopoverMenu).vm.close({ restoreFocus: false })
    await nextTick()
    expect(panel()).toBeNull()
    expect(focusTrigger).not.toHaveBeenCalled()
  })

  it('does not restore trigger focus on an outside pointer press', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    const focusTrigger = vi.spyOn(wrapper.find('.trig').element, 'focus')
    wrapper.find('.outside').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(panel()).toBeNull()
    expect(focusTrigger).not.toHaveBeenCalled()
  })

  it('is a dialog by default', async () => {
    mountMenu({})
    expect(wrapper.find('.trig').attributes('aria-haspopup')).toBe('dialog')
    await wrapper.find('.trig').trigger('click')
    expect(panel().getAttribute('role')).toBe('dialog')
  })

  it('focuses a dialog panel itself on open, not its first control', async () => {
    mountMenu({})
    await wrapper.find('.trig').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(panel())
  })

  it('closes a menu on Tab, hands focus to the trigger and lets Tab proceed', async () => {
    mountMenu()
    await wrapper.find('.trig').trigger('click')
    await nextTick()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    panel().querySelector('.mi-1').dispatchEvent(ev)
    await nextTick()
    expect(panel()).toBeNull()
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.trig').element)
  })
})

describe('PopoverMenu placement', () => {
  const root = document.documentElement
  let restore = []

  function viewport(w, h) {
    for (const [k, v] of [['clientWidth', w], ['clientHeight', h]]) {
      const prev = Object.getOwnPropertyDescriptor(root, k)
      Object.defineProperty(root, k, { configurable: true, get: () => v })
      restore.push(() => (prev ? Object.defineProperty(root, k, prev) : delete root[k]))
    }
  }
  function triggerAt(rect) {
    const anchor = wrapper.find('.ui-pop-anchor').element
    anchor.getBoundingClientRect = () => ({ width: rect.right - rect.left, height: rect.bottom - rect.top, ...rect })
  }
  function panelSize(w, h) {
    const el = panel()
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => w })
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => h })
    window.dispatchEvent(new Event('resize'))
  }
  const px = (v) => Number.parseFloat(v)

  afterEach(() => { restore.reverse().forEach(f => f()); restore = [] })

  it('opens below the trigger, left-aligned for align="start"', async () => {
    viewport(1000, 800)
    mountMenu()
    triggerAt({ left: 100, right: 140, top: 50, bottom: 80 })
    await wrapper.find('.trig').trigger('click')
    panelSize(220, 150)
    await nextTick()
    expect(px(panel().style.top)).toBe(86)
    expect(px(panel().style.left)).toBe(100)
  })

  it('clamps a start-aligned panel inside the right edge', async () => {
    viewport(400, 800)
    mountMenu()
    triggerAt({ left: 350, right: 390, top: 50, bottom: 80 })
    await wrapper.find('.trig').trigger('click')
    panelSize(220, 150)
    await nextTick()
    expect(px(panel().style.left)).toBe(400 - 8 - 220)
  })

  it('clamps an end-aligned panel inside the left edge', async () => {
    viewport(1000, 800)
    mountMenu({ role: 'menu', align: 'end' })
    triggerAt({ left: 10, right: 40, top: 50, bottom: 80 })
    await wrapper.find('.trig').trigger('click')
    panelSize(220, 150)
    await nextTick()
    expect(px(panel().style.left)).toBe(8)
  })

  it('right-aligns align="end" against the trigger when there is room', async () => {
    viewport(1000, 800)
    mountMenu({ role: 'menu', align: 'end' })
    triggerAt({ left: 500, right: 540, top: 50, bottom: 80 })
    await wrapper.find('.trig').trigger('click')
    panelSize(220, 150)
    await nextTick()
    expect(px(panel().style.left)).toBe(540 - 220)
  })

  it('flips above the trigger when there is no room below', async () => {
    viewport(1000, 600)
    mountMenu()
    triggerAt({ left: 100, right: 140, top: 540, bottom: 570 })
    await wrapper.find('.trig').trigger('click')
    panelSize(220, 200)
    await nextTick()
    // Bottom edge sits GAP (6px) above the trigger's top.
    expect(px(panel().style.top)).toBe(540 - 6 - 200)
  })
})
