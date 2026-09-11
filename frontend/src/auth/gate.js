// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Router auth guard seam.
 *
 * The core default guard drives the single-host gate: probe once, then send
 * any `requiresAuth` route to `/unlock` while the gate is locked, and bounce
 * an already-unlocked visitor away from `guestOnly` routes. Premium replaces
 * the whole guard via `setAuthGate()` with its multi-user (login/signup)
 * variant — the router only ever calls `authGuard`, so it needs no knowledge
 * of which mode is active.
 */

import { useSessionStore } from '@/stores/session'

// The core single-host guard. Premium overrides this object wholesale.
const coreGuard = {
  async beforeEach(to) {
    const session = useSessionStore()
    if (session.status === 'unknown') {
      await session.probe()
    }

    // Build/backend mismatch: always land on /unlock, which renders the
    // explicit mismatch screen. Guard against a redirect loop.
    if (session.isMismatch) {
      return to.name === 'unlock' ? true : { name: 'unlock' }
    }

    if (to.meta.requiresAuth && !session.isReady) {
      return { name: 'unlock', query: { next: to.fullPath } }
    }

    if (to.meta.guestOnly && session.isReady) {
      return { path: '/' }
    }

    return true
  },
}

let activeGuard = coreGuard

/** Replace the router guard (premium install calls this with its own). */
export function setAuthGate(guard) {
  activeGuard = guard
}

/** Delegate target for `router.beforeEach`. */
export function authGuard(to, from) {
  return activeGuard.beforeEach(to, from)
}

// Sign-out seam. Core single-host has no account to sign out of — the host
// UI's exit affordance is the gate Lock (handled in HostShell). Premium
// installs a real logout here (clear the user session + redirect to /login),
// so the host UI keeps a working sign-out in multi-user mode.
let signOutHandler = null

/** Premium install calls this to provide multi-user logout. */
export function setSignOutHandler(fn) {
  signOutHandler = typeof fn === 'function' ? fn : null
}

/** The installed logout handler, or null in the core build. */
export function getSignOutHandler() {
  return signOutHandler
}
