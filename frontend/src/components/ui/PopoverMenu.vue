<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <span ref="anchorEl" class="ui-pop-anchor">
    <slot name="trigger" :open="isOpen" :toggle="toggle" :attrs="triggerAttrs" />
  </span>
  <Teleport to="body">
    <div
      v-if="isOpen"
      :id="panelId"
      ref="panelEl"
      class="ui-pop"
      :class="panelClass"
      :role="role"
      :aria-label="label || undefined"
      :style="panelStyle"
      tabindex="-1"
      @keydown="onPanelKeydown"
    >
      <slot :close="close" />
    </div>
  </Teleport>
</template>

<script setup>
// Anchored popover / dropdown menu. The trigger is the caller's own element
// (the `trigger` slot), so a plain button, a chip or the brand mark can all
// open one; spread `attrs` onto it for aria-haspopup/aria-expanded/-controls
// and wire `toggle` to its click.
//
// The panel is teleported to <body> and positioned `fixed` against the
// trigger's rect: the sidebar and the queue pane both clip their overflow,
// and a panel rendered in place would be cut off at their edges.
//
// role="menu" gets menu keyboarding: the arrow keys, Home and End move
// between [role=menuitem] children, focus lands on the first item on open,
// and Tab leaves the menu (closing it, focus back on the trigger). Any other
// role (the default "dialog") focuses the panel itself on open, so a screen
// reader starts at its label rather than mid-form. Escape and a pointer press
// outside both trigger and panel close it; Escape hands focus back to the
// trigger.
//
// The panel sits below the trigger, flips above it when there is more room
// there, and is clamped inside the viewport's left and right edges.
import { ref, computed, nextTick, onBeforeUnmount, watch, useId } from 'vue'

const props = defineProps({
  role: { type: String, default: 'dialog' },
  // 'start' lines the panel's left edge up with the trigger's; 'end' its right.
  align: { type: String, default: 'start' },
  label: { type: String, default: '' },
  panelClass: { type: [String, Array, Object], default: '' },
})
const emit = defineEmits(['open', 'close'])

const panelId = `ui-pop-${useId()}`

const isOpen = ref(false)
const anchorEl = ref(null)
const panelEl = ref(null)
const pos = ref({ top: 0, left: null, right: null, maxHeight: null })

const triggerAttrs = computed(() => ({
  'aria-haspopup': props.role === 'menu' ? 'menu' : 'dialog',
  'aria-expanded': isOpen.value ? 'true' : 'false',
  'aria-controls': isOpen.value ? panelId : undefined,
}))

const panelStyle = computed(() => ({
  top: `${pos.value.top}px`,
  left: pos.value.left == null ? undefined : `${pos.value.left}px`,
  right: pos.value.right == null ? undefined : `${pos.value.right}px`,
  maxHeight: pos.value.maxHeight == null ? undefined : `${pos.value.maxHeight}px`,
}))

const GAP = 6
const EDGE = 8
const MIN_W = 200   // .ui-pop min-width

function place() {
  const el = anchorEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // clientWidth/Height exclude a visible scrollbar; innerWidth would let a
  // right-aligned panel slide under it.
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // Measure the panel once it exists; before the first render, assume the
  // CSS min-width so the first placement is already inside the edges.
  const w = panelEl.value?.offsetWidth || MIN_W
  const h = panelEl.value?.offsetHeight || 0

  let left = props.align === 'end' ? r.right - w : r.left
  left = Math.min(left, vw - EDGE - w)
  left = Math.max(EDGE, left)

  const below = vh - r.bottom - GAP - EDGE
  const above = r.top - GAP - EDGE
  const flip = h > below && above > below
  const maxHeight = Math.max(120, flip ? above : below)
  const top = flip
    ? Math.max(EDGE, r.top - GAP - Math.min(h, maxHeight))
    : r.bottom + GAP
  pos.value = { top, left, right: null, maxHeight }
}

function items() {
  return panelEl.value
    ? [...panelEl.value.querySelectorAll('[role="menuitem"]:not([disabled])')]
    : []
}

