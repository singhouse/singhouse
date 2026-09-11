// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The popout orphan watchdog. Two prior field failures shape these tests:
//
//   1. "The projector window closes the instant I open it, until I close the
//      whole browser." Root cause: one SHARED BroadcastChannel name across
//      every app tab, plus a watchdog that killed the popup on any heartbeat
//      carrying a foreign sessionId — and heartbeat beacons, once started,
//      ran for the life of their tab. Any second tab that had ever popped out
//      condemned every other tab's popout within one beat. The channel is now
//      per-session, so foreign heartbeats are unhearable by construction.
//
//   2. A popup document destroyed before pagehide could hand the stage element
//      back turns the host's DOM references into Firefox "dead object"
//      wrappers. open() must refuse a dead element BEFORE window.open (or it
//      leaks a blank popup on top of the breakage), and any adoption failure
//      after window.open must close the popup it opened.
//
// The watchdog itself is an injected <script> string, unreachable by normal
// component testing — so these tests capture the injected source from a fake
// popup and execute it against fake window/BroadcastChannel/Date/setInterval,
// driving its clock and messages directly.

// A note on leaks, for whoever extends this file: the composable's heartbeat
// beacon is a MODULE singleton — the first successful open() in this file
// installs it (with that test's fake timers and stubbed BroadcastChannel) and
// it is never torn down, so later tests reuse it as a no-op. Likewise each
// successful open() leaves a closedPoll interval behind under fake timers.
// Nothing here asserts on the beacon, so this is inert today — but do not add
// beacon-behavior assertions without accounting for test order.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { useLyricsWindow } from '@/composables/useLyricsWindow'

class FakeBC {
  constructor(name) { this.name = name }
  postMessage() {}
  close() {}
}

let wrapper = null
let lw = null

function mountLW() {
  wrapper = mount({
    setup() {
      lw = useLyricsWindow()
      return () => null
    },
  })
}

