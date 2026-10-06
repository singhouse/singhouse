<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <Teleport to="body">
    <Transition name="modal">
      <dialog
        v-if="visible"
        ref="dialogEl"
        class="modal-overlay"
        :role="dialogRole"
        aria-modal="true"
        :aria-labelledby="labelledBy || undefined"
        :aria-describedby="title ? bodyId : undefined"
        :aria-busy="isBusy ? 'true' : undefined"
        @cancel="onCancel"
        @close="onNativeClose"
        @keydown="onKeydown"
        @click.self="onOverlayClick"
      >
        <div ref="cardEl" class="modal-card" :class="`modal-card--${size}`" tabindex="-1">
          <!-- Confirm mode: built-in title + message + buttons -->
          <template v-if="title">
            <div class="modal__header">
              <h3 :id="titleId">{{ title }}</h3>
              <button
                v-if="closable"
                type="button"
                class="modal__close"
                data-modal-close
                :disabled="isBusy"
                aria-label="Close"
                @click="requestClose"
              >&times;</button>
            </div>
            <p :id="bodyId" class="modal__body"><slot>{{ message }}</slot></p>
            <div class="modal__footer">
              <button type="button" class="ui-btn ui-btn--ghost" :disabled="isBusy" @click="requestClose">Cancel</button>
              <button
                type="button"
                class="ui-btn"
                :class="`ui-btn--${confirmVariant}`"
                :disabled="isBusy"
                @click="$emit('confirm')"
              >{{ confirmLabel }}</button>
            </div>
          </template>

          <!-- Generic mode: slot content -->
          <template v-else>
            <div v-if="closable" class="modal__header">
              <span></span>
              <button
                type="button"
                class="modal__close"
                data-modal-close
                :disabled="isBusy"
                aria-label="Close"
                @click="requestClose"
              >&times;</button>
            </div>
            <slot />
          </template>
        </div>
      </dialog>
    </Transition>
  </Teleport>
</template>

<script setup>
// The shared modal dialog: a native <dialog> opened with showModal(), so the
// rest of the page is inert while it is up, the same as the desktop setup
// dialog.
//
//   - Name: confirm mode is labelled by its `title`; generic mode by the first
//     heading its slot renders.
//   - Initial focus: the first [autofocus] inside, else the first focusable
//     control other than the × button, else the card itself.
//   - Tab and Shift+Tab wrap inside the card.
//   - Escape emits `close` (the same event as × and Cancel) unless busy.
//   - Closing returns focus to whatever had it when the dialog opened.
//
// `busy` holds the dialog open while a request is in flight: Escape is
// ignored and the close controls are disabled. Content inside the dialog can
// report the same through the injected 'ui-modal' handle:
//
//   const modal = inject('ui-modal', null)
//   modal?.setBusy(token, true)
import { ref, reactive, computed, watch, nextTick, provide, onBeforeUnmount, useId } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  closable: { type: Boolean, default: true },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  confirmVariant: { type: String, default: 'danger' },
  size: { type: String, default: 'sm' },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const uid = `ui-modal-${useId()}`
const titleId = `${uid}-title`
const bodyId = `${uid}-body`

const dialogEl = ref(null)
const cardEl = ref(null)
const headingId = ref('')

const busyReporters = reactive(new Set())
provide('ui-modal', {
  setBusy(token, on) {
    if (on) busyReporters.add(token)
    else busyReporters.delete(token)
  },
})
const isBusy = computed(() => props.busy || busyReporters.size > 0)

// A destructive confirm interrupts; everything else is an ordinary dialog.
const dialogRole = computed(() =>
  props.title && props.confirmVariant === 'danger' ? 'alertdialog' : 'dialog',
)
const labelledBy = computed(() => (props.title ? titleId : headingId.value))

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'iframe', '[contenteditable=""]',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',')

function isRendered(el) {
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true
}

function focusables() {
  const card = cardEl.value
  if (!card) return []
  return [...card.querySelectorAll(FOCUSABLE)]
    .filter(el => el.tabIndex >= 0 && !el.closest('[inert]') && isRendered(el))
}

function focusInitial() {
  const card = cardEl.value
  if (!card) return
  const auto = card.querySelector('[autofocus]')
  const target = (auto && !auto.disabled ? auto : null)
    || focusables().find(el => !el.hasAttribute('data-modal-close'))
    || card
  target.focus()
}

