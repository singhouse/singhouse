// SPDX-License-Identifier: AGPL-3.0-only
//
// Which ingest route a dropped file takes. Two routes, two server-side
// allowlists, and a 415 that only arrives AFTER the whole file has been
// uploaded — so every case that could pick the wrong one is pinned here.
//
// The case that made this file exist: an audio-only .mp4 (the browser reports
// audio/mp4) has always gone to the separation route and worked. Routing it to
// the video import route on extension alone breaks it, expensively — the
// operator waits out a gigabyte upload for a refusal.

import { describe, it, expect } from 'vitest'
import {
  ACCEPTED_VIDEO_EXTS,
  MAX_AUDIO_SIZE,
  MAX_VIDEO_SIZE,
  extOf,
  isRoutableUpload,
  routeUpload,
  validateUpload,
} from '@/utils/uploadRouting.js'

// A stand-in for a File: routing reads name, type and size and nothing else.
function file(name, type, size = 1024) {
  return { name, type, size }
}

describe('extOf', () => {
  it('lowercases and keeps the dot', () => {
    expect(extOf('Song.MP3')).toBe('.mp3')
  })

  it('takes the LAST extension of a multi-dot name', () => {
    expect(extOf('artist - title (live).v2.mkv')).toBe('.mkv')
  })

  it('is empty for a name with no extension at all', () => {
    expect(extOf('recording')).toBe('')
  })
})

describe('routeUpload — the four containers we import', () => {
  for (const ext of ACCEPTED_VIDEO_EXTS) {
    it(`sends a video-typed ${ext} to the import route`, () => {
      expect(routeUpload(file(`clip${ext}`, 'video/mp4'))).toBe('video')
    })

    it(`sends a ${ext} with no reported type to the import route`, () => {
      // .mkv in particular arrives typeless on several platforms.
      expect(routeUpload(file(`clip${ext}`, ''))).toBe('video')
    })

    it(`sends a ${ext} reported as application/octet-stream to the import route`, () => {
      expect(routeUpload(file(`clip${ext}`, 'application/octet-stream'))).toBe('video')
    })
  }
})

describe('routeUpload — an audio type vetoes the video route', () => {
  it('routes an audio/mp4 .mp4 to the separation route', () => {
    expect(routeUpload(file('track.mp4', 'audio/mp4'))).toBe('audio')
  })

  it('routes an audio-typed .mov to the separation route too', () => {
    expect(routeUpload(file('track.mov', 'audio/x-m4a'))).toBe('audio')
  })

  it('still imports a .mp4 the browser calls video', () => {
    expect(routeUpload(file('track.mp4', 'video/mp4'))).toBe('video')
  })
})

describe('routeUpload — ordinary audio', () => {
  it('routes .mp3 + audio/mpeg to the separation route', () => {
    expect(routeUpload(file('track.mp3', 'audio/mpeg'))).toBe('audio')
  })

  it('routes a typeless .flac on its extension', () => {
    expect(routeUpload(file('track.flac', ''))).toBe('audio')
  })
})

describe('routeUpload — a video we cannot import is named, not passed on', () => {
  for (const [name, type] of [
    ['clip.avi', 'video/x-msvideo'],
    ['clip.flv', 'video/x-flv'],
    ['clip.wmv', 'video/x-ms-wmv'],
  ]) {
    it(`refuses ${name} client-side`, () => {
      expect(routeUpload(file(name, type))).toBe('unsupported-video')
    })
  }

  it('says which containers do work', () => {
    const msg = validateUpload(file('clip.avi', 'video/x-msvideo'))
    expect(msg).toContain('clip.avi')
    for (const label of ['MP4', 'WebM', 'MOV', 'MKV']) {
      expect(msg).toContain(label)
    }
  })

  it('keeps it in the batch so the message can be shown', () => {
    // Filtering it out as junk would send the operator the generic
    // nothing-usable copy instead of the reason.
    expect(isRoutableUpload(file('clip.avi', 'video/x-msvideo'))).toBe(true)
  })
})

describe('routeUpload — not media at all', () => {
  it('classifies a text file as unsupported', () => {
    expect(routeUpload(file('setlist.txt', 'text/plain'))).toBe('unsupported')
  })

  it('leaves it out of the batch, as a stray file always has been', () => {
    expect(isRoutableUpload(file('setlist.txt', 'text/plain'))).toBe(false)
  })
})

describe('validateUpload — accepts what routes cleanly', () => {
  it('passes a .mp3', () => {
    expect(validateUpload(file('track.mp3', 'audio/mpeg'))).toBeNull()
  })

  it('passes a karaoke video', () => {
    expect(validateUpload(file('clip.mkv', ''))).toBeNull()
  })

  it('passes an audio .mp4 at a size only the AUDIO cap allows', () => {
    // Under 500MB: routed audio, so the audio cap is the one that applies.
    expect(validateUpload(file('track.mp4', 'audio/mp4', 400 * 1024 * 1024))).toBeNull()
  })
})

describe('validateUpload — the caps follow the route', () => {
  it('holds audio to 500MB', () => {
    const msg = validateUpload(file('track.mp3', 'audio/mpeg', MAX_AUDIO_SIZE + 1))
    expect(msg).toContain('500MB')
  })

  it('applies the AUDIO cap to an audio-typed .mp4, not the video one', () => {
    const msg = validateUpload(file('track.mp4', 'audio/mp4', MAX_AUDIO_SIZE + 1))
    expect(msg).toContain('500MB')
  })

  it('holds video to 2GB', () => {
    const msg = validateUpload(file('clip.mp4', 'video/mp4', MAX_VIDEO_SIZE + 1))
    expect(msg).toContain('2GB')
  })

  it('lets a video past the audio cap', () => {
    expect(validateUpload(file('clip.mp4', 'video/mp4', 900 * 1024 * 1024))).toBeNull()
  })
})

describe('validateUpload — audio format check is unchanged', () => {
  it('refuses an audio type we do not take', () => {
    const msg = validateUpload(file('track.aiff', 'audio/aiff'))
    expect(msg).toContain('not a supported audio format')
  })

  it('refuses a file that is neither', () => {
    expect(validateUpload(file('setlist.txt', 'text/plain'))).toContain('not a supported format')
  })
})
