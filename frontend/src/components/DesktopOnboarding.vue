<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DesktopModalSetup from './DesktopModalSetup.vue'
import { BRAND_NAME } from '../brand'
import { useDesktopOnboarding } from '../composables/useDesktopOnboarding'

const emit = defineEmits(['close', 'add-song', 'modal-settings'])
const setup = useDesktopOnboarding()
const { step, choice, plan, status, busy, error, localAvailable, canStart } = setup
const heading = ref(null)
const dialog = ref(null)
let poll
const stage = computed(() => step.value === 'welcome' ? 0 : step.value === 'ready' ? 2 : 1)
const progress = computed(() => {
  const value = status.value?.progress
  return value?.total > 0 && Number.isFinite(value.received) ? Math.max(0, Math.min(100, value.received / value.total * 100)) : undefined
})
const transferBytes = computed(() => {
  const files = plan.value?.components
  const onlineFiles = files?.filter(file => file.sourceMode !== 'offline')
  return onlineFiles && onlineFiles.every(file => Number.isFinite(file.bytes)) ? onlineFiles.reduce((total, file) => total + file.bytes, 0) : null
})
const localCopyBytes = computed(() => {
  const files = plan.value?.components?.filter(file => file.sourceMode === 'offline')
  return files?.length && files.every(file => Number.isFinite(file.bytes)) ? files.reduce((total, file) => total + file.bytes, 0) : null
})
const hardwareDetails = computed(() => {
  const hardware = plan.value?.hardware
  if (!hardware) return []
  const platforms = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  const details = [
    ['Operating system', [platforms[hardware.platform] || hardware.platform, hardware.arch].filter(Boolean).join(' · ') || 'Unknown'],
    ['Processor', hardware.cpu || 'Unknown'],
    ['Logical processors', hardware.cpuCount || 'Unknown'],
    [hardware.unifiedMemory ? 'Unified memory' : 'Memory', size(hardware.totalMemoryBytes)],
    ['Currently available memory', size(hardware.availableMemoryBytes)],
    ['Graphics', hardware.gpu || 'Unknown'],
  ]
  if (hardware.unifiedMemory) details.push(['Graphics memory', 'Shared with unified memory'])
  else if (hardware.gpuDevices?.length) {
    for (const device of hardware.gpuDevices) details.push([`${device.name} dedicated memory`, size(device.dedicatedMemoryBytes)])
  } else details.push(['Dedicated graphics memory', size(hardware.videoMemoryBytes)])
  return details
})
function size(bytes) {
  if (!Number.isFinite(bytes)) return 'Not yet known'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`
}
// Archive-delivered components retrieve fewer bytes than they install.
function unpacked(file) {
  return Number.isFinite(file.bytes) && Number.isFinite(file.installedBytes) && file.installedBytes !== file.bytes
}
function describe(value) {
  if (Array.isArray(value)) return value.map(describe).join(', ')
  if (value && typeof value === 'object') return Object.entries(value).map(([key, entry]) => `${humanLabel(key)}: ${describe(entry)}`).join(' · ')
  return value
}
function humanLabel(key) {
  const names = { totalMemoryBytes: 'Memory (bytes)', availableMemoryBytes: 'Available memory (bytes)', freeMemoryBytes: 'Free memory (bytes)', platform: 'Operating system', arch: 'Processor architecture', cpus: 'Processors', cpu: 'Processor', cpuCount: 'Processor cores', gpu: 'Graphics processor', ramBytes: 'Memory (bytes)' }
  return names[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase())
}
async function leave(event = 'close') {
  if (await (step.value === 'ready' ? setup.complete() : setup.skip())) emit(event)
}
watch(step, async () => { await nextTick(); heading.value?.focus() })
onMounted(async () => {
  dialog.value?.showModal()
  await setup.initialize()
  poll = setInterval(() => { if (step.value === 'progress' && !busy.value) setup.refresh() }, 1500)
  heading.value?.focus()
})
onUnmounted(() => clearInterval(poll))
</script>

<template>
  <dialog
    ref="dialog"
    class="onboarding"
    aria-modal="true"
    :aria-label="`${BRAND_NAME} setup`"
    data-testid="onboarding-dialog"
    :data-step="step"
    :aria-busy="busy || step === 'checking'"
    @cancel.prevent="leave()"
  >
    <header class="setup-header">
      <span class="brand">{{ BRAND_NAME }}</span>
      <nav aria-label="Setup progress">
        <span
          v-for="(label, index) in ['Welcome', 'Processing', 'Ready']"
          :key="label"
          :aria-current="stage === index ? 'step' : undefined"
          :class="{ active: stage === index }"
        ><b>{{ index + 1 }}</b><span>{{ label }}</span></span>
      </nav>
    </header>
    <main class="focused">
      <template v-if="step === 'welcome'">
        <p class="eyebrow">
          Welcome to {{ BRAND_NAME }}
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Your library.<br>Your stage.
        </h1>
        <p class="lead">
          Play your karaoke files, or prepare audio from your library with vocals, music, and timed lyrics.
        </p>
        <div
          class="wave"
          aria-hidden="true"
        >
          <i
            v-for="(height, index) in [18,32,54,27,68,90,49,74,100,64,40,80,57,32,60,85,45,24,50,32,18]"
            :key="index"
            :style="{ height: `${height}px` }"
          />
        </div>
        <div class="actions">
          <button
            class="primary"
            data-testid="onboarding-get-started"
            :disabled="busy"
            @click="setup.chooseProcessing"
          >
            Get started →
          </button>
          <button
            class="text-button"
            :disabled="busy"
            @click="leave()"
          >
            I already have karaoke files →
          </button>
        </div>
        <p class="quiet">
          No processing setup is needed to play existing karaoke files.
        </p>
      </template>

      <template v-else-if="step === 'choose'">
        <p class="eyebrow">
          Song processing · optional
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Where should we<br>prepare your songs?
        </h1>
        <p class="lead">
          Choose this computer or your own cloud deployment. You can return with “Set up song processing” in your library.
        </p>
        <div
          class="choices"
          role="group"
          aria-label="Where to process songs"
        >
          <button
            class="choice"
            data-testid="onboarding-choice-local"
            :class="{ chosen: choice === 'local' }"
            :aria-pressed="choice === 'local'"
            :disabled="busy || !localAvailable"
            aria-describedby="local-reason"
            @click="choice = 'local'"
          >
            <span
              class="choice-symbol"
              aria-hidden="true"
            >▣</span>
            <strong>On this computer</strong>
            <span>Your audio stays here. No cloud processing charges.</span>
            <small id="local-reason">{{ localAvailable ? 'Processing speed depends on your hardware and models.' : plan?.reason || 'Local setup is currently unavailable.' }}</small>
            <span class="badge">{{ localAvailable ? 'Recommended' : 'Currently unavailable' }}</span>
          </button>
          <button
            class="choice"
            :class="{ chosen: choice === 'modal' }"
            :aria-pressed="choice === 'modal'"
            :disabled="busy"
            @click="choice = 'modal'"
          >
            <span
              class="choice-symbol"
              aria-hidden="true"
            >☁</span>
            <strong>My Modal account</strong>
            <span>Use your own cloud hardware. Internet connection required.</span>
            <small>You control the account and pay Modal directly. Usage may incur charges.</small>
            <span class="badge neutral">Your own cloud deployment</span>
          </button>
        </div>
        <div class="actions">
          <button
            class="primary"
            data-testid="onboarding-continue"
            :disabled="busy || (choice === 'local' && !localAvailable)"
            @click="setup.continueChoice"
          >
            Continue →
          </button>
          <button
            v-if="!localAvailable"
            class="text-button"
            :disabled="busy"
            @click="setup.chooseProcessing"
          >
            Check local setup again
          </button>
        </div>
        <details>
          <summary>Computer details and processing estimates</summary>
          <template v-if="plan?.hardware">
            <p
              v-for="[label, value] in hardwareDetails"
              :key="label"
            >
              {{ label }}: {{ value }}
            </p>
          </template>
          <p v-else>
            Hardware information is not available.
          </p>
          <dl class="estimates">
            <div
              v-for="phase in ['Lead vocal separation', 'Backing vocal separation', 'Transcription', 'Alignment']"
              :key="phase"
            >
              <dt>{{ phase }}</dt><dd>Not yet measured on this hardware</dd>
            </div>
          </dl><p>Processing times have not yet been measured on this computer.</p>
          <template v-if="plan?.memoryRequirements?.evidenceAvailable">
            <p>Measured memory requirement, including headroom: {{ size(plan.memoryRequirements.ramBytes) }} RAM<span v-if="plan.memoryRequirements.dedicatedVideoMemoryBytes"> and {{ size(plan.memoryRequirements.dedicatedVideoMemoryBytes) }} dedicated graphics memory</span>.</p>
            <p>{{ plan.memoryQualification?.reason }}</p>
            <p
              v-for="warning in plan.memoryQualification?.warnings || []"
              :key="warning"
            >
              {{ warning }}
            </p>
          </template>
          <p v-else>
            No measured memory recommendation is available for this release target.
          </p>
        </details>
      </template>

      <template v-else-if="step === 'consent'">
        <p class="eyebrow">
          One-time setup
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Review your installation.
        </h1>
        <p class="lead">
          Install the processing tools and models for separation and timed lyrics. Files are retrieved from the sources below only when you choose to set up.
        </p>
        <p v-if="plan?.qualificationScope === 'private-smoke'">
          Private test build: local processing in this build passed a single-song smoke test only. It has not completed full release qualification.
        </p>
        <dl class="facts">
          <div><dt>Transfer size</dt><dd>{{ size(transferBytes) }}</dd></div>
          <div v-if="localCopyBytes !== null">
            <dt>Local model files</dt><dd>{{ size(localCopyBytes) }}</dd>
          </div>
          <div><dt>Space needed</dt><dd>{{ size(plan?.diskRequiredBytes) }}</dd></div><div><dt>Available</dt><dd>{{ size(plan?.diskFreeBytes) }}</dd></div>
        </dl>
        <details>
          <summary>Have a complete model folder?</summary>
          <p v-if="plan?.modelSource === 'offline'">
            Models will be read from your selected folder and verified. Missing files will stop setup. The processing runtime may still need to be retrieved separately.
          </p>
          <p v-else>
            Choose a complete model folder to use files you already have. {{ BRAND_NAME }} will verify each file before installing it.
          </p>
          <button
            class="text-button"
            :disabled="busy"
            @click="setup.chooseModelSource('offline')"
          >
            Choose model folder…
          </button>
          <button
            v-if="plan?.modelSource === 'offline'"
            class="text-button"
            :disabled="busy"
            @click="setup.chooseModelSource('upstream')"
          >
            Use upstream model sources
          </button>
        </details>
        <p
          v-if="!localAvailable"
          class="alert"
        >
          {{ plan?.reason || 'Setup is unavailable on this computer.' }}
        </p>
        <details open>
          <summary>Components, sources, and terms</summary>
          <ul
            v-if="plan?.components?.length"
            class="components"
            data-testid="onboarding-consent-components"
          >
            <li
              v-for="file in plan.components"
              :key="file.label"
            >
              <strong>{{ file.label }}</strong> · {{ size(file.bytes) }} ({{ Number.isFinite(file.bytes) ? `${file.bytes.toLocaleString()} bytes` : 'exact size unavailable' }})<template v-if="unpacked(file)"> to retrieve, {{ size(file.installedBytes) }} installed</template><p>Source: {{ describe(file.sources) || 'Not provided' }}</p><p>Terms: {{ describe(file.terms) || 'Not provided' }}</p>
            </li>
          </ul>
          <p v-else>
            No qualified installation plan is available.
          </p>
        </details>
        <div class="actions">
          <button
            class="primary"
            data-testid="onboarding-install"
            :disabled="!canStart"
            @click="setup.start"
          >
            Install tools and models →
          </button><button
            class="text-button"
            :disabled="busy"
            @click="setup.continueChoice"
          >
            Check available space again
          </button><button
            class="text-button"
            :disabled="busy"
            @click="setup.chooseProcessing"
          >
            ← Back
          </button>
        </div>
      </template>

      <template v-else-if="step === 'modal'">
        <p class="eyebrow">
          Your own Modal deployment
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Your account.<br>Your control.
        </h1>
        <p class="lead">
          Modal processing uses cloud resources in your own account. Audio needed for processing leaves this computer for your deployment.
        </p>
        <DesktopModalSetup @ready="step = 'ready'" @restart="setup.restart" />
        <div class="actions">
          <button
            class="text-button"
            :disabled="busy"
            @click="setup.chooseProcessing"
          >
            ← Choose another processing option
          </button>
        </div>
      </template>

      <template v-else-if="step === 'checking'">
        <p class="eyebrow">
          Song processing
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Checking your setup.
        </h1>
        <p class="lead">
          You can use your library while this check finishes.
        </p>
        <div
          class="panel"
          role="status"
        >
          <p>Checking your local processing setup…</p><progress aria-label="Checking local processing setup" />
        </div>
      </template>

      <template v-else-if="step === 'progress'">
        <p class="eyebrow">
          Setting up song processing
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          We’ll take it from here.
        </h1>
        <p class="lead">
          You can use your library while setup continues.
        </p>
        <div
          class="panel"
          role="status"
        >
          <h2>{{ status?.phase || 'Setup in progress' }}</h2><p>{{ status?.message || 'Waiting for setup status…' }}</p><progress
            :value="progress"
            max="100"
            aria-label="Setup progress"
          /><p
            v-if="progress !== undefined"
            class="quiet"
          >
            <template v-if="status?.progress?.phase === 'retrieve'">Retrieving the processing tools archive<template v-if="status.progress.part && status.progress.parts">, part {{ status.progress.part }} of {{ status.progress.parts }}</template></template><template v-else-if="status?.progress?.phase === 'extract'">Unpacking and checking processing tools</template><template v-else>{{ status?.progress?.file }}</template> · {{ status?.progress?.received?.toLocaleString() }} / {{ status?.progress?.total?.toLocaleString() }} bytes ({{ Math.round(progress) }}% of {{ status?.progress?.phase === 'retrieve' ? 'this part' : status?.progress?.phase === 'extract' ? 'the processing tools' : 'this file' }})
          </p>
        </div>
        <details data-testid="onboarding-setup-controls">
          <summary>Setup controls</summary><button
            class="text-button"
            data-testid="onboarding-cancel"
            :disabled="busy"
            @click="setup.cancel"
          >
            Cancel setup
          </button>
        </details>
      </template>

      <template v-else-if="step === 'error'">
        <p class="eyebrow">
          Setup needs attention
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          {{ status?.state === 'cancelled' ? 'Setup cancelled.' : status?.phase === 'verification' ? 'Setup needs to be verified again.' : 'Setup could not finish.' }}
        </h1>
        <p class="lead">
          {{ status?.error || status?.message || 'Review setup and try again when you are ready.' }}
        </p>
        <p>Your library is still available. Reopening setup will check the current installation before offering installation.</p>
        <div class="actions">
          <button
            class="primary"
            data-testid="onboarding-retry"
            :disabled="busy"
            @click="setup.chooseProcessing"
          >
            Review setup and retry
          </button>
        </div>
      </template>

      <template v-else-if="step === 'restart'">
        <p class="eyebrow">
          One last step
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Restart to finish setup.
        </h1>
        <p class="lead">
          The installed processing tools need an app restart before they can be used. You can restart now or return later.
        </p>
        <div class="actions">
          <button
            class="primary"
            data-testid="onboarding-restart"
            :disabled="busy"
            @click="setup.restart"
          >
            Restart {{ BRAND_NAME }} →
          </button>
        </div>
      </template>

      <template v-else-if="step === 'ready'">
        <p class="eyebrow">
          You’re ready
        </p>
        <h1
          ref="heading"
          tabindex="-1"
        >
          Let’s add your first song.
        </h1>
        <p class="lead">
          {{ choice === 'modal' ? 'Your Modal connection is ready.' : 'Local song processing is ready.' }} Add audio from your library, then review and edit its lyrics before your show.
        </p>
        <div
          class="ready-mark"
          aria-hidden="true"
        >
          ✓
        </div>
        <div class="actions">
          <button
            class="primary"
            :disabled="busy"
            @click="leave('add-song')"
          >
            Add a song →
          </button>
        </div>
      </template>
      <p
        v-if="error"
        class="alert"
        role="alert"
      >
        {{ error }}
      </p>
      <button
        v-if="step !== 'welcome'"
        class="text-button library"
        :disabled="busy"
        @click="leave()"
      >
        {{ ['ready', 'progress', 'checking'].includes(step) ? 'Open my library →' : 'Skip setup and open my library' }}
      </button>
    </main>
  </dialog>
</template>

<style scoped>
.onboarding{position:fixed;inset:0;margin:0;width:100vw;height:100dvh;max-width:none;max-height:none;border:0;overflow-y:auto;z-index:1000;box-sizing:border-box;background:#0e1118;color:#f7eee2;padding:30px 40px 60px;font-family:inherit;color-scheme:dark}.setup-header{max-width:1020px;margin:auto;display:flex;justify-content:space-between;align-items:center;gap:20px}.brand{font-size:22px;font-weight:750;letter-spacing:-.7px}nav{display:flex;gap:20px;color:#8992a4;font-size:12px}nav>span{display:flex;align-items:center;gap:7px}nav b{display:grid;place-items:center;width:23px;height:23px;border:1px solid #465063;border-radius:50%}nav .active{color:#f7e7c8}nav .active b{border-color:#e23e57;background:#e23e5722}.focused{max-width:620px;margin:60px auto 0}h1{font-size:42px;line-height:1.12;letter-spacing:-1.4px;font-weight:650;margin:16px 0 22px}h1:focus{outline:none}h2{font-size:19px;margin:0 0 8px}p{color:#a9afbd;line-height:1.7;font-size:14px}.lead{font-size:16px;margin-bottom:28px}.eyebrow{color:#e98694;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}.quiet{font-size:12px;color:#9ba4b4}.actions{display:flex;flex-direction:column;align-items:flex-start;gap:7px;margin-top:28px}button{font:inherit;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.65}button:focus-visible,summary:focus-visible{outline:3px solid #f2cf7a;outline-offset:4px}.primary{background:#e23e57;border:1px solid #e23e57;border-radius:7px;color:white;font-weight:600;padding:15px 23px;font-size:14px;min-width:210px}.text-button{border:0;background:none;color:#bbc3d2;padding:10px 0;font-size:12px;text-align:left}.library{margin-top:12px}.wave{height:140px;display:flex;align-items:center;gap:9px;margin:20px 0 30px}.wave i{width:10px;border-radius:8px;background:linear-gradient(#eb6c80,#e23e57)}.choices{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:28px 0}.choice{display:flex;flex-direction:column;align-items:flex-start;text-align:left;background:#191e29;color:#eee8df;border:1px solid #3b4353;border-radius:12px;padding:22px;gap:16px}.choice.chosen{border-color:#e23e57;box-shadow:0 0 0 1px #e23e57;background:#e23e570b}.choice strong{font-size:18px}.choice>span:not(.badge):not(.choice-symbol){color:#b4bbc9;font-size:13px;line-height:1.65}.choice small{color:#a4adbd;font-size:12px;line-height:1.7}.choice-symbol{font-size:25px}.badge{font-size:10px;color:#bcddc0;background:#294034;padding:5px 8px;border-radius:4px;margin-top:auto}.badge.neutral{background:#282f3d;color:#b8c0ce}details{margin-top:20px;font-size:12px;color:#b8c0d0}summary{cursor:pointer}details p{font-size:12px;overflow-wrap:anywhere}details li{margin:12px 0;line-height:1.7}.facts{display:flex;gap:32px;border-block:1px solid #323947;padding:25px 0;margin:20px 0}.facts dt{color:#9ba4b4;font-size:12px;margin-bottom:9px}.facts dd{margin:0;font-size:20px}.panel{padding:24px;background:#191e29;border:1px solid #323947;border-radius:12px}.panel p:last-child{margin-bottom:0}.alert{border-left:3px solid #e8bc6f;padding:12px 16px;background:#e8bc6f0b;color:#e9d3ad}.ready-mark{display:grid;place-items:center;border:1px solid #53664e;border-radius:50%;width:76px;height:76px;color:#d9e6b1;font-size:30px;margin:32px 0}progress{width:100%;accent-color:#e23e57;margin-top:16px}.components{padding-left:20px}@media(max-width:600px){.onboarding{padding:24px 18px 40px}.focused{margin-top:38px}h1{font-size:34px}.lead{font-size:14px}nav{gap:8px}nav>span>span{display:none}.choices{grid-template-columns:1fr}.facts{flex-wrap:wrap;gap:20px}.wave{gap:6px}.wave i{width:8px}}
</style>
