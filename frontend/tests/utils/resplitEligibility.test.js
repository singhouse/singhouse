// SPDX-License-Identifier: AGPL-3.0-only
//
// Which songs can have their lead/backing split re-run.
//
// The rule used to live inside AudioPlayer, where it could only ever be asked
// about the song on the deck. The Song tools panel asks it about any song in
// the library, so it moved out — and with it the requirement that a refusal
// carries a reason: the backend refuses the same shapes, and a control that
// 503s is worse than one that says why it is off.

import { describe, expect, it } from 'vitest'
import { resplitEligibility } from '@/utils/resplitEligibility'

const PAIR = [
  { id: 'lead', name: null, url: '/lead.wav' },
  { id: 'backing', name: null, url: '/backing.wav' },
]

function song(overrides = {}) {
  return {
    id: 42,
    status: 'ready',
    has_video: false,
    stems: { instrumental: '/i.wav', karaoke: '/k.wav', vocals: PAIR },
    ...overrides,
  }
}

describe('resplitEligibility', () => {
  it('allows a ready song with a plain lead/backing pair', () => {
    expect(resplitEligibility(song())).toEqual({ canResplit: true, reason: '' })
  })

  it('refuses a song that is still processing, naming the status', () => {
    const { canResplit, reason } = resplitEligibility(song({ status: 'processing' }))
    expect(canResplit).toBe(false)
    expect(reason).toContain('processing')
  })

  it('refuses a video import', () => {
    // One instrumental stem and lyrics burned into the picture: there is no
    // pair to split.
    const { canResplit, reason } = resplitEligibility(song({ has_video: true }))
    expect(canResplit).toBe(false)
    expect(reason).toMatch(/karaoke video/)
  })

  it('refuses a song with a third vocal lane', () => {
    // The job produces exactly one lead and one backing; a third lane would be
    // orphaned beside the freshly split pair.
    const { canResplit, reason } = resplitEligibility(song({
      stems: {
        instrumental: '/i.wav',
        vocals: [...PAIR, { id: 'lead_2', name: null, url: '/lead2.wav' }],
      },
    }))
    expect(canResplit).toBe(false)
    expect(reason).toMatch(/exactly one lead and one backing/)
  })

  it('refuses a per-voice roster', () => {
    const { canResplit } = resplitEligibility(song({
      stems: {
        instrumental: '/i.wav',
        vocals: [
          { id: '6', name: 'Ann', url: '/6.wav' },
          { id: '7', name: 'Bo', url: '/7.wav' },
        ],
      },
    }))
    expect(canResplit).toBe(false)
  })

  it('refuses a song with no vocal stems, and a null song', () => {
    expect(resplitEligibility(song({ stems: { instrumental: '/i.wav' } })).canResplit).toBe(false)
    expect(resplitEligibility(null)).toEqual({ canResplit: false, reason: 'No song loaded.' })
  })
})
