// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Core single-host session store.
 *
 * Replaces the multi-user auth store (which moved to the premium bundle). In
 * single-host mode there is exactly one identity — the Host — behind an
 * optional shared gate password. This store tracks whether the gate is
 * unlocked and remembers the identity /api/auth/me reports.
 *
 * `probe()` reads /api/auth/config first (mode + whether a password is
 * required), then /api/auth/me. The config read also arms the build/backend
 * mismatch guard: a core bundle talking to a multi_user backend can never
 * satisfy that backend's login flow, so we surface an explicit error screen
 * instead of an unlock loop the user can't win.
 */

import { defineStore } from 'pinia'
import { sessionApi } from '@/api/client'

// This bundle's compiled auth mode (vite define): false in the core build,
// true in `build:multi`. Compared against the backend's reported mode to
// detect a build/backend mismatch (a core bundle can't drive a multi_user
// backend).
const BUILD_IS_MULTI = __AUTH_MULTI__

export const useSessionStore = defineStore('session', {
  state: () => ({
    // 'unknown' | 'loading' | 'ready' | 'locked' | 'mismatch'
    status: 'unknown',
    identity: null,       // whatever /api/auth/me returns, or null
    gateEnabled: false,   // a shared password is configured (single-host)
    mode: null,           // 'single_host' | 'multi_user' | null
    error: null,
  }),
  getters: {
    isReady: (s) => s.status === 'ready',
    isLocked: (s) => s.status === 'locked',
    isMismatch: (s) => s.status === 'mismatch',
  },
  actions: {
    async probe() {
      this.status = 'loading'
      this.error = null

      // 1. Mode + password requirement. Always-mounted, never 401s.
      try {
        const { data } = await sessionApi.config()
        this.mode = data?.mode ?? null
        // The gate (shared password) is a single-host concept. The multi-user
        // backend also reports password_required (login is always required),
        // but that must NOT surface as a single-host gate/Lock affordance.
        this.gateEnabled = this.mode === 'single_host' && !!data?.password_required
      } catch (err) {
        // Config is the one endpoint that should always answer. If it fails
        // the backend is unreachable/broken — fail closed as locked.
        this.mode = null
        this.gateEnabled = false
        this.identity = null
        this.status = 'locked'
        return this.status
      }

      // Build/backend mismatch: a core bundle can't drive a multi_user login.
      if (this.mode === 'multi_user' && !BUILD_IS_MULTI) {
        this.identity = null
        this.status = 'mismatch'
        this.error = 'auth build/backend mismatch'
        return this.status
      }

      // 2. Current identity. 401 => gate locked (or anonymous).
      try {
        const { data } = await sessionApi.me()
        this.identity = data
        this.status = 'ready'
      } catch (err) {
        this.identity = null
        this.status = 'locked'
      }
      return this.status
    },

    async unlock(password) {
      this.error = null
      const { data } = await sessionApi.unlock(password)
      this.identity = data
      this.status = 'ready'
      return data
    },

    async lock() {
      try {
        await sessionApi.lock()
      } catch (_) {
        // Ignore — clear local state regardless.
      }
      this.identity = null
      this.status = 'locked'
    },
  },
})
