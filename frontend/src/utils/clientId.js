// SPDX-License-Identifier: AGPL-3.0-only
// Browser-generated identity, used in lieu of IP addresses to tell one
// device's queue/wishlist rows from another's. Persisted in localStorage so a
// guest stays on the list across reloads. Cleared when a guest surface leaves
// the queue, or by the user clearing site data.

const KEY = 'karaoke-client-id'

export function getClientId() {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(KEY, id)
  }
  return id
}

export function clearClientId() {
  localStorage.removeItem(KEY)
}
