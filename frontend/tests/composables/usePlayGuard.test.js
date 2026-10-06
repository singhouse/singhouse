// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlayerStore } from '@/stores/player'
import { usePlayGuard } from '@/composables/usePlayGuard'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => usePlayGuard().cancel())

describe('usePlayGuard', () => {
  it('runs the action at once unless the deck is playing', async () => {
    const { guard, pending } = usePlayGuard()
    const action = vi.fn()
    guard(action)
    expect(action).toHaveBeenCalledTimes(1)
    expect(pending.value).toBe(null)
  })

  it('holds the action while playing until it is answered', async () => {
    usePlayerStore().setPlayState('playing')
    const { guard, pending, confirm } = usePlayGuard()
    const action = vi.fn()
    const result = guard(action, { kind: 'load', title: 'Synthetic Tune' })
    expect(pending.value).toMatchObject({ kind: 'load', title: 'Synthetic Tune' })
    expect(action).not.toHaveBeenCalled()
    confirm()
    await expect(result).resolves.toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    expect(pending.value).toBe(null)
  })

  it('a newer guarded action replaces an unanswered one', async () => {
    usePlayerStore().setPlayState('playing')
    const { guard, pending, confirm } = usePlayGuard()
    const first = vi.fn()
    const second = vi.fn()
    const firstResult = guard(first, { kind: 'load', title: 'One' })
    const secondResult = guard(second, { kind: 'load', title: 'Two' })
    await expect(firstResult).resolves.toBe(false)
    expect(pending.value).toMatchObject({ title: 'Two' })
    confirm()
    await expect(secondResult).resolves.toBe(true)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
