<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <span class="ui-badge" :class="`ui-badge--${variant}`">
    <slot />
  </span>
</template>

<script setup>
defineProps({
  variant: { type: String, default: 'default' }, // default|ready|processing|failed|uploading|synced|plain|none
})
</script>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.55rem;
  border-radius: 9999px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ui-badge--default {
  background: var(--bg-glass);
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
}
.ui-badge--ready {
  background: var(--c-success-bg);
  color: var(--c-success);
  border: 1px solid var(--c-success-border);
}
.ui-badge--processing {
  background: var(--c-warning-bg);
  color: var(--c-warning);
  border: 1px solid var(--c-warning-border);
}
.ui-badge--failed {
  background: var(--c-error-bg);
  color: var(--c-error);
  border: 1px solid var(--c-error-border);
}
.ui-badge--uploading {
  background: var(--c-info-bg);
  color: var(--c-info);
  border: 1px solid var(--c-info-border);
}
.ui-badge--synced {
  background: var(--c-success-bg);
  color: var(--c-success);
  border: 1px solid var(--c-success-border);
}
.ui-badge--plain {
  background: var(--c-warning-bg);
  color: var(--c-warning);
  border: 1px solid var(--c-warning-border);
}
.ui-badge--none {
  background: var(--bg-glass);
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
}
</style>
