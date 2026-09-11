// SPDX-License-Identifier: AGPL-3.0-only
import { createRouter, createWebHistory } from 'vue-router'
import { authGuard } from '@/auth/gate'

const HostShell = () => import('@/views/HostShell.vue')
const UnlockView = () => import('@/views/UnlockView.vue')

// Core routes. Everything a queue system needs — /login + /signup for
// accounts, /screen + /join for the rotation's projector and guest surfaces —
// is added by the premium install via router.addRoute. Core's projector is the
// popout, which is not a route at all.
const routes = [
  {
    path: '/',
    name: 'host',
    component: HostShell,
    meta: { requiresAuth: true },
  },
  {
    // Word-timing lyrics editor. Without :setId it opens the song's active
    // (or first editable) set.
    path: '/songs/:songId(\\d+)/lyrics-editor/:setId(\\d+)?',
    name: 'lyrics-editor',
    component: () => import('@/views/LyricsEditorView.vue'),
    meta: { requiresAuth: true },
  },
  { path: '/unlock',  name: 'unlock',  component: UnlockView, meta: { guestOnly: true } },
]

// Lyrics editor lab: dev-only design playground (fixtures + live preview).
// Excluded from production builds entirely.
if (import.meta.env.DEV) {
  routes.push({
    path: '/lab/editor',
    name: 'editor-lab',
    component: () => import('@/views/EditorLab.vue'),
  })
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Delegate to the active auth guard. Core installs the single-host gate guard
// (auth/gate.js); premium swaps in its multi-user guard via setAuthGate().
router.beforeEach((to, from) => authGuard(to, from))
