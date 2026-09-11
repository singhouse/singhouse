<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="modal-overlay" @click.self="onOverlayClick">
        <div class="modal-card" :class="`modal-card--${size}`">
          <!-- Confirm mode: built-in title + message + buttons -->
          <template v-if="title">
            <div class="modal__header">
              <h3>{{ title }}</h3>
              <button v-if="closable" class="modal__close" @click="$emit('close')" aria-label="Close">&times;</button>
            </div>
            <p class="modal__body"><slot>{{ message }}</slot></p>
            <div class="modal__footer">
              <button class="ui-btn ui-btn--ghost" @click="$emit('close')">Cancel</button>
              <button
                class="ui-btn"
                :class="`ui-btn--${confirmVariant}`"
                @click="$emit('confirm')"
              >{{ confirmLabel }}</button>
            </div>
          </template>

          <!-- Generic mode: slot content -->
          <template v-else>
            <div v-if="closable" class="modal__header">
              <span></span>
              <button class="modal__close" @click="$emit('close')" aria-label="Close">&times;</button>
            </div>
            <slot />
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
defineProps({
  visible: { type: Boolean, default: false },
  closable: { type: Boolean, default: true },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  confirmVariant: { type: String, default: 'danger' },
  size: { type: String, default: 'sm' },
})

defineEmits(['close', 'confirm'])

function onOverlayClick() {
  // Only allow closing via overlay click if closable
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-card {
  background: #1a1a3e;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 1.5rem;
  width: min(400px, 90vw);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: modalSlideUp 0.2s ease-out;
}
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
