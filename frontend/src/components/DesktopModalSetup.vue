<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const props = defineProps({ bridge: { type: Object, default: () => window.karaokeDesktop } })
const status = ref(null)
const result = ref(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const form = reactive({ app: '', environment: 'main', version: 1, tokenId: '', tokenSecret: '', uploads: false, usage: false })
const valid = computed(() => form.app.trim() && form.environment.trim() && Number.isSafeInteger(Number(form.version))
  && Number(form.version) > 0 && form.tokenId.trim() && form.tokenSecret.trim())
const secrets = ref([])
function clearSecrets() {
  form.tokenId = ''
  form.tokenSecret = ''
  for (const input of secrets.value) if (input) input.value = ''
}
async function action(work, failure) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try { await work() } catch { error.value = failure }
  finally { busy.value = false }
}
async function refresh() {
  status.value = await props.bridge.getModalStatus()
  if (status.value?.configured) {
    form.app = status.value.app || ''
    form.environment = status.value.environment || 'main'
    form.version = status.value.version || 1
    form.uploads = status.value.consent?.uploads === true
    form.usage = status.value.consent?.usage === true
  }
  if (status.value?.error) error.value = 'The saved configuration could not be read. Review your connection settings.'
}
function save() {
  if (!valid.value || busy.value || status.value?.safeStore === false) return
  const config = { app: form.app.trim(), environment: form.environment.trim(), version: Number(form.version),
    tokenId: form.tokenId.trim(), tokenSecret: form.tokenSecret.trim(), consent: { uploads: form.uploads, usage: form.usage } }
  clearSecrets()
  result.value = null
  return action(async () => {
    try { await props.bridge.saveModalConfig(config) }
    finally { config.tokenId = ''; config.tokenSecret = '' }
    await refresh()
    notice.value = 'Configuration saved. No audio was uploaded and processing remains disabled.'
  }, 'Configuration could not be saved. Enter your credentials again and retry.')
}
function check() {
  if (!status.value?.configured) return
  result.value = null
  return action(async () => {
    const value = await props.bridge.checkModalConnection()
    if (value?.schema !== 1) throw new Error('Invalid response')
    result.value = { accessChecked: value.accessChecked === true, compatible: value.compatible === true }
  }, 'Connection metadata could not be checked. Review the saved account and deployment, then retry.')
}
function forget() {
  clearSecrets()
  result.value = null
  return action(async () => {
    status.value = await props.bridge.forgetModalConfig()
    form.uploads = false
    form.usage = false
    notice.value = 'Local credentials removed. The remote token and any running jobs are unchanged.'
  }, 'Local credentials could not be removed. Retry before leaving this computer.')
}
function help(topic) {
  return action(() => props.bridge.openSetupHelp(topic), 'The guide could not be opened. Try again.')
}
onMounted(() => action(refresh, 'Desktop connection settings are unavailable.'))
onBeforeUnmount(clearSecrets)
</script>

