// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Open a separate window for the lyrics display.
 *
 * Unlike Document Picture-in-Picture (which is intentionally restricted —
 * fullscreen is forbidden, max size is clamped, no compositor control on
 * Wayland tiling WMs), a regular popup opened via `window.open` is a
 * normal toplevel window:
 *   - same-origin → same JS context, we can move DOM nodes in directly
 *   - `requestFullscreen()` works (gated only by user gesture)
 *   - Window Management API lets us put it on a specific screen
 *   - the WM (Hyprland, etc.) treats it like any other window
 */
import { ref, onBeforeUnmount } from 'vue'

// ── Orphan-window watchdog ──────────────────────────────────────────────
// Popups opened via window.open survive a parent reload/crash, because the
// browser only ties their lifetime to the WM, not to the opener. To get
// "die with parent" semantics we:
//   1. Stamp each parent page-load with a sessionId.
//   2. Pulse a heartbeat on a BroadcastChannel NAMED BY that sessionId.
//   3. Broadcast 'shutdown' on pagehide (covers reload AND tab close).
//   4. Inject a tiny watchdog script into each popup that self-closes if
//      heartbeats go stale (= the opener page is gone; a reloaded opener
//      broadcasts on a NEW per-session channel, so the old popup hears
//      silence and times out).
//
// The channel is per-session ON PURPOSE. It used to be one shared name, with
// the watchdog killing the popup the moment it heard a DIFFERENT sessionId —
// but a beacon, once started, ran for the life of its tab, so a second app
// tab that had ever popped out kept broadcasting forever, and every popout
// from any OTHER tab died within one heartbeat of opening. The field symptom
// was "the projector window closes the instant I open it, until I close the
// whole browser." Per-session channels make foreign heartbeats unhearable, so
// the only kill conditions left are our own shutdown and our own silence.
if (typeof window !== 'undefined' && !window.__karaokeHostSession) {
  // window-scoped so Vite HMR (which re-runs this module) doesn't churn the
  // sessionId mid-session — only a real reload wipes window globals.
  window.__karaokeHostSession = (crypto.randomUUID?.() || String(Date.now() + Math.random()))
}
const SESSION_ID = typeof window !== 'undefined' ? window.__karaokeHostSession : null
const CHANNEL_NAME = `karaoke-lyrics-popout:${SESSION_ID}`
const HEARTBEAT_MS = 1000
// Staleness is generous because the miss cases are real: Firefox background
// tabs are budget-throttled up to 15s (dom.timeout.budget_throttling_max_delay)
// and Chrome intensive-throttles hidden tabs to once a minute, so silence
// alone is weak evidence of death — which is why the stale path below also
// checks window.opener before killing (timer-free, immune to throttling). The
// watchdog's only job is cleaning up true orphans; an orphan surviving a few
// extra seconds is harmless, a live projector closing itself mid-show is not.
const STALE_MS = 10000
// After staleness is first observed, the popup waits this long for one more
// beat before closing. System suspend/resume makes Date.now() jump: the first
// post-wake check sees a huge gap even though the host is about to resume
// beating, so a single stale reading must never be lethal on its own.
const STALE_CONFIRM_MS = 2500

let parentBeacon = null
function ensureHeartbeat() {
  if (parentBeacon || typeof window === 'undefined') return
  const bc = new BroadcastChannel(CHANNEL_NAME)
  const beat = () => bc.postMessage({ type: 'heartbeat' })
  beat()
  const id = setInterval(beat, HEARTBEAT_MS)
  // Beat immediately whenever the tab comes back to the foreground — after
  // background-tab throttling or suspend/resume this closes the stale gap
  // faster than waiting out the next interval tick.
  const wake = () => { if (!document.hidden) beat() }
  window.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  window.addEventListener('pageshow', wake)
  // If the popup closes itself, it says why first — surface that in the host
  // console, because the popup's own console dies with it.
  bc.onmessage = (ev) => {
    const m = ev.data
    if (m && m.type === 'goodbye') {
      // Comma arg, not interpolation: never stringify channel content into
      // the log message ourselves.
      console.warn('Lyrics popout closed itself:', m.reason)
    }
  }
  // pagehide only. beforeunload can fire for an unload that never happens
  // (user cancels leaving), and a spurious 'shutdown' kills a healthy popup.
  const goodbye = () => {
    try { bc.postMessage({ type: 'shutdown' }) } catch { /* ignore */ }
  }
  window.addEventListener('pagehide', goodbye)
  parentBeacon = { bc, id }
}

