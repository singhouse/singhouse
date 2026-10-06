// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The shared dialog primitive: a native <dialog> with a role and a name, focus
// that starts inside, a Tab loop that stays inside, Escape that closes unless
// busy, and focus handed back to the control that opened it.

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, inject, onMounted, ref } from 'vue'
import Modal from '@/components/ui/Modal.vue'

let wrapper = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// An opener button next to a Modal, the way every consumer wires one.
function harness({ modalProps = {}, slot = null } = {}) {
  const Harness = defineComponent({
    setup() {
      const open = ref(false)
      const closes = ref(0)
      return () => h('div', [
        h('button', { class: 'opener', onClick: () => { open.value = true } }, 'Open'),
        h(Modal, {
          visible: open.value,
          ...modalProps,
          onClose: () => { closes.value++; open.value = false },
        }, slot ? { default: slot } : undefined),
      ])
    },
  })
  wrapper = mount(Harness, { attachTo: document.body })
  return wrapper
}

async function openFromOpener() {
  const opener = document.querySelector('.opener')
  opener.focus()
  opener.click()
  await flushPromises()
  return opener
}

const dialog = () => document.body.querySelector('dialog.modal-overlay')

function key(el, k, init = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}

function nameOf(el) {
  const id = el.getAttribute('aria-labelledby')
  return id ? document.getElementById(id)?.textContent.trim() : ''
}

const CONFIRM = { title: 'Remove thing?', message: 'Gone for good.', confirmLabel: 'Remove' }

describe('dialog semantics', () => {
  it('opens a modal dialog named by its title', async () => {
    harness({ modalProps: CONFIRM })
    await openFromOpener()
    const d = dialog()
    expect(d).not.toBeNull()
    expect(d.tagName).toBe('DIALOG')
    expect(d.hasAttribute('open')).toBe(true)
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('role')).toBe('alertdialog')
    expect(nameOf(d)).toBe('Remove thing?')
    expect(document.getElementById(d.getAttribute('aria-describedby')).textContent).toBe('Gone for good.')
  })

  it('a non-destructive confirm is an ordinary dialog', async () => {
    harness({ modalProps: { ...CONFIRM, confirmVariant: 'primary' } })
    await openFromOpener()
    expect(dialog().getAttribute('role')).toBe('dialog')
  })

  it('generic mode is named by the heading its content renders', async () => {
    harness({ slot: () => h('div', [h('h2', 'Things'), h('input', { class: 'field' })]) })
    await openFromOpener()
    const d = dialog()
    expect(d.getAttribute('role')).toBe('dialog')
    expect(nameOf(d)).toBe('Things')
  })
})

describe('initial focus', () => {
  it('a confirm starts on Cancel, not the × button', async () => {
    harness({ modalProps: CONFIRM })
    await openFromOpener()
    expect(document.activeElement.textContent).toBe('Cancel')
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it('starts on the first control of generic content', async () => {
    harness({ slot: () => h('div', [h('h2', 'Things'), h('input', { class: 'field' }), h('button', 'Go')]) })
    await openFromOpener()
    expect(document.activeElement.classList.contains('field')).toBe(true)
  })

  it('an [autofocus] control wins', async () => {
    harness({ slot: () => h('div', [h('input', { class: 'field' }), h('button', { class: 'go', autofocus: true }, 'Go')]) })
    await openFromOpener()
    expect(document.activeElement.classList.contains('go')).toBe(true)
  })

  it('falls back to the card when nothing inside can take focus', async () => {
    harness({ modalProps: { closable: false }, slot: () => h('p', 'Just words.') })
    await openFromOpener()
    expect(document.activeElement.classList.contains('modal-card')).toBe(true)
  })
})

describe('Tab containment', () => {
  it('Tab from the last control wraps to the first, Shift+Tab back again', async () => {
    harness({ modalProps: CONFIRM })
    await openFromOpener()
    const d = dialog()
    const close = d.querySelector('.modal__close')
    const confirm = d.querySelector('.ui-btn--danger')

    confirm.focus()
    const fwd = key(confirm, 'Tab')
    expect(fwd.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    const back = key(close, 'Tab', { shiftKey: true })
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(confirm)
  })

  it('leaves Tab between inner controls to the browser', async () => {
    harness({ modalProps: CONFIRM })
    await openFromOpener()
    const cancel = dialog().querySelector('.ui-btn--ghost')
    cancel.focus()
    expect(key(cancel, 'Tab').defaultPrevented).toBe(false)
  })
})

describe('Escape and focus restore', () => {
  it('Escape closes through the same close event and returns focus to the opener', async () => {
    harness({ modalProps: CONFIRM })
    const opener = await openFromOpener()
    const ev = key(document.activeElement, 'Escape')
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('the native cancel event closes too', async () => {
    harness({ modalProps: CONFIRM })
    await openFromOpener()
    const ev = new Event('cancel', { cancelable: true })
    dialog().dispatchEvent(ev)
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('Cancel and × close and restore focus', async () => {
    harness({ modalProps: CONFIRM })
    const opener = await openFromOpener()
    dialog().querySelector('.modal__close').click()
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('busy', () => {
  it('ignores Escape and disables the close controls', async () => {
    harness({ modalProps: { ...CONFIRM, busy: true } })
    await openFromOpener()
    const d = dialog()
    key(d, 'Escape')
    d.dispatchEvent(new Event('cancel', { cancelable: true }))
    await flushPromises()
    expect(dialog()).not.toBeNull()
    expect(d.querySelector('.modal__close').disabled).toBe(true)
    expect(d.querySelector('.ui-btn--ghost').disabled).toBe(true)
    expect(d.getAttribute('aria-busy')).toBe('true')
    // Everything is disabled, so focus sits on the card and Tab keeps it there.
    expect(d.contains(document.activeElement)).toBe(true)
    key(document.activeElement, 'Tab')
    expect(d.contains(document.activeElement)).toBe(true)
  })

  it('reopens itself if the platform closes it while busy', async () => {
    harness({ modalProps: { ...CONFIRM, busy: true } })
    await openFromOpener()
    dialog().close()
    await flushPromises()
    expect(dialog()?.hasAttribute('open')).toBe(true)
  })

  it('content inside the dialog can report busy', async () => {
    const busy = ref(true)
    const Reporter = defineComponent({
      setup() {
        const modal = inject('ui-modal', null)
        const token = Symbol('test')
        onMounted(() => modal.setBusy(token, busy.value))
        return () => h('button', { class: 'inner', onClick: () => { busy.value = false; modal.setBusy(token, false) } }, 'Done')
      },
    })
    harness({ slot: () => h(Reporter) })
    await openFromOpener()
    key(dialog(), 'Escape')
    await flushPromises()
    expect(dialog()).not.toBeNull()
    expect(dialog().querySelector('.modal__close').disabled).toBe(true)

    dialog().querySelector('.inner').click()
    await flushPromises()
    key(dialog(), 'Escape')
    await flushPromises()
    expect(dialog()).toBeNull()
  })
})
