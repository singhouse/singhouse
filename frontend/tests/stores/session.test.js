// SPDX-License-Identifier: AGPL-3.0-only
// Core single-host session store: probe (config → me), the build/backend
// mismatch guard, unlock, and lock.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const config = vi.fn()
const me = vi.fn()
const unlock = vi.fn()
const lock = vi.fn()

vi.mock('@/api/client', () => ({
  sessionApi: {
    config: (...a) => config(...a),
    me: (...a) => me(...a),
    unlock: (...a) => unlock(...a),
    lock: (...a) => lock(...a),
  },
}))

import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  config.mockReset()
  me.mockReset()
  unlock.mockReset()
  lock.mockReset()
})

describe('probe', () => {
  it('single-host gate open → ready with identity', async () => {
    config.mockResolvedValue({ data: { mode: 'single_host', password_required: false } })
    me.mockResolvedValue({ data: { id: 1, name: 'Host', gate_enabled: false } })
    const s = useSessionStore()
    await s.probe()
    expect(s.status).toBe('ready')
    expect(s.mode).toBe('single_host')
    expect(s.gateEnabled).toBe(false)
    expect(s.identity).toEqual({ id: 1, name: 'Host', gate_enabled: false })
  })

  it('locked gate (me 401) → locked, gateEnabled true', async () => {
    config.mockResolvedValue({ data: { mode: 'single_host', password_required: true } })
    me.mockRejectedValue(Object.assign(new Error('locked'), { status: 401 }))
    const s = useSessionStore()
    await s.probe()
    expect(s.status).toBe('locked')
    expect(s.gateEnabled).toBe(true)
    expect(s.identity).toBeNull()
  })

  it('multi_user backend on a core bundle → mismatch, never calls /me', async () => {
    // premium's describe() reports password_required — the gate is a single-
    // host concept and must NOT surface as gateEnabled in multi mode.
    config.mockResolvedValue({ data: { mode: 'multi_user', password_required: true } })
    const s = useSessionStore()
    await s.probe()
    expect(s.status).toBe('mismatch')
    expect(s.isMismatch).toBe(true)
    expect(s.gateEnabled).toBe(false)
    expect(me).not.toHaveBeenCalled()
  })

  it('unreachable config → fail closed as locked', async () => {
    config.mockRejectedValue(new Error('network down'))
    const s = useSessionStore()
    await s.probe()
    expect(s.status).toBe('locked')
    expect(s.identity).toBeNull()
  })
})

describe('unlock / lock', () => {
  it('unlock sets identity and marks ready', async () => {
    unlock.mockResolvedValue({ data: { id: 1, name: 'Host', gate_enabled: true } })
    const s = useSessionStore()
    await s.unlock('hunter2')
    expect(unlock).toHaveBeenCalledWith('hunter2')
    expect(s.status).toBe('ready')
    expect(s.identity).toEqual({ id: 1, name: 'Host', gate_enabled: true })
  })

  it('lock clears identity even if the request fails', async () => {
    lock.mockRejectedValue(new Error('boom'))
    const s = useSessionStore()
    s.identity = { id: 1 }
    s.status = 'ready'
    await s.lock()
    expect(s.status).toBe('locked')
    expect(s.identity).toBeNull()
  })
})