function fakePopup({ appendThrows = false } = {}) {
  const headChildren = []
  const w = {
    closed: false,
    close: vi.fn(),
    addEventListener: vi.fn(),
    headChildren,
  }
  w.document = {
    title: '',
    createElement: () => ({}),
    head: { appendChild: (el) => headChildren.push(el) },
    body: {
      style: {},
      addEventListener: vi.fn(),
      appendChild: appendThrows
        ? vi.fn(() => { throw new Error('append boom') })
        : vi.fn(),
    },
  }
  return w
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('BroadcastChannel', FakeBC)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  lw = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('heartbeat channel', () => {
  it('scopes the injected watchdog to this host session, so foreign tabs are unhearable', async () => {
    // Asserted against the CAPTURED injected source rather than an exported
    // constant: what matters is the channel the popup actually listens on.
    const code = await capturedWatchdogCode()
    expect(code).toContain(JSON.stringify(`karaoke-lyrics-popout:${window.__karaokeHostSession}`))
  })
})

describe('open() against a broken stage element', () => {
  it('refuses a dead element BEFORE opening a window', async () => {
    mountLW()
    const openSpy = vi.spyOn(window, 'open')
    // A Firefox dead-object wrapper throws on EVERY property access; a Proxy
    // whose get trap throws is the closest jsdom-side stand-in.
    const dead = new Proxy({}, {
      get() { throw new TypeError("can't access dead object") },
    })
    await expect(lw.open(dead)).rejects.toThrow(/Reload this page/)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('closes the popup it opened when adoption fails, and rethrows', async () => {
    mountLW()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const w = fakePopup({ appendThrows: true })
    vi.spyOn(window, 'open').mockReturnValue(w)

    await expect(lw.open(el)).rejects.toThrow('append boom')
    expect(w.close).toHaveBeenCalled()
    expect(el.parentNode).toBe(document.body) // never left home
    expect(lw.isOpen.value).toBe(false)
  })

  it('keeps the toggle usable after a late failure — isOpen stays false and a retry works', async () => {
    // isOpen/win are published LAST in open(); a throw from any of the
    // post-adoption steps must leave the composable closed and reopenable,
    // not wedged with isOpen=true and a dead window ref.
    mountLW()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const bad = fakePopup()
    bad.document.body.addEventListener = vi.fn(() => { throw new Error('late boom') })
    const openMock = vi.spyOn(window, 'open').mockReturnValue(bad)

    await expect(lw.open(el)).rejects.toThrow('late boom')
    expect(bad.close).toHaveBeenCalled()
    expect(lw.isOpen.value).toBe(false)
    expect(lw.win.value).toBe(null)

    const good = fakePopup()
    openMock.mockReturnValue(good)
    await lw.open(el)
    expect(lw.isOpen.value).toBe(true)
  })

  it('logs the unrecoverable case loudly when the popup dies holding the element', async () => {
    mountLW()
    const real = document.createElement('div')
    document.body.appendChild(real)
    // Alive at open time, then flipped dead — models the Firefox dead-object
    // wrapper the element becomes when the popup document is destroyed
    // without pagehide handing it back.
    let dead = false
    const el = new Proxy(real, {
      get(t, k) {
        if (dead) throw new TypeError("can't access dead object")
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const w = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(w)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})

    await lw.open(el)
    expect(lw.isOpen.value).toBe(true)

    dead = true
    w.closed = true
    vi.advanceTimersByTime(600) // closedPoll notices; pagehide never fired

    expect(lw.isOpen.value).toBe(false)
    expect(errSpy.mock.calls.some((c) => /unrecoverable/.test(String(c[0])))).toBe(true)
  })
})

// ── Injected watchdog behavior ──────────────────────────────────────────────

async function capturedWatchdogCode() {
  mountLW()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const w = fakePopup()
  vi.spyOn(window, 'open').mockReturnValue(w)
  await lw.open(el)
  const script = w.headChildren.find(
    (n) => typeof n.textContent === 'string' && n.textContent.includes('STALE_MS'),
  )
  expect(script).toBeTruthy()
  return script.textContent
}

// Execute the injected source with every global it touches replaced by a
// controllable fake. Time only moves when the test moves it. `opener` models
// window.opener as seen from the popup (absent by default, like a popup whose
// opener window is gone entirely).
function runWatchdog(code, { opener } = {}) {
  let now = 0
  const timers = []
  const posted = []
  const closed = { value: false }
  let handler = null
  class BC {
    postMessage(m) { posted.push(m) }
    set onmessage(f) { handler = f }
  }
  const fn = new Function('window', 'BroadcastChannel', 'Date', 'setInterval', 'clearInterval', code)
  fn(
    { close: () => { closed.value = true }, opener },
    BC,
    { now: () => now },
    (cb) => { timers.push(cb); return timers.length },
    () => {},
  )
  return {
    closed,
    posted,
    setNow: (t) => { now = t },
    tick: () => timers.forEach((f) => f()),
    deliver: (m) => handler({ data: m }),
  }
}

describe('the injected watchdog', () => {
  it('closes on host shutdown, and says goodbye first', async () => {
    const wd = runWatchdog(await capturedWatchdogCode())
    wd.deliver({ type: 'shutdown' })
    expect(wd.closed.value).toBe(true)
    expect(wd.posted.some((m) => m.type === 'goodbye')).toBe(true)
  })

  it('survives a single stale reading — a suspend/resume clock jump is not death', async () => {
    const wd = runWatchdog(await capturedWatchdogCode())
    wd.deliver({ type: 'heartbeat' }) // lastBeat = t0
    wd.setNow(100000) // the machine slept; Date.now() leapt
    wd.tick() // staleness observed → arms confirmation, must NOT close
    expect(wd.closed.value).toBe(false)
    wd.deliver({ type: 'heartbeat' }) // host resumed beating within the window
    wd.setNow(100400)
    wd.tick()
    expect(wd.closed.value).toBe(false)
  })

  it('closes a true orphan only after staleness persists, with a reason', async () => {
    const wd = runWatchdog(await capturedWatchdogCode())
    wd.setNow(11000)
    wd.tick() // stale (11s > 10s) → arms
    expect(wd.closed.value).toBe(false)
    wd.setNow(14000)
    wd.tick() // still silent 3s later (> confirm window) → orphan
    expect(wd.closed.value).toBe(true)
    expect(wd.posted.some((m) => m.type === 'goodbye' && /no heartbeat/.test(m.reason))).toBe(true)
  })

  it('never dies of silence while the opener window still exists', async () => {
    // Background-tab timer throttling can hold the host's heartbeat past ANY
    // fixed staleness window (Firefox budget throttling up to 15s, Chrome
    // intensive throttling to 60s). The opener check is timer-free: while the
    // opener objectively exists, silence must never kill a live projector.
    const wd = runWatchdog(await capturedWatchdogCode(), { opener: { closed: false } })
    wd.setNow(50000)
    wd.tick()
    wd.setNow(120000)
    wd.tick()
    wd.setNow(300000)
    wd.tick()
    expect(wd.closed.value).toBe(false)
  })

  it('kills at most once — a refused window.close() must not loop goodbyes', async () => {
    // window.close() can be refused or deferred by the UA; the watchdog keeps
    // running in that case, and every later trigger must be latched out or
    // the host console drowns in goodbye warnings at 2Hz.
    const wd = runWatchdog(await capturedWatchdogCode())
    wd.deliver({ type: 'shutdown' })
    wd.deliver({ type: 'shutdown' }) // second shutdown: latched
    wd.setNow(50000)
    wd.tick() // stale path arms…
    wd.setNow(60000)
    wd.tick() // …and would die again without the latch
    expect(wd.posted.filter((m) => m.type === 'goodbye').length).toBe(1)
  })

  it('ignores unrecognized chatter — there is no foreign-session kill', async () => {
    const wd = runWatchdog(await capturedWatchdogCode())
    // The old design closed the popup on any message with a different
    // sessionId. That kill condition must stay gone.
    wd.deliver({ type: 'heartbeat', sessionId: 'someone-else' })
    wd.deliver({ type: 'mystery' })
    wd.setNow(1000)
    wd.tick()
    expect(wd.closed.value).toBe(false)
  })
})
