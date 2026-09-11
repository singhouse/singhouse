// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/space-grotesk'
import App from './App.vue'
import { router } from './router'
import './assets/styles.css'

// Boot. The premium bundle (multi-user auth + catalog slot) is pulled in only
// by the multi build. `__AUTH_MULTI__` is a compile-time literal (vite define):
// false in the core build, so Rollup drops the dynamic import entirely and no
// premium JS ever ships to the public core dist. Awaited before mount so
// premium routes + guard are registered before the router's first navigation.
async function boot() {
  if (__AUTH_MULTI__) {
    try {
      await import('@premium/index')
    } catch (err) {
      // A premium bundle that fails to load still mounts the core shell; the
      // session store's build/backend mismatch guard is the graceful fallback.
      console.error('Premium bundle failed to load:', err)
    }
  }

  const app = createApp(App)
  const pinia = createPinia()

  app.use(pinia)
  app.use(router)
  app.mount('#app')
}

boot()
