<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="auth">
    <!-- Build/backend mismatch: a core bundle is talking to a multi-user
         backend. No password can resolve this — it's a deployment error. -->
    <div v-if="session.isMismatch" class="auth__card auth__card--error">
      <div class="auth__logo">⚠️</div>
      <h1 class="auth__title">Auth build mismatch</h1>
      <p class="auth__sub">
        This is the single-host build, but the server is running in
        multi-user mode. Deploy the multi-user frontend build
        (<code>build:multi</code>), or switch the server to single-host.
      </p>
    </div>

    <form v-else class="auth__card" @submit.prevent="onSubmit">
      <div class="auth__logo">🔒</div>
      <h1 class="auth__title">Unlock</h1>
      <p class="auth__sub">Enter the shared host password to continue.</p>

      <label class="field">
        <span class="field__label">Password</span>
        <input
          v-model="password"
          type="password"
          class="field__input"
          autocomplete="current-password"
          required
          autofocus
        />
      </label>

      <button type="submit" class="submit" :disabled="busy || !password">
        {{ busy ? 'Unlocking…' : 'Unlock' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>

      <div class="auth__alt">
        <router-link to="/join" class="auth__alt-link auth__alt-link--muted">
          Just here to sing? Join the queue →
        </router-link>
      </div>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const password = ref('')
const busy = ref(false)
const error = ref(null)

// A direct visit to /unlock (deep link, refresh) may arrive before the guard
// has probed. Ensure we know the mode so the mismatch screen can render.
onMounted(() => {
  if (session.status === 'unknown') session.probe()
})

async function onSubmit() {
  busy.value = true
  error.value = null
  try {
    await session.unlock(password.value)
    const next = typeof route.query.next === 'string' ? route.query.next : '/'
    router.replace(next)
  } catch (e) {
    error.value = e.message || 'Incorrect password.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.auth {
  flex: 1;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: linear-gradient(135deg, #0a0c11 0%, #141821 50%, #0c0e14 100%);
  color: white;
}
.auth__card {
  width: 100%;
  max-width: 420px;
  background: rgba(20, 24, 33, 0.85);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 1rem;
  padding: 2rem 1.5rem;
  backdrop-filter: blur(20px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.auth__card--error { text-align: center; }
.auth__logo { font-size: 2.4rem; text-align: center; }
.auth__title {
  font-size: 1.4rem;
  font-weight: 800;
  margin: 0;
  text-align: center;
  background: linear-gradient(135deg, #ffffff 0%, #f7e7c8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.auth__sub {
  margin: 0 0 0.5rem;
  text-align: center;
  color: rgba(255,255,255,0.5);
  font-size: 0.88rem;
}
.auth__sub code {
  color: rgba(255,255,255,0.8);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field__label {
  font-size: 0.74rem;
  font-weight: 600;
  color: rgba(255,255,255,0.6);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.field__input {
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.1);
  color: white;
  padding: 0.7rem 0.85rem;
  border-radius: 0.5rem;
  font-size: 1rem;
  outline: none;
}
.field__input:focus { border-color: rgba(247, 231, 200,0.5); }
.submit {
  margin-top: 0.4rem;
  padding: 0.8rem;
  border: none;
  border-radius: 0.5rem;
  background: linear-gradient(135deg, #f7e7c8 0%, #e23e57 100%);
  color: #141821;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
}
.submit:disabled { opacity: 0.4; cursor: not-allowed; }
.error { color: #fb7f5c; text-align: center; font-size: 0.88rem; margin: 0; }
.auth__alt {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.4rem;
  text-align: center;
}
.auth__alt-link {
  font-size: 0.85rem;
  color: #f7e7c8;
  text-decoration: none;
}
.auth__alt-link:hover { text-decoration: underline; }
.auth__alt-link--muted { color: rgba(255,255,255,0.45); }
</style>
