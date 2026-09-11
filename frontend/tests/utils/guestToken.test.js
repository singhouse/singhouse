// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The module that holds the guest credential in the browser. Covered directly
// because every property here is load-bearing and none of it is observable
// from the component tests: which storage it uses, that the fragment is
// stripped, and that formatting an opaque value cannot throw on the projector.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  getGuestToken, setGuestToken,
  getJoinCode, setJoinCode,
  clearGuestCredentials,
  takeCredentialFromHash,
  formatCredential,
} from '@/utils/guestToken'

const TOKEN_KEY = 'karaoke:guest_token'
const CODE_KEY = 'karaoke:join_code'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  clearGuestCredentials()
  window.history.replaceState(null, '', '/join')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('where the credential is kept', () => {
  it('uses sessionStorage and never localStorage', () => {
    setGuestToken('tok-abc')
    setJoinCode('K7M4QP29')

    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('tok-abc')
    // Load-bearing: the grant must die with the tab. In localStorage a shared
    // phone hands the next person a way back into someone else's room.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(CODE_KEY)).toBeNull()
  })

  it('clears both halves together', () => {
    setGuestToken('tok-abc')
    setJoinCode('K7M4QP29')
    clearGuestCredentials()
    expect(getGuestToken()).toBeNull()
    expect(getJoinCode()).toBeNull()
  })

  it('refuses a value longer than the bound', () => {
    expect(setGuestToken('x'.repeat(513))).toBe(false)
    expect(getGuestToken()).toBeNull()
  })

  it('still holds the credential when sessionStorage throws', () => {
    // Safari private mode throws on setItem rather than returning. Reporting
    // success while storing nothing is what produces an endless re-join: the
    // gate says admitted, no header is ever sent, every request 401s.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(setGuestToken('tok-private')).toBe(true)
    expect(getGuestToken()).toBe('tok-private')
  })
})

describe('taking the credential out of the URL', () => {
  it('returns it and strips it from the address bar', () => {
    window.history.replaceState(null, '', '/join#K7M4QP29')
    expect(takeCredentialFromHash()).toBe('K7M4QP29')
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/join')
  })

  it('strips even a fragment it cannot use', () => {
    // An unparseable fragment is still a credential-shaped thing sitting in
    // the address bar, and leaving it makes a failed join retry on every
    // reload forever.
    window.history.replaceState(null, '', '/join#' + 'x'.repeat(600))
    expect(takeCredentialFromHash()).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('preserves the query string', () => {
    window.history.replaceState(null, '', '/join?kiosk=1#K7M4QP29')
    expect(takeCredentialFromHash()).toBe('K7M4QP29')
    expect(window.location.search).toBe('?kiosk=1')
  })

  it('preserves the history state object', () => {
    // Passing null wipes vue-router's own bookkeeping (position, scroll,
    // back), which it then computes off nothing on the next navigation.
    window.history.replaceState({ position: 3 }, '', '/join#K7M4QP29')
    takeCredentialFromHash()
    expect(window.history.state).toEqual({ position: 3 })
  })

  it('decodes percent-encoding', () => {
    window.history.replaceState(null, '', '/join#K7M4%20QP29')
    expect(takeCredentialFromHash()).toBe('K7M4 QP29')
  })

  it('returns null for a bare /join and for a bare #', () => {
    expect(takeCredentialFromHash()).toBeNull()
    window.history.replaceState(null, '', '/join#')
    expect(takeCredentialFromHash()).toBeNull()
  })
})

describe('formatting a credential for a human', () => {
  it('chunks in fours', () => {
    expect(formatCredential('K7M4QP29')).toBe('K7M4-QP29')
  })

  it('makes no assumption about length or alphabet', () => {
    expect(formatCredential('abc')).toBe('abc')
    expect(formatCredential('123456789')).toBe('1234-5678-9')
  })

  it('survives a value containing newlines', () => {
    // `.` does not match a newline: the old regex silently dropped characters
    // here, and threw outright on a value that was nothing but whitespace.
    // This renders on the projector, so a throw is a blank screen mid-show.
    expect(formatCredential('AB\nCD')).toBe('AB\nC-D')
    expect(() => formatCredential('\n')).not.toThrow()
    expect(() => formatCredential('\n\n\n')).not.toThrow()
  })

  it('returns empty for a non-string or empty value', () => {
    expect(formatCredential('')).toBe('')
    expect(formatCredential(null)).toBe('')
    expect(formatCredential(undefined)).toBe('')
    expect(formatCredential(12345678)).toBe('')
  })
})