function injectWatchdog(w) {
  const code = `(function () {
    const STALE_MS = ${STALE_MS};
    const STALE_CONFIRM_MS = ${STALE_CONFIRM_MS};
    let lastBeat = Date.now();
    let staleSince = 0;
    let dying = false;
    let poll = 0;
    let bc;
    try { bc = new BroadcastChannel(${JSON.stringify(CHANNEL_NAME)}); } catch (e) { return; }
    const die = (reason) => {
      // Latched: window.close() can be refused or deferred by the UA, and
      // without the latch the poll would re-enter every 500ms, spamming a
      // goodbye (and a host console.warn) each time.
      if (dying) return;
      dying = true;
      try { clearInterval(poll); } catch (e) {}
      try { bc.postMessage({ type: 'goodbye', reason: reason }); } catch (e) {}
      try { window.close(); } catch (e) {}
    };
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'shutdown') {
        die('host page navigated away or closed');
      } else if (m.type === 'heartbeat') {
        lastBeat = Date.now();
        staleSince = 0;
      }
    };
    poll = setInterval(() => {
      const now = Date.now();
      if (now - lastBeat <= STALE_MS) { staleSince = 0; return; }
      // Stale — but silence is weak evidence: background-tab timer throttling
      // can hold the host's heartbeat past ANY fixed window (Firefox budget
      // throttling up to 15s, Chrome intensive throttling to 60s). The opener
      // check is timer-free and immune to all of that; while the opener
      // window objectively still exists, silence is never lethal. A RELOADED
      // host is handled by the pagehide 'shutdown' broadcast, not by this
      // path, so holding on here does not resurrect the orphan-after-reload
      // case. The stale path below is the backstop for an opener that
      // vanished without pagehide (crash, kill).
      try {
        if (window.opener && !window.opener.closed) { staleSince = 0; return; }
      } catch (e) { /* opener unreadable — fall through to the stale path */ }
      // Confirm over a second window of real elapsed time before closing, so
      // a clock jump (suspend/resume) alone can't kill us.
      if (!staleSince) { staleSince = now; return; }
      if (now - staleSince > STALE_CONFIRM_MS) {
        die('no heartbeat from host for ' + (now - lastBeat) + 'ms and opener gone');
      }
    }, 500);
  })();`
  const s = w.document.createElement('script')
  s.textContent = code
  w.document.head.appendChild(s)
}

function copyStyles(targetDoc) {
  for (const sheet of document.styleSheets) {
    try {
      if (sheet.href) {
        const link = targetDoc.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        targetDoc.head.appendChild(link)
        continue
      }
      const owner = sheet.ownerNode
      if (owner && owner.tagName === 'STYLE') {
        const clone = targetDoc.createElement('style')
        if (owner.textContent) {
          clone.textContent = owner.textContent
        } else {
          clone.textContent = Array.from(sheet.cssRules).map(r => r.cssText).join('\n')
        }
        targetDoc.head.appendChild(clone)
      }
    } catch {
      // cross-origin stylesheets — skip
    }
  }
}

// True when a DOM reference is still safe to touch. In Firefox, a node left
// inside a popup document that got destroyed (window closed before pagehide
// handed the node back, or the popup crashed) becomes a "dead object"
// wrapper: EVERY property access throws. Probe inside try/catch so callers
// can tell "dead" from "alive but detached".
function isLiveNode(el) {
  try {
    return !!el && typeof el.nodeType === 'number'
  } catch {
    return false
  }
}

