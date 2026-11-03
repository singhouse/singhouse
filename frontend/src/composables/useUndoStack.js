// SPDX-License-Identifier: AGPL-3.0-only
//
// A small, host-browser-local undo history. Each `key` names one shared stack
// (every caller with the same key sees the same reactive entries), persisted
// to localStorage under `singhouse.undo.<key>` so a reload or a second tab of
// the host view keeps it. Records are opaque to core: callers push whatever
// JSON-serializable object they need to reverse their own action, and the
// stack stamps three fields on it:
//
//   id   unique per record: the identity to remove(id) by. Never use the
//        position or `at`, because another action (or another tab) can push
//        while an undo is awaiting the server.
//   at   creation time in ms; a caller-supplied finite `at` is kept. Records
//        older than `ttlMs` are dropped.
//   tab  the page load that pushed it (see isOwn), so only that page touches
//        its own local state (deck, pointers) when undoing.
//
// Two tabs share one stack. Every mutation (push included) re-reads storage
// before writing (read-modify-write), peek({ fresh: true }) re-reads it before
// a decision, and withLock() serializes a whole undo across tabs through the
// Web Locks API where the browser has it. Without that API (older browsers,
// and plain-http origins such as a LAN address, where it is not exposed)
// serialization is best-effort: two tabs that undo in the same instant can
// both act on one record.
//
// Records handed out (entries, peek, push, remove, pop) are deep-frozen
// copies detached from the caller's object; a record is never mutated in
// place.
//
// `limit` and `ttlMs` belong to the key: the first useUndoStack(key) call
// fixes them, and a later call with different values keeps the first ones
// (with a warning in development builds).
//
// Storage is best-effort. Every read and write is guarded — private mode, a
// blocked origin or a full quota leaves the stack working in memory only —
// and a corrupt stored value is dropped rather than trusted.
//
// Multi-user consumers: the stack is per browser, not per account. Scope the
// key per user, e.g. useUndoStack('rotation:' + userId), and call
// clearAll('rotation:') on sign-out so one user's undo never reaches the next.
import { computed, readonly, ref } from 'vue'

