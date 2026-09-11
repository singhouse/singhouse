<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <details
    v-if="output.enabled"
    class="audio-output"
    @keydown.stop
  >
    <summary>Audio output</summary>
    <div class="audio-output__panel">
      <label>
        Output device
        <select
          :value="output.selectedId.value"
          :disabled="!output.supported.value"
          @change="output.select($event.target.value)"
        >
          <option value="">System default</option>
          <option
            v-if="output.missing.value"
            :value="output.selectedId.value"
          >Saved output (unavailable)</option>
          <option
            v-for="(device, index) in output.devices.value"
            :key="device.deviceId"
            :value="device.deviceId"
          >
            {{ device.label || `Audio output ${index + 1}` }}
          </option>
        </select>
      </label>
      <p role="status">
        <template v-if="output.status.value === 'unsupported'">
          Output switching is unsupported in this desktop runtime. Using system default.
        </template>
        <template v-else-if="output.error.value">
          {{ output.error.value }} The requested output has not been confirmed.
        </template>
        <template v-else-if="output.status.value === 'pending'">
          Switching audio output…
        </template>
        <template v-else-if="output.missing.value">
          Saved output is disconnected or not exposed by system permissions. Choose an available output; routing is not confirmed.
        </template>
        <template v-else-if="output.status.value === 'ready'">
          Output applied.
        </template>
        <template v-else>
          Output will apply when audio loads.
        </template>
      </p>
      <p
        v-if="output.enumerationError.value"
        role="status"
      >
        {{ output.enumerationError.value }}
      </p>
      <p>Only outputs exposed by system permissions are listed. Microphone access is not requested.</p>
      <button
        type="button"
        @click="output.refresh()"
      >
        Refresh devices
      </button>
      <button
        v-if="output.status.value === 'error'"
        type="button"
        @click="output.select(output.selectedId.value)"
      >
        Retry output
      </button>
    </div>
  </details>
</template>

<script setup>
defineProps({ output: { type: Object, required: true } })
</script>

<style scoped>
.audio-output { position: relative; font-size: 0.8rem; flex-shrink: 0; }
.audio-output summary { cursor: pointer; }
.audio-output__panel {
  position: absolute; bottom: 100%; right: 0; z-index: 50;
  width: 280px; padding: 1rem; border-radius: 0.5rem;
  background: #171b26; color: white; border: 1px solid #555;
}
select { display: block; width: 100%; color: white; background: #171b26; margin-top: 0.5rem; }
p { margin-top: 0.75rem; }
button { margin: 0.75rem 0.75rem 0 0; text-decoration: underline; }
</style>