<template>
  <section
    class="modal-setup"
    aria-label="Modal account setup"
    :aria-busy="busy"
  >
    <ol class="steps">
      <li>
        <h2>Your account</h2>
        <p>Use your own Modal account. You control the deployment and pay Modal directly for its resource usage.</p>
        <button
          type="button"
          :disabled="busy"
          @click="help('account')"
        >
          Open account guide ↗
        </button>
        <button
          type="button"
          :disabled="busy"
          @click="help('pricing')"
        >
          Review current pricing ↗
        </button>
      </li>
      <li>
        <h2>Your deployment</h2>
        <p>Follow the deployment guide in your account, then enter its application, environment and deployment version below. This screen does not deploy cloud resources.</p>
        <button
          type="button"
          :disabled="busy"
          @click="help('deployment')"
        >
          Open deployment guide ↗
        </button>
      </li>
      <li>
        <h2>Save and check your connection</h2>
        <p>Saving and checking only stores configuration and checks account and deployment metadata. Neither action uploads audio or starts processing.</p>
        <p v-if="status?.configured">
          Credentials are stored on this computer. Checks use that saved configuration. To replace it, enter both token fields and save again.
        </p>
        <p
          v-if="status?.safeStore === false"
          role="alert"
        >
          Secure credential storage is unavailable on this computer. Credentials cannot be saved.
        </p>
        <form
          autocomplete="off"
          @submit.prevent="save"
        >
          <fieldset :disabled="busy">
            <label>Application name<input
              v-model="form.app"
              name="app"
              required
              autocomplete="off"
            ></label>
            <label>Environment<input
              v-model="form.environment"
              name="environment"
              required
              autocomplete="off"
            ></label>
            <label>Deployment version<input
              v-model.number="form.version"
              name="version"
              type="number"
              min="1"
              step="1"
              required
            ></label>
            <label>Token ID<input
              :ref="element => secrets[0] = element"
              v-model="form.tokenId"
              name="tokenId"
              type="password"
              required
              autocomplete="new-password"
              spellcheck="false"
            ></label>
            <label>Token secret<input
              :ref="element => secrets[1] = element"
              v-model="form.tokenSecret"
              name="tokenSecret"
              type="password"
              required
              autocomplete="new-password"
              spellcheck="false"
            ></label>
            <label class="consent"><input
              v-model="form.uploads"
              name="uploads"
              type="checkbox"
            >I allow future song processing to upload the necessary audio to my own Modal deployment.</label>
            <label class="consent"><input
              v-model="form.usage"
              name="usage"
              type="checkbox"
            >I understand future cloud processing can incur charges in my Modal account.</label>
            <p>You can save with these permissions unchecked. Checking access does not grant permission to process songs.</p>
            <button
              class="primary"
              type="submit"
              :disabled="!valid || status?.safeStore === false"
            >
              Save configuration
            </button>
          </fieldset>
        </form>
        <div class="actions">
          <button
            type="button"
            :disabled="busy || !status?.configured"
            @click="check"
          >
            Check saved connection
          </button>
          <button
            type="button"
            :disabled="busy || (!status?.configured && !status?.error)"
            @click="forget"
          >
            Forget local credentials
          </button>
        </div>
        <p>Forgetting removes credentials stored by this app. It does not revoke your remote token or stop running jobs.</p>
      </li>
    </ol>
    <div
      v-if="result"
      class="result"
      role="status"
    >
      <h2>{{ result.accessChecked ? 'Account access verified' : 'Account access not verified' }}</h2>
      <p>{{ result.compatible && result.accessChecked ? 'Deployment metadata is compatible. Processing is not yet qualified.' : 'Deployment compatibility has not been established. Review your deployment settings and guide.' }}</p>
      <p>Processing remains disabled. A metadata check does not verify model quality, successful song processing, or cloud costs.</p>
    </div>
    <p
      v-if="notice"
      role="status"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      class="alert"
      role="alert"
    >
      {{ error }}
    </p>
    <p class="quiet">
      You can continue using your library while cloud processing remains unavailable.
    </p>
  </section>
</template>

<style scoped>
.modal-setup{color:#eee8df}.steps{padding-left:24px}.steps>li{padding:10px 0 20px}h2{font-size:19px;margin:0 0 8px}p{color:#a9afbd;line-height:1.7;font-size:14px}button{font:inherit;cursor:pointer;color:#bbc3d2;background:none;border:0;padding:10px 12px 10px 0;text-align:left;font-size:13px}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:3px solid #f2cf7a;outline-offset:3px}fieldset{border:0;padding:0;margin:18px 0;min-width:0}label{display:flex;flex-direction:column;gap:7px;margin:14px 0;font-size:13px}input:not([type=checkbox]){box-sizing:border-box;width:100%;border:1px solid #465063;border-radius:6px;padding:11px;background:#191e29;color:#f7eee2;font:inherit}.consent{flex-direction:row;align-items:flex-start;line-height:1.6;gap:10px}.consent input{margin-top:4px;accent-color:#e23e57}.primary{background:#e23e57;color:#fff;border-radius:7px;padding:13px 20px}.actions{display:flex;flex-wrap:wrap;gap:12px}.result{padding:20px;background:#191e29;border:1px solid #323947;border-radius:12px}.alert{border-left:3px solid #e8bc6f;padding:12px;color:#e9d3ad}.quiet{font-size:12px}
</style>
