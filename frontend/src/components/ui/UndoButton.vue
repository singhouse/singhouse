<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <button
    type="button"
    class="ui-undo"
    :class="{ 'ui-undo--busy': busy }"
    aria-label="Undo"
    :title="label || 'Undo'"
    :aria-busy="busy ? 'true' : undefined"
    :disabled="disabled || busy"
    @click="onClick"
  >
    <svg
      v-if="busy"
      class="ui-undo__spinner"
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
    </svg>
    <svg
      v-else
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  </button>
</template>

<script setup>
// Icon-only undo control. The caller owns what "undo" means; `label` says it
// as the tooltip, which assistive tech also reads as the description. The
// accessible name stays a stable "Undo" so callers and tests can find it.
// `busy` covers the round trip.
const props = defineProps({
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['click'])

function onClick(event) {
  if (props.disabled || props.busy) return
  emit('click', event)
}
</script>

<style scoped>
.ui-undo {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid transparent;
  color: var(--text-secondary);
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}
.ui-undo:hover:not(:disabled) {
  background: var(--bg-glass-hover);
  color: white;
}
.ui-undo:focus-visible {
  outline: 2px solid var(--brand-cream, #f7e7c8);
  outline-offset: 1px;
}
.ui-undo:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ui-undo--busy:disabled {
  opacity: 0.7;
  cursor: progress;
}
.ui-undo__spinner {
  animation: ui-undo-spin 0.8s linear infinite;
}
@keyframes ui-undo-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-undo__spinner { animation: none; }
}
</style>
