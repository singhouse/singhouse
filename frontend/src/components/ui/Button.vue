<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <button
    :type="type"
    :disabled="disabled"
    class="ui-btn"
    :class="`ui-btn--${variant}`"
  >
    <slot />
  </button>
</template>

<script setup>
defineProps({
  variant: { type: String, default: 'default' }, // default | primary | ghost | danger
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})
</script>

<style scoped>
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border-radius: var(--radius-md);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  user-select: none;
  line-height: 1.2;
}
.ui-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.ui-btn--default {
  background: var(--bg-glass);
  color: var(--text-secondary);
  border-color: var(--border-light);
}
.ui-btn--default:hover:not(:disabled) {
  background: var(--bg-glass-active);
  color: var(--text-primary);
}

.ui-btn--primary {
  background: var(--c-primary);
  color: #0c0e14;
  border-color: transparent;
}
.ui-btn--primary:hover:not(:disabled) {
  background: var(--c-primary-hover);
  box-shadow: 0 0 16px rgba(226, 62, 87, 0.4);
}

.ui-btn--ghost {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-secondary);
  border-color: var(--border-light);
}
.ui-btn--ghost:hover:not(:disabled) {
  background: var(--bg-glass-active);
  color: white;
}

.ui-btn--danger {
  background: var(--c-error);
  color: white;
  border-color: transparent;
}
.ui-btn--danger:hover:not(:disabled) {
  background: #fb7f5c;
}
</style>