export function useLyricsWindow() {
  const win = ref(null)
  const isOpen = ref(false)

  let originalParent = null
  let originalNextSibling = null
  let movedEl = null

  // Put `el` back where it came from, preserving its original sibling
  // position when the sibling is still there. Shared by the normal close path
  // and open()'s failure path so both keep the same invariant. Throws are the
  // caller's to interpret.
  function reinsertAtHome(el) {
    if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
      originalParent.insertBefore(el, originalNextSibling)
    } else {
      originalParent.appendChild(el)
    }
  }

  // Returns true when the element made it home cleanly (or there was nothing
  // to return); false when it is lost. Callers use that to decide how loud
  // their own logging should be.
  function returnToHost() {
    let clean = true
    if (movedEl && originalParent) {
      if (!isLiveNode(movedEl)) {
        // The popup document died with the stage still inside it. There is no
        // getting the node back — and the Vue components rendered into it are
        // wired to dead DOM, so the popout host is broken until a reload. Say
        // so loudly; a silent catch here previously left "popout never works
        // again" with no clue in the console.
        console.error(
          'Lyrics popout: the popup window was destroyed before the stage ' +
          'element could be moved back (crash, or close without pagehide). ' +
          'The popout host is unrecoverable — reload the host page to restore it.',
        )
        clean = false
      } else {
        try {
          reinsertAtHome(movedEl)
        } catch (e) {
          console.error('Lyrics popout: failed to return the stage element to the host page:', e)
          clean = false
        }
      }
    }
    movedEl = null
    originalParent = null
    originalNextSibling = null
    win.value = null
    isOpen.value = false
    return clean
  }

  /**
   * @param element  the DOM element to move into the popup
   * @param opts.title         window title
   * @param opts.width/height  initial size
   * @param opts.screen        ScreenDetailed to position on (Window Management API)
   */
  async function open(element, { title = 'Karaoke — Lyrics', width = 1280, height = 720, screen = null } = {}) {
    if (!element || isOpen.value) return
    if (!isLiveNode(element)) {
      // A previous popup died with the stage inside it (see returnToHost).
      // Refuse BEFORE window.open so we don't also leak a blank popup.
      throw new Error(
        'The projector view was lost when a previous popout window died. ' +
        'Reload this page, then pop out again.',
      )
    }

    // If a specific screen was given, place the popup there.
    let left = window.screenX + 80
    let top = window.screenY + 80
    if (screen) {
      // ScreenDetailed gives availLeft/availTop in the multi-screen virtual
      // coordinate space. Center within the target screen.
      left = Math.round(screen.availLeft + (screen.availWidth - width) / 2)
      top = Math.round(screen.availTop + (screen.availHeight - height) / 2)
    }

    const features = [
      `popup=yes`,
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
    ].join(',')

    const w = window.open('about:blank', '_blank', features)
    if (!w) {
      throw new Error('Popup blocked. Allow popups for this site, then try again.')
    }

    // Everything from here on can throw (a dead element surfacing late, a
    // popup document in an unexpected state). If it does, close the popup we
    // just opened — an orphaned blank window that never got the watchdog
    // would otherwise outlive the app — and rethrow for the caller's alert.
    try {
      ensureHeartbeat()
      injectWatchdog(w)

      w.document.title = title
      Object.assign(w.document.body.style, {
        margin: '0',
        padding: '0',
        background: 'linear-gradient(135deg, #050314 0%, #0a1124 50%, #04101a 100%)',
        color: 'white',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      })
      copyStyles(w.document)

      originalParent = element.parentNode
      originalNextSibling = element.nextSibling
      movedEl = element
      w.document.body.appendChild(element)

      // Double-click anywhere in the popup → toggle fullscreen on its document.
      // dblclick is a user gesture, so requestFullscreen will be honored.
      w.document.body.addEventListener('dblclick', () => {
        const doc = w.document
        if (doc.fullscreenElement) doc.exitFullscreen?.()
        else doc.documentElement.requestFullscreen?.().catch(() => {})
      })
      w.document.body.style.cursor = 'default'
      w.document.body.title = 'Double-click to toggle fullscreen'

      // Published LAST, once nothing in this block can throw any more. The
      // catch below does not (and must not need to) unwind these: publishing
      // early once left isOpen=true after a late throw, which wedged the
      // toggle shut — open() refused to reopen and close() had nothing real
      // to close. Ordering also matters downstream: HostShell's popoutEpoch
      // watcher relies on isOpen flipping only AFTER the element is in its
      // destination document.
      win.value = w
      isOpen.value = true
    } catch (e) {
      // If the element already made it into the popup, pull it back BEFORE
      // closing — closing destroys the popup document and the element with it.
      try {
        if (movedEl && originalParent && movedEl.ownerDocument === w.document) {
          reinsertAtHome(movedEl)
        }
      } catch { /* ignore */ }
      movedEl = null
      originalParent = null
      originalNextSibling = null
      try { w.close() } catch { /* ignore */ }
      throw e
    }

    // Fire-and-forget: when the popup closes, return the element to the host.
    w.addEventListener('pagehide', returnToHost, { once: true })
    // Some browsers don't fire pagehide reliably for window.close() — poll as
    // a backup so we don't end up with the element marooned in a closed window.
    const closedPoll = setInterval(() => {
      if (w.closed) {
        clearInterval(closedPoll)
        if (isOpen.value) {
          // pagehide never reached us. On browsers that simply don't deliver
          // pagehide for window.close() this is the ROUTINE close path, so
          // stay quiet unless the element was actually lost — returnToHost
          // probes, logs the loud error itself, and reports back.
          const clean = returnToHost()
          if (clean) {
            console.debug('Lyrics popout: window closed without pagehide; recovered via poll')
          } else {
            console.warn('Lyrics popout: window closed without pagehide and the stage element was lost')
          }
        }
      }
    }, 500)
  }

  /** Toggle fullscreen on the popup itself, optionally targeting a screen. */
  async function toggleFullscreen(screen = null) {
    const w = win.value
    if (!w) return
    const doc = w.document
    if (doc.fullscreenElement) {
      await doc.exitFullscreen?.()
      return
    }
    const opts = screen ? { screen } : undefined
    await doc.documentElement.requestFullscreen(opts)
  }

  function close() {
    if (win.value) {
      try { win.value.close() } catch { /* ignore */ }
    }
  }

  onBeforeUnmount(() => {
    if (win.value) {
      try { win.value.close() } catch { /* ignore */ }
      returnToHost()
    }
  })

  return { open, close, toggleFullscreen, isOpen, win }
}

/**
 * Window Management API helpers — let the user pick which monitor to target.
 * Falls back to a single-screen list when the API is unavailable / denied.
 */
export const WINDOW_MANAGEMENT_SUPPORTED =
  typeof window !== 'undefined' && 'getScreenDetails' in window

export async function getScreens() {
  if (!WINDOW_MANAGEMENT_SUPPORTED) {
    return { screens: [window.screen], primary: window.screen, supported: false }
  }
  try {
    const details = await window.getScreenDetails()
    return {
      screens: details.screens,
      primary: details.screens.find(s => s.isPrimary) || details.screens[0],
      supported: true,
    }
  } catch (e) {
    // Permission denied or no extended screens — fall back to single-screen.
    return { screens: [window.screen], primary: window.screen, supported: false, error: e }
  }
}