const PREFIX = 'singhouse.undo.'
export const DEFAULT_LIMIT = 10
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
// A record stamped further ahead than this (a skewed or reset clock, a
// forged value) counts as expired rather than living forever.
const FUTURE_SKEW_MS = 60 * 1000

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  const r = () => Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${r()}-${r()}`
}

// One id per page load; records carry it as `tab`.
export const tabId = randomId()

// key -> { entries: Ref<Array<object>>, storageKey, cap, ttlMs, trustMemory }
const stacks = new Map()
let listening = false

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function isRecord(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
}

// A stored record must carry what push() stamps; anything else is dropped.
function isStamped(e) {
  return isRecord(e) && typeof e.id === 'string' && e.id !== '' && Number.isFinite(e.at)
}

function isLive(e, ttlMs, now = Date.now()) {
  return now - e.at <= ttlMs && e.at - now <= FUTURE_SKEW_MS
}

function live(list, ttlMs, now = Date.now()) {
  return list.filter((e) => isLive(e, ttlMs, now))
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

// A detached, frozen, JSON-shaped copy: what storage would give back.
function frozenCopy(record) {
  return deepFreeze(JSON.parse(JSON.stringify(record)))
}

// null = corrupt as a whole (not an array, or a non-object element);
// otherwise the well-formed records.
function parse(raw) {
  if (raw == null) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    if (!value.every(isRecord)) return null
    return value.filter(isStamped).map(deepFreeze)
  } catch {
    return null
  }
}

// What storage holds now, or `undefined` when it cannot be read (then the
// in-memory stack is authoritative). A corrupt value is removed.
function read(storageKey) {
  const ls = storage()
  if (!ls) return undefined
  let raw
  try {
    raw = ls.getItem(storageKey)
  } catch {
    return undefined
  }
  const parsed = parse(raw)
  if (parsed === null) {
    try {
      ls.removeItem(storageKey)
    } catch {
      /* in-memory only */
    }
    return []
  }
  return parsed
}

function write(stack, list) {
  const ls = storage()
  if (!ls) {
    stack.trustMemory = true
    return
  }
  try {
    if (list.length) ls.setItem(stack.storageKey, JSON.stringify(list))
    else ls.removeItem(stack.storageKey)
    stack.trustMemory = false
  } catch {
    // Quota or blocked storage: the in-memory stack stays authoritative
    // until a write succeeds again.
    stack.trustMemory = true
  }
}

// Read-modify-write: start from storage (another tab may have written since
// the last storage event reached us), apply `fn`, publish to memory and
// storage.
function mutate(stack, ttlMs, fn) {
  const stored = stack.trustMemory ? undefined : read(stack.storageKey)
  const current = live(stored ?? stack.entries.value, ttlMs)
  const next = fn(current)
  stack.entries.value = next
  write(stack, next)
  return next
}

// Another tab wrote (or cleared) a stack we hold: adopt its value.
function onStorage(event) {
  if (event.key === null) {
    // localStorage.clear() in another tab.
    for (const stack of stacks.values()) stack.entries.value = []
    return
  }
  if (typeof event.key !== 'string' || !event.key.startsWith(PREFIX)) return
  const stack = stacks.get(event.key.slice(PREFIX.length))
  if (!stack) return
  const parsed = parse(event.newValue)
  stack.entries.value = live(parsed ?? [], stack.ttlMs)
  stack.trustMemory = false
}

function listen() {
  if (listening || typeof window === 'undefined') return
  try {
    window.addEventListener('storage', onStorage)
    listening = true
  } catch {
    /* no cross-tab sync */
  }
}

function warnOptions(key, stack, cap, ttlMs) {
  let dev = false
  try {
    dev = !!import.meta.env?.DEV
  } catch {
    /* not a Vite build */
  }
  if (dev && (stack.cap !== cap || stack.ttlMs !== ttlMs)) {
    console.warn(
      `useUndoStack('${key}'): limit/ttlMs are fixed by the first caller ` +
        `(${stack.cap}, ${stack.ttlMs}); ignoring (${cap}, ${ttlMs}).`,
    )
  }
}

function getStack(key, cap, ttlMs) {
  let stack = stacks.get(key)
  if (stack) {
    warnOptions(key, stack, cap, ttlMs)
  } else {
    const storageKey = PREFIX + key
    const stored = read(storageKey)
    stack = { entries: ref([]), storageKey, cap, ttlMs, trustMemory: false }
    stacks.set(key, stack)
    const kept = live(stored ?? [], ttlMs)
    stack.entries.value = kept
    if (stored && kept.length !== stored.length) write(stack, kept)
    listen()
  }
  return stack
}

/**
 * Remove every stack whose key starts with `prefix` ('' = every stack), in
 * memory and in storage, including stacks this page never opened.
 * @param {string} [prefix='']
 */
export function clearAll(prefix = '') {
  for (const [key, stack] of stacks) {
    if (key.startsWith(prefix)) {
      stack.entries.value = []
      write(stack, [])
    }
  }
  const ls = storage()
  if (!ls) return
  try {
    const doomed = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k && k.startsWith(PREFIX + prefix)) doomed.push(k)
    }
    for (const k of doomed) ls.removeItem(k)
  } catch {
    /* in-memory only */
  }
}

/**
 * @typedef {object} UndoRecord  the caller's fields plus:
 * @property {string} id   stamped by push(); the identity for remove(id)
 * @property {number} at   ms timestamp; a caller-supplied finite value is kept
 * @property {string} tab  the page load that pushed it (see isOwn)
 */

/**
 * @param {string} key  stack name; persisted as `singhouse.undo.<key>`
 * @param {{ limit?: number, ttlMs?: number }} [options]  fixed per key by
 *   the first caller.
 *   limit: records kept, applied on write (default 10);
 *   ttlMs: records older than this, or stamped more than a minute ahead,
 *   are dropped on load and peek (default 12h)
 * @returns {{
 *   entries: Readonly<import('vue').Ref<UndoRecord[]>>,
 *   canUndo: import('vue').ComputedRef<boolean>,
 *   peek: (opts?: { fresh?: boolean, where?: (r: UndoRecord) => boolean }) => UndoRecord | null,
 *   push: (record: object) => UndoRecord,
 *   remove: (id: string) => UndoRecord | null,
 *   pop: () => UndoRecord | null,
 *   clear: () => void,
 *   isOwn: (record: object | null) => boolean,
 *   isLive: (record: object | null) => boolean,
 *   withLock: (fn: () => any) => Promise<any>,
 * }}
 *   entries are oldest first; every record handed out is a deep-frozen
 *   copy. push() throws a TypeError for anything but a plain object and
 *   returns the stamped record.
 */
export function useUndoStack(key, { limit = DEFAULT_LIMIT, ttlMs = DEFAULT_TTL_MS } = {}) {
  const stack = getStack(
    key,
    Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT),
    Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS,
  )
  const { entries, cap, ttlMs: ttl } = stack

  // Read-modify-write like every mutation, so a push never overwrites a
  // record another tab wrote that has not reached us yet. Synchronous: it
  // does not take the cross-tab lock.
  function push(record) {
    if (!isRecord(record)) throw new TypeError('useUndoStack: push() takes a plain object')
    const now = Date.now()
    const stamped = frozenCopy({
      ...record,
      id: randomId(),
      // Never in the future, so a bad caller value cannot outlive the TTL.
      at: Number.isFinite(record.at) ? Math.min(record.at, now) : now,
      tab: tabId,
    })
    mutate(stack, ttl, (list) => {
      const next = [...list, stamped]
      return next.length > cap ? next.slice(next.length - cap) : next
    })
    return stamped
  }

  // The newest live record (or, with `where`, the newest live record it
  // accepts). Expired records are dropped here, so a stale undo never runs
  // after a long pause. `fresh: true` re-reads storage first, for a decision
  // that must not act on a record another tab already removed whose storage
  // event has not arrived yet.
  function peek({ fresh = false, where = null } = {}) {
    if (fresh && !stack.trustMemory) {
      const stored = read(stack.storageKey)
      if (stored !== undefined) entries.value = stored
    }
    const list = entries.value
    if (list.length && live(list, ttl).length !== list.length) mutate(stack, ttl, (l) => l)
    const now = entries.value
    for (let i = now.length - 1; i >= 0; i--) {
      if (!where || where(now[i])) return now[i]
    }
    return null
  }

  function remove(id) {
    let removed = null
    mutate(stack, ttl, (list) => {
      const i = list.findIndex((e) => e.id === id)
      if (i < 0) return list
      removed = list[i]
      return [...list.slice(0, i), ...list.slice(i + 1)]
    })
    return removed
  }

  // Positional: only safe when nothing is awaited between choosing the
  // record and removing it. An async undo should peek(), do its work, then
  // remove(id).
  function pop() {
    let top = null
    mutate(stack, ttl, (list) => {
      if (!list.length) return list
      top = list[list.length - 1]
      return list.slice(0, -1)
    })
    return top
  }

  function clear() {
    mutate(stack, ttl, () => [])
  }

  // Unexpired under this key's TTL (and not stamped in the future).
  function isLiveRecord(record) {
    return isRecord(record) && Number.isFinite(record.at) && isLive(record, ttl)
  }

  function isOwn(record) {
    return !!record && record.tab === tabId
  }

  // Run `fn` holding the cross-tab lock `singhouse.undo.<key>` (Web Locks
  // API). Without the API (older browsers, insecure origins, test DOMs) `fn`
  // simply runs; every mutation is still a read-modify-write.
  async function withLock(fn) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks || typeof locks.request !== 'function') return fn()
    let ran = false
    try {
      return await locks.request(stack.storageKey, () => {
        ran = true
        return fn()
      })
    } catch (e) {
      if (ran) throw e
      return fn()
    }
  }

  return {
    entries: readonly(entries),
    // Time is not reactive: an entry that expires while shown stays enabled
    // until the next change, and peek() then drops it on click.
    canUndo: computed(() => {
      const list = entries.value
      return list.length > 0 && isLive(list[list.length - 1], ttl)
    }),
    peek,
    push,
    remove,
    pop,
    clear,
    isOwn,
    isLive: isLiveRecord,
    withLock,
  }
}
