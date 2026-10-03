// SPDX-License-Identifier: AGPL-3.0-only
import axios from 'axios'
import { getClientId } from '@/utils/clientId'

const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
})

// ─── Auth seams (filled by premium; inert in the core build) ────────────────
// Guest admission is a premium concept — core is single-host and has no second
// party to admit. Premium's install wires a provider (utils/guestToken); the
// core default supplies nothing and no header is sent.
//
// This replaced a `?host=<id>` query provider. That axis is gone: the id it
// appended named a tenant rather than proving anything, and the server has
// stopped reading it. What travels now is a token the server issued.
let guestAuthProvider = () => null
export function setGuestAuthProvider(fn) {
  guestAuthProvider = typeof fn === 'function' ? fn : () => null
}

// Where a 401 on the host UI bounces to. Core = the single-host unlock gate;
// premium's install flips this to '/login'.
let authRedirectPath = '/unlock'
export function setAuthRedirectPath(path) {
  authRedirectPath = path || '/unlock'
}

// What to do when a *guest* page gets a 401 — its token expired, or the host
// rotated the code out from under it. The guest surface has no login to bounce
// to, so /join registers a handler that re-joins silently while it still holds
// the code and asks for a new one when it does not.
let guestUnauthorizedHandler = null
export function setGuestUnauthorizedHandler(fn) {
  guestUnauthorizedHandler = typeof fn === 'function' ? fn : null
}

