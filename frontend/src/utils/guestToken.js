// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Guest credential storage for the /join page.
 *
 * Replaces utils/hostScope.js, which persisted a host *id* read out of
 * `?host=<n>` on the QR URL. That id was not a credential — it was a small
 * integer the guest asserted and the server believed — so this module stores
 * the two things that replaced it:
 *
 *   - the **token**: opaque, issued by the server, sent as an Authorization
 *     header on every guest call, and expiring on its own;
 *   - the **code**: what the QR carried, kept only so the tab can silently
 *     re-join when the token expires mid-show rather than making someone find
 *     the projector again.
 *
 * `sessionStorage`, not `localStorage`: a guest credential should not outlive
 * the tab. Closing the browser at the end of the night ends the grant, and a
 * shared phone does not hand the next person a way back in.
 *
 * Every access is wrapped — Safari in private mode throws on `sessionStorage`
 * rather than returning null, and an exception here would take the whole join
 * page down instead of degrading to "ask for the code again".
 */

const TOKEN_KEY = 'karaoke:guest_token'
const CODE_KEY = 'karaoke:join_code'

// Nothing legitimate is longer than this. The bound is here rather than only
// server-side because these values arrive from a URL fragment, which anyone
// can put anything in, and we would otherwise hand it straight back to the
// API on every request.
const MAX_LEN = 512

// Used only when sessionStorage is unusable. Same lifetime guarantee — it dies
// with the page — but without it, a private-mode browser silently stores
// nothing: the gate reports admitted, no Authorization header is ever sent,
// every request 401s, and every 401 mints a fresh token that also goes
// nowhere. That loop never converges and never surfaces an error.
const memory = new Map()

// Only ever set by an actual storage failure. It gates reads as well as
// writes: a mirror that is consulted while sessionStorage is working would
// resurrect credentials that something else legitimately removed.
let storageBroken = false

function usable(v) {
  return typeof v === 'string' && !!v && v.length <= MAX_LEN
}

function read(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (usable(raw)) return raw
    if (!storageBroken) return null
  } catch {
    storageBroken = true
  }
  const mem = memory.get(key)
  return usable(mem) ? mem : null
}

function write(key, value) {
  if (!usable(value)) return false
  try {
    sessionStorage.setItem(key, value)
    return true
  } catch {
    storageBroken = true
    memory.set(key, value)
    return true
  }
}

function drop(key) {
  memory.delete(key)
  try { sessionStorage.removeItem(key) } catch {}
}

export function getGuestToken() { return read(TOKEN_KEY) }
export function setGuestToken(token) { return write(TOKEN_KEY, token) }
export function clearGuestToken() { drop(TOKEN_KEY) }

export function getJoinCode() { return read(CODE_KEY) }
export function setJoinCode(code) { return write(CODE_KEY, code) }
export function clearJoinCode() { drop(CODE_KEY) }

export function clearGuestCredentials() {
  clearGuestToken()
  clearJoinCode()
}

/**
 * Take the credential out of `location.hash`, removing it from the address bar.
 *
 * The QR encodes `/join#<credential>`. A fragment never reaches the server, so
 * the credential stays out of proxy access logs and out of any Referer header
 * — but it is still sitting in the address bar of the guest's own phone, where
 * it survives into history and into any screenshot of the page. Reading it
 * once and calling `replaceState` is what closes that.
 *
 * Returns the credential, or null when there was none (a bare `/join`, which
 * is what a single-tenant install serves).
 */
export function takeCredentialFromHash() {
  if (typeof window === 'undefined') return null
  let raw = ''
  try {
    raw = (window.location.hash || '').replace(/^#/, '')
  } catch {
    return null
  }
  if (!raw) return null

  // Strip it from the address bar whatever it turns out to be — an
  // unparseable fragment is still something we would rather not leave on
  // screen, and leaving it would also make a failed join retry forever on
  // reload.
  try {
    // Preserve the existing state object. Passing null wipes the router's own
    // history bookkeeping (position, scroll, back), which it then computes off
    // nothing on the next navigation.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    )
  } catch {}

  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch {}
  decoded = decoded.trim()
  if (!decoded || decoded.length > MAX_LEN) return null
  return decoded
}

/**
 * Group an opaque credential for a human to read off a screen.
 *
 * Deliberately makes no assumption about what the credential is — no alphabet,
 * no length, no meaning. It chunks in fours because that is how people read
 * strings aloud in a noisy room, and it is the only thing core knows about a
 * value that a backend it does not control issued.
 */
export function formatCredential(value) {
  if (typeof value !== 'string' || !value) return ''
  // `[\s\S]`, not `.`: a dot does not match a newline, so a value containing
  // one both silently loses characters (a mangled code read aloud) and, if it
  // is nothing but newlines, makes `match` return null and this throw. This
  // runs inside a rendered computed on the projector, so a throw here is a
  // blank screen mid-show — and the whole point of the function is that it
  // assumes nothing about the value.
  return (value.match(/[\s\S]{1,4}/g) || []).join('-')
}