function resolveHeading() {
  const h = cardEl.value?.querySelector('h1, h2, h3')
  if (!h) return ''
  if (!h.id) h.id = `${uid}-heading`
  return h.id
}

function showNative(el) {
  if (el.open) return
  if (typeof el.showModal === 'function' && el.isConnected) {
    try { el.showModal(); return } catch { /* fall through */ }
  }
  el.setAttribute('open', '')
}

function closeNative() {
  const el = dialogEl.value
  if (el?.open) {
    if (typeof el.close === 'function') el.close()
    else el.removeAttribute('open')
  }
}

// The element that had focus when the dialog opened, to hand focus back to.
let opener = null

function restoreFocus() {
  const el = opener
  opener = null
  if (!el || !el.isConnected || typeof el.focus !== 'function') return
  // Only take focus back from the dialog (or from nowhere): if something
  // else has deliberately moved it since, leave it there.
  const active = document.activeElement
  const inDialog = dialogEl.value?.contains(active)
  if (!inDialog && active && active !== document.body) return
  el.focus()
}

watch(() => props.visible, (v, old) => {
  if (v) {
    const active = document.activeElement
    opener = active && active !== document.body ? active : null
  } else if (old) {
    closeNative()
    restoreFocus()
  }
}, { immediate: true })

// The <dialog> exists once rendered (v-if inside the Transition): open it
// modally and move focus in.
watch(dialogEl, (el) => {
  if (!el) return
  showNative(el)
  if (!props.title) headingId.value = resolveHeading()
  focusInitial()
}, { flush: 'post' })

// Disabling the focused control drops focus out of the dialog; keep it on
// the card while busy.
watch(isBusy, async (v) => {
  if (!v) return
  await nextTick()
  const el = dialogEl.value
  const active = document.activeElement
  if (el && (!el.contains(active) || active?.disabled)) cardEl.value?.focus()
})

onBeforeUnmount(() => {
  if (props.visible) restoreFocus()
})

function requestClose() {
  if (isBusy.value) return
  emit('close')
}

function trapTab(e) {
  const list = focusables()
  const card = cardEl.value
  if (!list.length) {
    e.preventDefault()
    card?.focus()
    return
  }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  const inside = !!dialogEl.value?.contains(active)
  if (e.shiftKey) {
    if (!inside || active === first || active === card) {
      e.preventDefault()
      last.focus()
    }
  } else if (!inside || active === last) {
    e.preventDefault()
    first.focus()
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    // Handled here rather than by the platform so the dialog's open state
    // always follows `visible`.
    e.preventDefault()
    requestClose()
  } else if (e.key === 'Tab') {
    trapTab(e)
  }
}

// The platform's own close request (Escape where the keydown was not seen).
function onCancel(e) {
  e.preventDefault()
  requestClose()
}

// The platform closed the dialog anyway (a repeated close request can't be
// cancelled): reopen it while busy, otherwise treat it as a close.
function onNativeClose() {
  if (!props.visible) return
  if (isBusy.value) {
    const el = dialogEl.value
    if (el) showNative(el)
    return
  }
  emit('close')
}

function onOverlayClick() {
  // Only allow closing via overlay click if closable
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: none;
  color: inherit;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-overlay::backdrop { background: transparent; }

.modal-card {
  background: #1a1a3e;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 1.5rem;
  width: min(400px, 90vw);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: modalSlideUp 0.2s ease-out;
}
.modal-card:focus { outline: none; }
.modal-card--md { width: min(600px, 92vw); }
.modal-card--lg { width: min(760px, 94vw); max-height: 90vh; overflow-y: auto; }

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.modal__header h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: white;
}

.modal__close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0 0.25rem;
  line-height: 1;
}
.modal__close:hover { color: white; }
.modal__close:disabled { opacity: 0.35; cursor: not-allowed; }
.modal__close:disabled:hover { color: rgba(255, 255, 255, 0.4); }
.modal__close:focus-visible,
.modal__footer .ui-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 2px; }

.modal__body {
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.5;
  margin: 0 0 1.25rem;
}

.modal__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .modal-card { transform: translateY(12px); opacity: 0; }
.modal-leave-to .modal-card { transform: translateY(12px); opacity: 0; }

@keyframes modalSlideUp {
  from { transform: translateY(12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
