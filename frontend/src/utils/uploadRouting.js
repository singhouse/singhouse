// SPDX-License-Identifier: AGPL-3.0-only
// Which ingest route a dropped file takes, and whether it may be sent at all.
//
// Three routes exist and they are not interchangeable: separation (audio in,
// stems out), prepared video, and single-song CDG/MP3+G. The server enforces its own
// MIME + extension allowlists on both and answers a mismatch with a 415 —
// AFTER the whole file has crossed the wire. A video is gigabytes. So the
// decision has to be right HERE, before a byte moves.
//
// Extensions carry the decision, not MIME: container types are unreliable
// across platforms (.mkv arrives as video/x-matroska, as
// application/octet-stream, or as nothing at all). The reported type is used
// for exactly one thing — an `audio/` prefix VETOES the video route, because
// an audio-only .mp4 is what the browser labels audio/mp4 and it is the
// separation route that has always taken those. Sending one to the import
// route is a regression the operator only discovers after the upload.
//
// Lives here rather than inside UploadZone.vue so the rules are testable on
// their own: a `<script setup>` block exports nothing.

export const ACCEPTED_AUDIO_TYPES = [
  'audio/mpeg', 'audio/flac', 'audio/wav', 'audio/x-wav',
  'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
]
export const ACCEPTED_AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac']

// The containers the import route accepts. Anything else the browser calls a
// video is refused here by name, not handed to the server to 415.
export const ACCEPTED_VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv']
export const ACCEPTED_CDG_EXTS = ['.cdg', '.zip']

export const MAX_AUDIO_SIZE = 500 * 1024 * 1024        // 500MB
export const MAX_VIDEO_SIZE = 2048 * 1024 * 1024       // 2GB — the server's cap
export const MAX_CDG_SIZE = 30 * 60 * 300 * 24 + 23    // 30 min + ignored partial packet

// Human list for the copy below; kept next to the allowlist so the two cannot
// drift apart.
const VIDEO_CONTAINERS = 'MP4, WebM, MOV, MKV'
const AUDIO_FORMATS = 'MP3, FLAC, WAV, M4A, OGG'

export function extOf(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  // No dot at all: no extension, not "the whole name is the extension".
  if (i < 0) return ''
  return s.slice(i).toLowerCase()
}

/**
 * The ingest route for one file.
 *
 * @returns {'audio'|'video'|'cdg'|'unsupported-video'|'unsupported'}
 *   'audio'             — the separation route
 *   'video'             — the karaoke-video import route
 *   'cdg'               — one bare CDG or one MP3+G ZIP
 *   'unsupported-video' — the browser calls it video, we cannot import that
 *                         container; refuse by name
 *   'unsupported'       — not media as far as we can tell; ignored in a mixed
 *                         drop the way a stray file always has been
 */
export function routeUpload(file) {
  const ext = extOf(file?.name)
  const type = String(file?.type || '').toLowerCase()
  const videoExt = ACCEPTED_VIDEO_EXTS.includes(ext)
  if (ACCEPTED_CDG_EXTS.includes(ext)) return 'cdg'

  // An allowlisted container the browser reports as audio is an AUDIO upload.
  // The import route refuses audio/* outright, and this is the pre-video
  // behavior for an audio-only .mp4 — it worked end to end and must keep
  // working.
  if (videoExt && type.startsWith('audio/')) return 'audio'
  // Empty type, video/*, application/octet-stream — an allowlisted extension
  // is enough on its own.
  if (videoExt) return 'video'
  // Typed video, container we do not import (.avi/.flv/.wmv): say so now.
  if (type.startsWith('video/')) return 'unsupported-video'

  if (ACCEPTED_AUDIO_EXTS.includes(ext) || ACCEPTED_AUDIO_TYPES.includes(type)
      || type.startsWith('audio/')) {
    return 'audio'
  }
  return 'unsupported'
}

/**
 * The message to show for a file, or null when it may be sent.
 * Size caps and the audio format check both hang off the route.
 *
 * @returns {string|null}
 */
export function validateUpload(file) {
  const route = routeUpload(file)

  if (route === 'video') {
    if (file.size > MAX_VIDEO_SIZE) {
      return `"${file.name}" exceeds the 2GB video limit (${(file.size / 1024 / 1024 / 1024).toFixed(1)}GB)`
    }
    return null
  }

  if (route === 'cdg') {
    const cap = extOf(file.name) === '.cdg' ? MAX_CDG_SIZE : MAX_AUDIO_SIZE + 50 * 1024 * 1024
    if (file.size > cap) {
      if (extOf(file.name) === '.cdg') {
        return `"${file.name}" exceeds the 30-minute CDG packet limit`
      }
      return `"${file.name}" exceeds the 550MB CD+G import limit`
    }
    return null
  }

  if (route === 'unsupported-video') {
    return `"${file.name}" is a video format we can't import — supported: ${VIDEO_CONTAINERS}`
  }

  if (route === 'unsupported') {
    return `"${file.name}" is not a supported format (audio: ${AUDIO_FORMATS}; karaoke graphics: CDG or MP3+G ZIP; karaoke video: ${VIDEO_CONTAINERS})`
  }

  // Audio: unchanged from before the video route existed. A file that reached
  // here only on an `audio/` type prefix still has to name a format we take.
  const knownAudio = ACCEPTED_AUDIO_TYPES.includes(String(file.type || '').toLowerCase())
    || ACCEPTED_AUDIO_EXTS.includes(extOf(file.name))
  if (!knownAudio) {
    return `"${file.name}" is not a supported audio format (${AUDIO_FORMATS})`
  }
  if (file.size > MAX_AUDIO_SIZE) {
    return `"${file.name}" exceeds the 500MB limit (${(file.size / 1024 / 1024).toFixed(0)}MB)`
  }
  return null
}

// True for a file that belongs to one of the two routes. `unsupported-video`
// is deliberately NOT filtered out by this — it has an answer to give and
// validateUpload gives it.
export function isRoutableUpload(file) {
  return routeUpload(file) !== 'unsupported'
}

/**
 * The playing time of a local audio or video file, in seconds, or null when
 * the browser cannot tell. Reads only the container's metadata from an object
 * URL (revoked afterwards); nothing leaves the machine. Never rejects.
 *
 * @returns {Promise<number|null>}
 */
export function probeMediaDuration(file, { timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    let url
    let el
    try {
      url = URL.createObjectURL(file)
      el = document.createElement(routeUpload(file) === 'video' ? 'video' : 'audio')
    } catch {
      if (url) URL.revokeObjectURL(url)
      resolve(null)
      return
    }
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      el.onloadedmetadata = null
      el.onerror = null
      el.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      const d = el.duration
      finish(Number.isFinite(d) && d > 0 ? d : null)
    }
    el.onerror = () => finish(null)
    el.src = url
  })
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