// Request interceptor — stamp every call with the browser's client ID (for
// guest queue/wishlist ownership) and, when a guest token is held, present it
// as an Authorization header.
//
// `Guest` rather than `Bearer`, deliberately: a guest token authorizes far
// less than a host session does, and sharing the Bearer scheme would let any
// middleware or log parser that special-cases Bearer treat the two as the same
// kind of credential. The scheme name is the type tag.
client.interceptors.request.use(
  config => {
    config.headers = config.headers || {}
    config.headers['X-Client-Id'] = getClientId()

    const token = guestAuthProvider()
    // Never overwrite an Authorization the caller set deliberately. Asked
    // through `has()` where axios provides it: axios preserves the caller's
    // casing, so a bracket read for the capitalised spelling silently misses
    // a caller who wrote `authorization` and replaces their credential.
    const headers = config.headers
    const hasAuth = typeof headers.has === 'function'
      ? headers.has('Authorization')
      : Object.keys(headers).some(k => k.toLowerCase() === 'authorization')
    if (token && !hasAuth) {
      headers['Authorization'] = `Guest ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

// Response interceptor — normalise errors and bounce host UI to /login on
// 401 (unless the caller opts out via `config.skipAuthRedirect`).
client.interceptors.response.use(
  response => response,
  error => {
    const status = error.response?.status
    const url = error.config?.url || ''
    if (
      status === 401
      && !error.config?.skipAuthRedirect
      && !url.startsWith('/auth/')
      && typeof window !== 'undefined'
    ) {
      // Only redirect when we're inside the host UI — guest /join and
      // /screen pages don't have a login.
      const path = window.location.pathname
      const isHostUI = path === '/' || path.startsWith('/host')
      if (isHostUI) {
        const next = encodeURIComponent(path + window.location.search)
        window.location.replace(`${authRedirectPath}?next=${next}`)
      } else if (guestUnauthorizedHandler && !url.startsWith('/join')) {
        // The guest surface has nowhere to bounce to, so it repairs itself
        // instead. /join is excluded: a failed exchange is the thing this
        // handler would react to, and re-entering it from here is a loop.
        try { guestUnauthorizedHandler() } catch {}
      }
    }

    // Blob responses (responseType: 'blob') carry their error body as a Blob
    // too — the JSON detail is inside it, unparsed. Decode it so callers see
    // the server's message instead of axios's generic status line.
    const data = error.response?.data
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return data.text()
        .then(text => JSON.parse(text))
        .catch(() => null)
        .then(parsed => {
          const err = new Error(
            parsed?.detail || parsed?.message || error.message || 'An unexpected error occurred'
          )
          err.status = status
          return Promise.reject(err)
        })
    }

    const message =
      error.response?.data?.detail?.message ||
      error.response?.data?.detail ||
      error.response?.data?.message ||
      error.message ||
      'An unexpected error occurred'
    const err = new Error(message)
    err.status = status
    err.code = error.response?.data?.detail?.code
    return Promise.reject(err)
  }
)

export default client

// ─── Song APIs ──────────────────────────────────────────────────────────────

export const songApi = {
  /** GET /api/songs — list songs in the library (optionally search/page) */
  list({ search, artistExact, status, pageSize = 200, page = 1 } = {}) {
    const params = { page, page_size: pageSize }
    if (search) params.search = search
    if (artistExact != null) params.artist_exact = artistExact
    if (status) params.status = status
    return client.get('/songs', { params })
  },

  artists({ search, page = 1, pageSize = 40 } = {}) {
    return client.get('/songs/artists', { params: { search, page, page_size: pageSize } })
  },

  /** GET /api/songs/:id — get single song details */
  get(id) {
    return client.get(`/songs/${id}`)
  },

  /** DELETE /api/songs/:id */
  delete(id) {
    return client.delete(`/songs/${id}`)
  },

  /** POST /api/separate — upload file for stem separation */
  separate(file, onProgress, artist = '', title = '', opts = {}) {
    const form = new FormData()
    form.append('file', file)
    if (artist) form.append('artist', artist)
    if (title) form.append('title', title)
    if (opts.plainLyrics) form.append('plain_lyrics', opts.plainLyrics)
    if (opts.llmPaging) form.append('llm_paging', 'true')
    // Pass-2 lead/backing model ID. Sent only when the operator moved the
    // picker off its default, so a stock upload is the exact request it was
    // before and the server's own default stays the single source of truth.
    if (opts.karaokeModel) form.append('karaoke_model', opts.karaokeModel)
    return client.post('/separate', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000, // 5 min for upload
      onUploadProgress: e => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
    })
  },

  /** POST /api/import/video — bring a karaoke video the host already owns
   *  into their library. The server keeps the video for display and extracts
   *  its audio as the song's single instrumental stem, so playback, mixer and
   *  queue all run through the ordinary audio path. Returns the same 202
   *  {job_id, song_id, …} envelope as /separate, polled through pollJob.
   *
   *  No lyric options here: a karaoke video carries its own burned-in lyrics,
   *  so there is nothing for transcription or alignment to do.
   *  Longer upload timeout than /separate — video files are far larger. */
  importVideo(file, onProgress, artist = '', title = '') {
    const form = new FormData()
    form.append('file', file)
    if (artist) form.append('artist', artist)
    if (title) form.append('title', title)
    return client.post('/import/video', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000, // 10 min for upload
      onUploadProgress: e => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
    })
  },

  /** Import one bare CDG or one same-basename MP3+G ZIP. */
  importCdg(file, onProgress, artist = '', title = '') {
    const form = new FormData()
    form.append('file', file)
    if (artist) form.append('artist', artist)
    if (title) form.append('title', title)
    return client.post('/import/cdg', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
      onUploadProgress: e => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
    })
  },

  /** GET /api/jobs/:jobId — poll job status */
  pollJob(jobId) {
    return client.get(`/jobs/${jobId}`)
  },

  /** GET /api/lyrics — fetch lyrics for artist/title.
   *  Third-party lookup is opt-in: 503 when the operator has not enabled it. */
  lyrics(artist, title) {
    return client.get('/lyrics', { params: { artist, title } })
  },

  /** PATCH /api/songs/:id — update song metadata. The server accepts
   *  `artist`, `title`, `lyrics_synced` and `custom_lyrics`; every field is
   *  optional and an omitted one is left as it is. */
  updateSong(id, body) {
    return client.patch(`/songs/${id}`, body)
  },

  /** Older spelling of `updateSong`, kept so a caller written against either
   *  name reaches the same route. */
  update(id, data) {
    return songApi.updateSong(id, data)
  },

  /** POST /api/songs/:id/retry — re-queue the job that PRODUCED a song whose
   *  ingest FAILED, replaying that job's options. Not always an ingest: an
   *  upload re-ingests, a Plex import re-fetches the track from the
   *  operator's server, a video import re-adopts its uploaded video. 202
   *  {job_id, song_id, kind, options_recovered, message}, where `kind` names
   *  which of the three was queued.
   *
   *  The refusals are all 409 with a detail worth showing verbatim: the song
   *  has not failed, a job is already in flight, no media server is configured
   *  for a Plex re-import, or the source file is gone. That last one no longer
   *  fires for an ordinary failure — the handlers now keep their upload so a
   *  failure before separation is retryable — so seeing it means the file is
   *  genuinely gone (deleted by hand, or lost with the disk) and re-uploading
   *  is the only remedy. */
  retryIngest(id) {
    return client.post(`/songs/${id}/retry`)
  },

  /** POST /api/songs/:id/stems/resplit — re-run the lead/backing split with a
   *  different Pass-2 model. The model ID must be one the server's allowlist
   *  knows (the same IDs the upload picker offers). Returns the same 202
   *  {job_id, song_id, message} envelope as the other job routes. */
  resplit(songId, body = {}) {
    return client.post(`/songs/${songId}/stems/resplit`, body)
  },
}

// ─── Capability APIs ────────────────────────────────────────────────────────

export const featuresApi = {
  /** GET /api/features — which operator-gated capabilities are switched on */
  get() {
    return client.get('/features')
  },
}

// ─── Plex library source ────────────────────────────────────────────────────
// The operator's own media server, on their own network. Every call here is a
// read of a collection they already have; the token is write-only from this
// side (the server never hands it back, so `setSettings` omits it to keep the
// stored one).

export const plexApi = {
  /** GET /api/plex/settings — { url, token_set, source, lyrics_enabled } */
  getSettings() {
    return client.get('/plex/settings')
  },

  /** PUT /api/plex/settings — omit either field to leave it as it is;
   *  token: '' forgets the stored one */
  setSettings(body) {
    return client.put('/plex/settings', body)
  },

  /** POST /api/plex/test — { ok, libraries } or a 4xx with a message */
  test() {
    return client.post('/plex/test')
  },

  /** GET /api/plex/libraries — the server's music libraries */
  listLibraries() {
    return client.get('/plex/libraries')
  },

  /** GET /api/plex/libraries/:key/tracks?offset=&limit=&artist=&title= — the media server filters, not the page */
  listTracks(key, params = {}) {
    return client.get(`/plex/libraries/${encodeURIComponent(key)}/tracks`, { params })
  },

  /** POST /api/plex/import — { tracks: [...] } → 202 { jobs } */
  importTracks(body) {
    return client.post('/plex/import', body)
  },
}

// ─── Lyrics-set APIs ────────────────────────────────────────────────────────
// A song has many LyricsSet rows. One is active (drives playback), one may
// be verified (eval ground truth).

export const lyricsSetsApi = {
  /** GET /api/songs/:id/lyrics — list all sets (no full payload) */
  list(songId) {
    return client.get(`/songs/${songId}/lyrics`)
  },

  /** GET /api/songs/:id/lyrics/:lid — get one set with full payload */
  get(songId, lid) {
    return client.get(`/songs/${songId}/lyrics/${lid}`)
  },

  /** POST /api/songs/:id/lyrics — create a manual set */
  create(songId, body) {
    return client.post(`/songs/${songId}/lyrics`, body)
  },

  /** PATCH /api/songs/:id/lyrics/:lid */
  update(songId, lid, body) {
    return client.patch(`/songs/${songId}/lyrics/${lid}`, body)
  },

  /** POST /api/songs/:id/lyrics/:lid/activate */
  activate(songId, lid) {
    return client.post(`/songs/${songId}/lyrics/${lid}/activate`)
  },

  /** POST /api/songs/:id/lyrics/:lid/verify */
  verify(songId, lid) {
    return client.post(`/songs/${songId}/lyrics/${lid}/verify`)
  },

  /** POST /api/songs/:id/lyrics/:lid/copy — duplicate a set (payloads +
   *  source; never the verified flag). Not activated unless asked. */
  copy(songId, lid, { label, activate = false } = {}) {
    return client.post(`/songs/${songId}/lyrics/${lid}/copy`, { label, activate })
  },

  /** DELETE /api/songs/:id/lyrics/:lid */
  remove(songId, lid) {
    return client.delete(`/songs/${songId}/lyrics/${lid}`)
  },

  /** POST /api/songs/:id/lyrics/transcribe — kick off a fresh run */
  transcribe(songId, body = {}) {
    return client.post(`/songs/${songId}/lyrics/transcribe`, body, { timeout: 300000 })
  },

  /** POST /api/songs/:id/lyrics/realign — reuse cached transcription */
  realign(songId, body = {}) {
    return client.post(`/songs/${songId}/lyrics/realign`, body, { timeout: 60000 })
  },

  /** POST /api/songs/:id/lyrics/:lid/page — re-run LLM page structuring on an
   *  existing set's word timings. Saves the result as a NEW set; the original
   *  is left alone. Returns the 202 {job_id, song_id, message} envelope. */
  page(songId, lid, body = {}) {
    return client.post(`/songs/${songId}/lyrics/${lid}/page`, body)
  },

  /** GET /api/songs/:id/lyrics/cache?model=&use_vad= — does a cache exist? */
  cacheStatus(songId, { model, useVad } = {}) {
    return client.get(`/songs/${songId}/lyrics/cache`, {
      params: { model, use_vad: useVad },
    })
  },

}


// ─── Queue API (core BasicManualQueue) ──────────────────────────────────────
// The minimal host-ordered "sing next" list. This is the ONLY queue API core
// speaks; the premium build's queue system carries its own client slice
// (exactly one of the two queue systems exists per assembly).

export const queueApi = {
  /** GET /api/queue — entries in play order, song fields joined in */
  list() {
    return client.get('/queue')
  },

  /** POST /api/queue — append a library song (optional singer name) */
  add(songId, singerName = null) {
    return client.post('/queue', { song_id: songId, singer_name: singerName })
  },

  /** DELETE /api/queue/:id — remove one entry (dequeue-on-play) */
  remove(id) {
    return client.delete(`/queue/${id}`)
  },

  /** PUT /api/queue/order — body: {entry_ids: [id, ...]}, returns the new list */
  reorder(entryIds) {
    return client.put('/queue/order', { entry_ids: entryIds })
  },

  /** DELETE /api/queue — clear the whole queue */
  clear() {
    return client.delete('/queue')
  },
}

// ─── History API (core flat play-history) ───────────────────────────────────
// Core-only play-history slice. The router at /api/history is mounted ONLY in
// the single-host (core) assembly; a premium build fills the queue-provider
// slot and does NOT mount it, so every caller of this slice is gated on the
// absence of a queue provider. A play is recorded at the queue ▶ Sing moment
// and flipped completed when the deck ends naturally. Retention is plain DB
// hygiene (0 = keep forever), never a paywall.

export const historyApi = {
  /** POST /api/history — record a play (optional singer name) */
  record(songId, singerName = null) {
    return client.post('/history', { song_id: songId, singer_name: singerName })
  },

  /** POST /api/history/:id/complete — flip completed (idempotent) */
  complete(id) {
    return client.post(`/history/${id}/complete`)
  },

  /** GET /api/history?search=&limit=&offset= — entries newest-first + total */
  list({ search = '', limit = 100, offset = 0 } = {}) {
    return client.get('/history', { params: { search: search || undefined, limit, offset } })
  },

  /** DELETE /api/history/:id — remove one row */
  remove(id) {
    return client.delete(`/history/${id}`)
  },

  /** DELETE /api/history — clear the whole log */
  clear() {
    return client.delete('/history')
  },

  /** GET /api/history/settings — { retention_days } (default 30) */
  getSettings() {
    return client.get('/history/settings')
  },

  /** PUT /api/history/settings — { retention_days } (0 = keep forever) */
  setSettings(retentionDays) {
    return client.put('/history/settings', { retention_days: retentionDays })
  },
}

// ─── Export API (CD+G / MP3+G) ──────────────────────────────────────────────
// Single-song export of the host's own library material. The attribution-card
// preference is a server-side setting; per-request `card` exists only as an
// explicit override and is normally omitted.

export const exportApi = {
  /** GET /api/export/settings — { attribution_card } */
  getSettings() {
    return client.get('/export/settings')
  },

  /** PUT /api/export/settings — { attribution_card } */
  setSettings(attributionCard) {
    return client.put('/export/settings', { attribution_card: attributionCard })
  },

  /** GET /api/export/songs/:id — binary body (zip for mp3g, raw for cdg).
   *  Returns the full axios response: the caller reads Content-Disposition
   *  for the server-chosen filename. Long timeout — the server renders the
   *  song's whole graphics stream before the first byte arrives. */
  exportSong(songId, { format = 'mp3g', audio, card } = {}) {
    const params = { format }
    if (audio != null) params.audio = audio
    if (card != null) params.card = card
    return client.get(`/export/songs/${songId}`, {
      params,
      responseType: 'blob',
      timeout: 300000, // 5 min, matching the other long-running calls
    })
  },
}

// ─── Session API (core single-host gate) ────────────────────────────────────
// The multi-user account API (signup/login/logout) lives in the premium
// bundle (premium/frontend/src/api.js). Core speaks only the gate dialect:
// describe the mode, read the current identity, unlock, lock.

export const sessionApi = {
  /** GET /api/auth/config — active auth mode + whether a password is required */
  config() {
    return client.get('/auth/config', { skipAuthRedirect: true })
  },

  /** GET /api/auth/me — current identity, 401 when the gate is locked */
  me() {
    return client.get('/auth/me', { skipAuthRedirect: true })
  },

  /** POST /api/auth/gate — exchange the shared password for an unlocked session */
  unlock(password) {
    return client.post('/auth/gate', { password }, { skipAuthRedirect: true })
  },

  /** POST /api/auth/lock — re-lock the gate for this session */
  lock() {
    return client.post('/auth/lock', null, { skipAuthRedirect: true })
  },
}
