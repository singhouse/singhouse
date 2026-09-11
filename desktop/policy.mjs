// SPDX-License-Identifier: AGPL-3.0-only
export function parseLaunch(line) {
  const value = JSON.parse(line)
  const url = new URL(value.origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.origin !== value.origin || url.username || url.password
      || !Number.isInteger(Number(url.port)) || Number(url.port) < 1024
      || typeof value.password !== 'string' || value.password.length < 32
      || typeof value.nonce !== 'string' || value.nonce.length < 32) {
    throw new Error('Backend returned an invalid launch handshake')
  }
  return { origin: value.origin, password: value.password, nonce: value.nonce }
}

export function ownURL(raw, origin) {
  try {
    const url = new URL(raw)
    return url.origin === origin && url.protocol === 'http:' && !url.username && !url.password
  } catch { return false }
}

export function allowedRequest(raw, origin) {
  if (ownURL(raw, origin)) return true
  try {
    const url = new URL(raw)
    return url.protocol === 'data:' || (url.protocol === 'blob:' && url.origin === origin)
  } catch { return false }
}

export function allowSpeaker({ permission, hostId, contentsId, isMainFrame, url, origin }) {
  return permission === 'speaker-selection' && hostId != null && contentsId === hostId
    && isMainFrame === true && ownURL(url, origin)
}

export function childEnvironment(source) {
  const keys = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP']
  return Object.fromEntries(keys.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]))
}

// The unchanged popup injects its watchdog inline. WASM is used by pitch shift.
// No eval, remote scripts, embedded frames, plugins or external connections.
export const CSP = "default-src 'self'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
