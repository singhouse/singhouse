// SPDX-License-Identifier: AGPL-3.0-only
const slots = new Map()

export function registerSlot(name, value) {
  slots.set(name, value)
}

export function getSlot(name) {
  return slots.get(name) ?? null
}

export function slotHasContent(name) {
  return slots.has(name)
}
