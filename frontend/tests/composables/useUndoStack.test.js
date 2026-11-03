// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The host-local undo history: one shared stack per key, capped, expiring,
// persisted to localStorage best-effort, kept in step across tabs by the
// storage event and by re-reading storage before every write.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let useUndoStack
let clearAll
let tabId
let DEFAULT_TTL_MS

// The stacks live in a module-level map, so each test gets a fresh module.
async function fresh() {
  vi.resetModules()
  ;({ useUndoStack, clearAll, tabId, DEFAULT_TTL_MS } = await import('@/composables/useUndoStack'))
}

const NOW = 1_800_000_000_000

beforeEach(async () => {
  window.localStorage.clear()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  await fresh()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const stored = (key) => JSON.parse(window.localStorage.getItem(`singhouse.undo.${key}`))
const rec = (n, extra = {}) => ({ n, id: `id-${n}`, at: NOW, tab: 'other-tab', ...extra })
const ns = (list) => list.map((e) => e.n)

describe('useUndoStack', () => {
  it('starts empty', () => {
    const s = useUndoStack('t')
    expect(s.entries.value).toEqual([])
    expect(s.canUndo.value).toBe(false)
    expect(s.peek()).toBe(null)
    expect(s.pop()).toBe(null)
    expect(s.remove('nope')).toBe(null)
  })

  it('pushes oldest-first, stamps id/at/tab, peeks and pops the newest', () => {
    const s = useUndoStack('t')
    const a = s.push({ n: 1 })
    const b = s.push({ n: 2, at: NOW - 5 }) // caller's own `at` is kept
    expect(a).toMatchObject({ n: 1, at: NOW, tab: tabId })
    expect(typeof a.id).toBe('string')
    expect(a.id).not.toBe(b.id)
    expect(b.at).toBe(NOW - 5)
    expect(s.entries.value).toEqual([a, b])
    expect(s.canUndo.value).toBe(true)
    expect(s.peek()).toEqual(b)
    expect(s.pop()).toEqual(b)
    expect(s.entries.value).toEqual([a])
  })

  it('always stamps its own id and tab over the caller’s', () => {
    const s = useUndoStack('t')
    const r = s.push({ n: 1, id: 'mine', tab: 'forged' })
    expect(r.id).not.toBe('mine')
    expect(r.tab).toBe(tabId)
    expect(s.isOwn(r)).toBe(true)
    expect(s.isOwn({ ...r, tab: 'other' })).toBe(false)
    expect(s.isOwn(null)).toBe(false)
  })

  it('falls back to a non-crypto id when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    await fresh()
    const s = useUndoStack('t')
    const a = s.push({ n: 1 })
    const b = s.push({ n: 2 })
    expect(typeof a.id).toBe('string')
    expect(a.id).not.toBe(b.id)
    expect(typeof tabId).toBe('string')
  })

  it.each([[null], [undefined], [42], ['text'], [[1, 2]]])('rejects push(%j)', (value) => {
    const s = useUndoStack('t')
    expect(() => s.push(value)).toThrow(TypeError)
    expect(s.entries.value).toEqual([])
  })

  it('does not mutate the pushed object', () => {
    const s = useUndoStack('t')
    const e = { n: 1 }
    s.push(e)
    expect(e).toEqual({ n: 1 })
  })

  it('exposes entries read-only', () => {
    const s = useUndoStack('t')
    s.push({ n: 1 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    s.entries.value = []
    expect(ns(s.entries.value)).toEqual([1])
    expect(warn).toHaveBeenCalled()
    expect(() => { s.entries.value[0].n = 9 }).toThrow(TypeError)
  })

  it('hands out deep-frozen records detached from the caller’s object', () => {
    const s = useUndoStack('t')
    const input = { n: 1, nested: { v: 1 } }
    const r = s.push(input)
    input.nested.v = 2 // the caller's object is not the stored one
    expect(s.peek().nested.v).toBe(1)
    for (const got of [r, s.peek(), s.entries.value[0]]) {
      expect(Object.isFrozen(got)).toBe(true)
      expect(Object.isFrozen(got.nested)).toBe(true)
      expect(() => { got.nested.v = 99 }).toThrow(TypeError)
    }
    expect(stored('t')[0].nested.v).toBe(1)
    const popped = s.pop()
    expect(Object.isFrozen(popped)).toBe(true)
    const again = s.push({ n: 2 })
    expect(Object.isFrozen(s.remove(again.id))).toBe(true)
  })

  it('freezes records loaded from storage and from another tab', async () => {
    window.localStorage.setItem('singhouse.undo.t', JSON.stringify([rec(1, { nested: { v: 1 } })]))
    await fresh()
    const s = useUndoStack('t')
    expect(Object.isFrozen(s.peek().nested)).toBe(true)
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'singhouse.undo.t', newValue: JSON.stringify([rec(2, { nested: { v: 2 } })]),
    }))
    expect(Object.isFrozen(s.peek().nested)).toBe(true)
  })

  it('fixes limit and ttlMs per key at the first call, and warns on a mismatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const long = useUndoStack('k', { ttlMs: 10_000, limit: 3 })
    long.push({ n: 1 })
    Date.now.mockReturnValue(NOW + 5000)
    const short = useUndoStack('k', { ttlMs: 1000, limit: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    short.push({ n: 2 })
    // The second caller's shorter TTL and cap did not apply.
    expect(ns(long.entries.value)).toEqual([1, 2])
    useUndoStack('k', { ttlMs: 10_000, limit: 3 })
    expect(warn).toHaveBeenCalledTimes(1) // same options: no warning
  })

  it('peek({ where }) returns the newest record it accepts', () => {
    const s = useUndoStack('t')
    s.push({ n: 1, kind: 'a' })
    s.push({ n: 2, kind: 'b' })
    expect(s.peek({ where: (r) => r.kind === 'a' }).n).toBe(1)
    expect(s.peek({ where: () => false })).toBe(null)
    expect(s.peek().n).toBe(2)
  })

  it('peek({ fresh: true }) sees a removal whose storage event has not arrived', () => {
    const s = useUndoStack('t')
    s.push({ n: 1 })
    window.localStorage.removeItem('singhouse.undo.t') // another tab undid it
    expect(s.peek().n).toBe(1) // memory still has it
    expect(s.peek({ fresh: true })).toBe(null)
    expect(s.entries.value).toEqual([])
  })

  it('peek({ fresh: true }) uses memory while storage is unusable', () => {
    const s = useUndoStack('t')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    s.push({ n: 1 })
    expect(s.peek({ fresh: true }).n).toBe(1)
  })

  it('remove(id) takes out exactly that record, wherever it sits', () => {
    const s = useUndoStack('t')
    const a = s.push({ n: 1 })
    const b = s.push({ n: 2 })
    const c = s.push({ n: 3 })
    expect(s.remove(b.id)).toEqual(b)
    expect(ns(s.entries.value)).toEqual([1, 3])
    expect(s.remove(b.id)).toBe(null)
    expect(ns(stored('t'))).toEqual([1, 3])
    s.remove(c.id)
    s.remove(a.id)
    expect(window.localStorage.getItem('singhouse.undo.t')).toBe(null)
  })

  it('remove(id) after a newer push keeps the newer record (no positional pop)', () => {
    const s = useUndoStack('t')
    const a = s.push({ n: 1 })
    const top = s.peek()
    s.push({ n: 2 }) // lands while an undo of `a` is awaiting the server
    s.remove(top.id)
    expect(top.id).toBe(a.id)
    expect(ns(s.entries.value)).toEqual([2])
  })

  it('trims the oldest beyond the default limit of 10', () => {
    const s = useUndoStack('t')
    for (let n = 1; n <= 12; n++) s.push({ n })
    expect(ns(s.entries.value)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(ns(stored('t'))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('honours a custom limit', () => {
    const s = useUndoStack('t', { limit: 2 })
    s.push({ n: 1 }); s.push({ n: 2 }); s.push({ n: 3 })
    expect(ns(s.entries.value)).toEqual([2, 3])
  })

  it('shares one reactive stack per key and keeps keys apart', () => {
    const a = useUndoStack('shared')
    const b = useUndoStack('shared')
    const other = useUndoStack('other')
    a.push({ n: 1 })
    expect(b.entries.value).toEqual(a.entries.value)
    expect(b.canUndo.value).toBe(true)
    expect(b.pop().n).toBe(1)
    expect(a.canUndo.value).toBe(false)
    expect(other.entries.value).toEqual([])
  })

  it('persists under singhouse.undo.<key> and reloads after a page load', async () => {
    const s = useUndoStack('rot')
    const a = s.push({ n: 1 })
    const b = s.push({ n: 2 })
    expect(stored('rot')).toEqual([a, b])

    await fresh() // a reload: new module, same storage, new tab id
    const again = useUndoStack('rot')
    expect(again.entries.value).toEqual([a, b])
    expect(again.isOwn(a)).toBe(false)
    again.pop()
    expect(stored('rot')).toEqual([a])
  })

  it('clear() empties the stack and its storage', () => {
    const s = useUndoStack('t')
    s.push({ n: 1 })
    s.clear()
    expect(s.entries.value).toEqual([])
    expect(window.localStorage.getItem('singhouse.undo.t')).toBe(null)
  })

  describe('expiry', () => {
    it('defaults to 12 hours', () => {
      expect(DEFAULT_TTL_MS).toBe(12 * 60 * 60 * 1000)
    })

    it('drops expired records on load', async () => {
      window.localStorage.setItem('singhouse.undo.ttl', JSON.stringify([
        rec(1, { at: NOW - DEFAULT_TTL_MS - 1 }),
        rec(2, { at: NOW - DEFAULT_TTL_MS }),
      ]))
      await fresh()
      const s = useUndoStack('ttl')
      expect(ns(s.entries.value)).toEqual([2])
      expect(ns(stored('ttl'))).toEqual([2])
    })

    it('drops expired records on peek, and canUndo agrees', () => {
      const s = useUndoStack('ttl')
      s.push({ n: 1 })
      s.push({ n: 2 })
      Date.now.mockReturnValue(NOW + DEFAULT_TTL_MS + 1)
      expect(s.peek()).toBe(null)
      expect(s.entries.value).toEqual([])
      expect(s.canUndo.value).toBe(false)
      expect(window.localStorage.getItem('singhouse.undo.ttl')).toBe(null)
    })

    it('clamps a future caller-supplied `at` to now, so it still expires', () => {
      const s = useUndoStack('ttl')
      const r = s.push({ n: 1, at: NOW + 365 * 86400e3 })
      expect(r.at).toBe(NOW)
      Date.now.mockReturnValue(NOW + DEFAULT_TTL_MS + 1)
      expect(s.peek()).toBe(null)
    })

    it('treats a stored `at` more than a minute ahead as expired', async () => {
      window.localStorage.setItem('singhouse.undo.ttl', JSON.stringify([
        rec(1, { at: 8.64e15 }), rec(2, { at: NOW + 60_000 }), rec(3, { at: NOW + 60_001 }),
      ]))
      await fresh()
      const s = useUndoStack('ttl')
      expect(ns(s.entries.value)).toEqual([2])
      expect(s.isLive(s.peek())).toBe(true)
      expect(s.isLive(rec(9, { at: NOW + 60_001 }))).toBe(false)
      expect(s.isLive(null)).toBe(false)
    })

    it('a clock moved back past the skew expires records stamped before', () => {
      const s = useUndoStack('ttl')
      s.push({ n: 1 })
      Date.now.mockReturnValue(NOW - 120_000)
      expect(s.peek()).toBe(null)
    })

    it('honours a custom ttlMs', () => {
      const s = useUndoStack('short', { ttlMs: 1000 })
      s.push({ n: 1 })
      Date.now.mockReturnValue(NOW + 500)
      s.push({ n: 2 })
      Date.now.mockReturnValue(NOW + 1200)
      expect(s.peek().n).toBe(2)
      expect(ns(s.entries.value)).toEqual([2])
    })
  })

  it.each([
    ['not JSON', '{oops'],
    ['not an array', '{"n":1}'],
    ['non-object entries', '[1,"two"]'],
    ['null entries', '[null]'],
  ])('ignores and cleans a corrupt stored value (%s)', async (_, raw) => {
    window.localStorage.setItem('singhouse.undo.bad', raw)
    await fresh()
    const s = useUndoStack('bad')
    expect(s.entries.value).toEqual([])
    expect(window.localStorage.getItem('singhouse.undo.bad')).toBe(null)
    const r = s.push({ n: 1 })
    expect(stored('bad')).toEqual([r])
  })

  it('drops stored records missing an id or a time', async () => {
    window.localStorage.setItem('singhouse.undo.bad', JSON.stringify([
      { n: 1, at: NOW }, { n: 2, id: 'x' }, { n: 3, id: '', at: NOW }, rec(4),
    ]))
    await fresh()
    expect(ns(useUndoStack('bad').entries.value)).toEqual([4])
  })

  it('works in memory when storage throws on every call', async () => {
    const boom = () => { throw new Error('SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    await fresh()

    const s = useUndoStack('mem')
    expect(() => s.push({ n: 1 })).not.toThrow()
    const two = s.push({ n: 2 })
    expect(ns(s.entries.value)).toEqual([1, 2])
    expect(s.remove(two.id).n).toBe(2)
    expect(s.pop().n).toBe(1)
    expect(() => s.clear()).not.toThrow()
    expect(s.canUndo.value).toBe(false)
  })

  it('works in memory when the localStorage accessor itself throws', async () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    try {
      await fresh()
      const s = useUndoStack('blocked')
      s.push({ n: 1 })
      s.push({ n: 2 })
      expect(s.peek().n).toBe(2)
      expect(ns(s.entries.value)).toEqual([1, 2])
      expect(() => clearAll()).not.toThrow()
    } finally {
      if (desc) Object.defineProperty(window, 'localStorage', desc)
      else delete window.localStorage
    }
  })

  it('keeps in-memory pushes while a quota error blocks writes', () => {
    const s = useUndoStack('quota')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    s.push({ n: 1 })
    s.push({ n: 2 }) // the next write must not re-read the stale storage
    expect(ns(s.entries.value)).toEqual([1, 2])
    setItem.mockRestore()
    s.push({ n: 3 })
    expect(ns(stored('quota'))).toEqual([1, 2, 3])
  })

  describe('cross-tab sync', () => {
    function fire(key, newValue) {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
    }

    it('adopts another tab’s write for a held key', () => {
      const s = useUndoStack('x')
      s.push({ n: 1 })
      fire('singhouse.undo.x', JSON.stringify([rec(7), rec(8)]))
      expect(ns(s.entries.value)).toEqual([7, 8])
      expect(s.peek().n).toBe(8)
      expect(s.isOwn(s.peek())).toBe(false)
    })

    it('drops expired and unstamped records from another tab’s write', () => {
      const s = useUndoStack('x')
      fire('singhouse.undo.x', JSON.stringify([
        rec(6, { at: NOW - DEFAULT_TTL_MS - 1 }), { n: 7, at: NOW }, rec(8),
      ]))
      expect(ns(s.entries.value)).toEqual([8])
    })

    it('empties on a removal, a corrupt value, or a storage clear', () => {
      const s = useUndoStack('x')
      s.push({ n: 1 })
      fire('singhouse.undo.x', null)
      expect(s.entries.value).toEqual([])

      s.push({ n: 2 })
      fire('singhouse.undo.x', '{oops')
      expect(s.entries.value).toEqual([])

      s.push({ n: 3 })
      fire(null, null)
      expect(s.entries.value).toEqual([])
    })

    it('ignores other keys and keys nobody holds', () => {
      const s = useUndoStack('x')
      const r = s.push({ n: 1 })
      fire('singhouse.undo.y', JSON.stringify([rec(9)]))
      fire('something.else', JSON.stringify([rec(9)]))
      expect(s.entries.value).toEqual([r])
    })

    it('re-reads storage before each write, so a missed write is not lost', () => {
      const s = useUndoStack('x')
      s.push({ n: 1 })
      // Another tab writes; its storage event has not reached us yet.
      window.localStorage.setItem('singhouse.undo.x', JSON.stringify([...stored('x'), rec(2)]))
      s.push({ n: 3 })
      expect(ns(s.entries.value)).toEqual([1, 2, 3])
      expect(ns(stored('x'))).toEqual([1, 2, 3])
    })

    it('remove(id) leaves a record another tab just pushed', () => {
      const s = useUndoStack('x')
      const mine = s.push({ n: 1 })
      window.localStorage.setItem('singhouse.undo.x', JSON.stringify([...stored('x'), rec(2)]))
      s.remove(mine.id)
      expect(ns(stored('x'))).toEqual([2])
    })
  })

  describe('clearAll', () => {
    it('clears held and unheld stacks under a prefix, and nothing else', async () => {
      window.localStorage.setItem('singhouse.undo.rot:u2', JSON.stringify([rec(9)]))
      window.localStorage.setItem('unrelated', 'keep')
      const u1 = useUndoStack('rot:u1')
      const q = useUndoStack('queue')
      u1.push({ n: 1 })
      q.push({ n: 2 })

      clearAll('rot:')
      expect(u1.entries.value).toEqual([])
      expect(window.localStorage.getItem('singhouse.undo.rot:u1')).toBe(null)
      expect(window.localStorage.getItem('singhouse.undo.rot:u2')).toBe(null)
      expect(ns(q.entries.value)).toEqual([2])
      expect(window.localStorage.getItem('unrelated')).toBe('keep')

      clearAll()
      expect(q.entries.value).toEqual([])
      expect(window.localStorage.getItem('singhouse.undo.queue')).toBe(null)
      expect(window.localStorage.getItem('unrelated')).toBe('keep')
    })
  })

  describe('withLock', () => {
    it('runs the callback directly without the Web Locks API', async () => {
      vi.stubGlobal('navigator', {})
      const s = useUndoStack('lk')
      await expect(s.withLock(async () => 7)).resolves.toBe(7)
    })

    it('holds singhouse.undo.<key> through the Web Locks API when present', async () => {
      const request = vi.fn((name, cb) => Promise.resolve(cb()))
      vi.stubGlobal('navigator', { locks: { request } })
      const s = useUndoStack('lk')
      await expect(s.withLock(async () => 'done')).resolves.toBe('done')
      expect(request).toHaveBeenCalledWith('singhouse.undo.lk', expect.any(Function))
    })

    it('falls back to running directly when the lock request itself fails', async () => {
      const request = vi.fn(() => Promise.reject(new Error('SecurityError')))
      vi.stubGlobal('navigator', { locks: { request } })
      const s = useUndoStack('lk')
      const fn = vi.fn(async () => 1)
      await expect(s.withLock(fn)).resolves.toBe(1)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('propagates the callback’s own error without running it twice', async () => {
      const request = vi.fn((name, cb) => Promise.resolve().then(cb))
      vi.stubGlobal('navigator', { locks: { request } })
      const s = useUndoStack('lk')
      const fn = vi.fn(async () => { throw new Error('boom') })
      await expect(s.withLock(fn)).rejects.toThrow('boom')
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })
})