function focusFirst() {
  const panel = panelEl.value
  if (!panel) return
  const target = props.role === 'menu' ? items()[0] : null
  ;(target || panel).focus?.()
}

function focusTrigger() {
  const t = anchorEl.value?.querySelector('button, [href], [tabindex]')
  t?.focus?.()
}

async function open() {
  if (isOpen.value) return
  place()
  isOpen.value = true
  emit('open')
  await nextTick()
  place()   // again, now the panel's real size is known
  focusFirst()
}

// Return focus before removing its current menu/dialog control. Callers may
// move it to another surface after close(), or opt out when navigation owns
// focus. An outside pointer press owns its destination independently.
function close({ restoreFocus = panelEl.value?.contains(document.activeElement) ?? false } = {}) {
  if (!isOpen.value) return
  isOpen.value = false
  emit('close')
  if (restoreFocus) focusTrigger()
}

function toggle() {
  if (isOpen.value) close()
  else open()
}

function onDocPointer(e) {
  const t = e.target
  if (anchorEl.value?.contains(t) || panelEl.value?.contains(t)) return
  close({ restoreFocus: false })
}

function onDocKeydown(e) {
  if (e.key === 'Escape') close({ restoreFocus: true })
}

function onPanelKeydown(e) {
  if (props.role !== 'menu') return
  const list = items()
  if (!list.length) return
  const i = list.indexOf(document.activeElement)
  let next = null
  if (e.key === 'ArrowDown') next = list[(i + 1) % list.length]
  else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length]
  else if (e.key === 'Home') next = list[0]
  else if (e.key === 'End') next = list[list.length - 1]
  // No preventDefault: the browser moves focus on from the trigger, which is
  // where the menu logically sits in the tab order.
  else if (e.key === 'Tab') { close({ restoreFocus: true }); return }
  if (next) { e.preventDefault(); next.focus() }
}

// Listeners only while open: a shell carries several of these, and a closed
// one has no business seeing every click in the document.
function bind(on) {
  const fn = on ? 'addEventListener' : 'removeEventListener'
  document[fn]('pointerdown', onDocPointer, true)
  document[fn]('keydown', onDocKeydown)
  window[fn]('resize', place)
  window[fn]('scroll', place, true)
}
watch(isOpen, (v) => bind(v))
onBeforeUnmount(() => bind(false))

defineExpose({ open, close, toggle, isOpen })
</script>

<style scoped>
.ui-pop-anchor { display: inline-flex; position: relative; flex-shrink: 0; }

.ui-pop {
  position: fixed; z-index: 900;
  min-width: 200px; max-width: min(360px, calc(100vw - 16px));
  overflow-y: auto;
  padding: 0.35rem;
  background: #171b25;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  color: var(--text-primary);
  font-size: 0.82rem;
  text-transform: none; letter-spacing: 0; font-weight: 400;
}
.ui-pop:focus { outline: none; }

/* Shared menu vocabulary for slotted content. */
.ui-pop :slotted(.ui-menu__item) {
  display: flex; align-items: center; gap: 0.6rem;
  width: 100%; padding: 0.45rem 0.6rem;
  background: none; border: 0; border-radius: var(--radius-sm);
  color: inherit; font: inherit; text-align: left; text-decoration: none;
  cursor: pointer; white-space: nowrap;
}
.ui-pop :slotted(.ui-menu__item:hover),
.ui-pop :slotted(.ui-menu__item:focus-visible) { background: var(--bg-glass-hover); outline: none; }
.ui-pop :slotted(.ui-menu__item:disabled) { opacity: 0.45; cursor: not-allowed; }
.ui-pop :slotted(.ui-menu__item--danger) { color: #ffb3a1; }
.ui-pop :slotted(.ui-menu__icon) { width: 1.1rem; text-align: center; flex-shrink: 0; }
.ui-pop :slotted(.ui-menu__sep) {
  border: 0; border-top: 1px solid var(--border-subtle); margin: 0.3rem 0.25rem;
}
.ui-pop :slotted(.ui-menu__section) {
  font-size: 0.66rem; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-muted); padding: 0.35rem 0.6rem 0.15rem; margin: 0;
}
</style>
