// SPDX-License-Identifier: AGPL-3.0-only
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { songApi, lyricsSetsApi } from '@/api/client'
import { pollUntil } from '@/utils/pollUntil'
import { fetchAllSongs } from '@/utils/fetchAllSongs'
import { prepareHeart } from '@/composables/useHeartSetup'

// What each job kind is called in the UI, in one place: the panel that starts
// the job and the library row that only sees it running must not name it two
// different things.
export const JOB_KIND_LABELS = {
  realign: 'Re-fit timing',
  transcribe: 'Listen again',
  page: 'Re-page',
  resplit: 'Re-split',
  retry: 'Retry ingest',
}

export const useSongsStore = defineStore('songs', () => {
  // ─── State ────────────────────────────────────────────────────────────────
  const songs = ref([])
  const currentSong = ref(null)
  const uploads = ref([])
  const statusFilter = ref('all')
  const searchQuery = ref('')
  const loading = ref(false)
  const error = ref(null)

  // When each processing song's ingest last visibly moved, keyed by song id:
  // { sig, at }. The list endpoint carries no update timestamp, so `at` is the
  // local time at which a poll first saw the current phase/message/progress.
  // A stage that has gone quiet and one that has died look the same on the
  // row otherwise.
  const jobProgress = ref({})

  // ─── Getters ──────────────────────────────────────────────────────────────
  const filteredSongs = computed(() => {
    if (!Array.isArray(songs.value)) return []
    if (statusFilter.value === 'all') return songs.value
    return songs.value.filter(s => s.status === statusFilter.value)
  })

  const readySongs = computed(() => {
    if (!Array.isArray(songs.value)) return []
    return songs.value.filter(s => s.status === 'ready')
  })
  const processingCount = computed(() => {
    const songCount = Array.isArray(songs.value) ? songs.value.filter(s => s.status === 'processing').length : 0
    return songCount + uploads.value.length
  })

  // ─── Actions ──────────────────────────────────────────────────────────────

  // Every library load is now several sequential requests, so two of them can
  // easily be in flight at once (the 3s poll, the search debounce, an upload's
  // refresh). Without a guard the slowest writer wins: a poll started before
  // the host typed can land after the search and repaint the FULL library
  // while `searchQuery` says 'bowie'. A monotonic token drops superseded walks.
  let _fetchSeq = 0

  async function fetchSongs({ search } = {}) {
    if (search !== undefined) searchQuery.value = search
    const seq = ++_fetchSeq
    loading.value = true
    error.value = null
    try {
      const query = searchQuery.value || undefined
      const result = await fetchAllSongs(query)
      if (seq !== _fetchSeq) return          // superseded mid-walk; discard
      songs.value = result
      _trackProgress(result, { complete: !query })
      _scheduleProcessingPoll()
    } catch (e) {
      console.warn('fetchSongs failed:', e.message)
      if (seq !== _fetchSeq) return
      // Keep the last known-good list. A walk is several requests now, so a
      // single blip on any one of them would otherwise blank the library
      // mid-show — a worse outcome than a briefly stale list.
      error.value = e.message
    } finally {
      if (seq === _fetchSeq) loading.value = false
    }
  }

  // ── Background poll for songs still being ingested ────────────────────────
  // While any song in the list is `processing`, refresh every 3s so the
  // SongList row shows the current phase without the user clicking around.
  let _pollTimer = null
  function _scheduleProcessingPoll() {
    if (_pollTimer) {
      clearTimeout(_pollTimer)
      _pollTimer = null
    }
    const stillProcessing = songs.value.some(s => s.status === 'processing')
    if (!stillProcessing) return
    _pollTimer = setTimeout(async () => {
      const seq = ++_fetchSeq
      try {
        // Must paginate the same way fetchSongs does: this overwrites the
        // list wholesale, so a single-page refresh here would silently snap
        // a fully-loaded library back to its first page every 3s.
        const query = searchQuery.value || undefined
        const next = await fetchAllSongs(query)
        if (seq === _fetchSeq) {
          songs.value = next
          _trackProgress(next, { complete: !query })
        }
      } catch (e) {
        console.warn('processing-poll failed:', e.message)
      } finally {
        _scheduleProcessingPoll()
      }
    }, 3000)
  }

  // Only a change in phase, message or percent counts as progress; an
  // identical poll keeps the old time. Songs absent from a searched list keep
  // theirs, so clearing the search does not restart the clock; an unfiltered
  // (`complete`) walk is the whole library, so anything absent from it is gone.
  function _trackProgress(list, { complete = false } = {}) {
    if (!Array.isArray(list)) return
    const now = Date.now()
    const next = { ...jobProgress.value }
    let changed = false
    if (complete) {
      const present = new Set(list.map(s => String(s.id)))
      for (const id of Object.keys(next)) {
        if (!present.has(id)) { delete next[id]; changed = true }
      }
    }
    for (const s of list) {
      if (s.status !== 'processing') {
        if (s.id in next) { delete next[s.id]; changed = true }
        continue
      }
      const sig = JSON.stringify([s.phase ?? null, s.message ?? null, s.progress ?? null])
      if (next[s.id]?.sig !== sig) {
        next[s.id] = { sig, at: now }
        changed = true
      }
    }
    if (changed) jobProgress.value = next
  }

  /** Local ms timestamp of the last observed progress for a processing song, or null. */
  function jobLastChangeAt(songId) {
    return jobProgress.value[songId]?.at ?? null
  }

  // All ingest paths — separation, prepared video, and CDG — have the
  // same shape: register an upload row, POST the file with progress, then poll
  // the job to completion, refreshing the library as it goes. Only the request
  // itself differs, so the caller hands one in. Keeping a single body means the
  // two can never drift on error handling or list refresh.
  async function _runIngest(file, submit) {
    const uploadId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`

    uploads.value.push({
      id: uploadId,
      filename: file.name,
      status: 'uploading',
      phase: 'uploading',
      message: 'Uploading file…',
      progress: 0,
      error: null,
      jobId: null,
    })

    try {
      const res = await submit(pct => {
        const entry = uploads.value.find(u => u.id === uploadId)
        if (entry) entry.progress = pct
      })

      const { job_id } = res.data
      const entry = uploads.value.find(u => u.id === uploadId)
      if (entry) {
        entry.jobId = job_id
        entry.status = 'processing'
        entry.phase = 'queued'
        entry.message = 'Queued — waiting to start'
        entry.progress = 0
      }

      // Show the song row as soon as it exists server-side so the user
      // sees "Separating stems…" in the library while the pipeline runs.
      fetchSongs().catch(() => {})

      await pollJobUntilDone(uploadId, job_id)
    } catch (e) {
      const entry = uploads.value.find(u => u.id === uploadId)
      if (entry) {
        entry.status = 'failed'
        entry.error = e.message
      }
      setTimeout(() => removeUpload(uploadId), 8000)
    }
  }

  function uploadSong(file, artist = '', title = '', opts = {}) {
    return _runIngest(file, onProgress =>
      songApi.separate(file, onProgress, artist, title, opts))
  }

  // A karaoke video the host already owns. The server keeps the video for
  // display and extracts its audio as the song's instrumental stem, so from
  // here on it is an ordinary song. No lyric options: the lyrics are burned
  // into the picture.
  function importVideoSong(file, artist = '', title = '') {
    return _runIngest(file, onProgress =>
      songApi.importVideo(file, onProgress, artist, title))
  }

  function importCdgSong(file, artist = '', title = '') {
    return _runIngest(file, onProgress =>
      songApi.importCdg(file, onProgress, artist, title))
  }

  async function pollJobUntilDone(uploadId, jobId) {
    const findEntry = () => uploads.value.find(u => u.id === uploadId)

    try {
      await pollUntil(async () => {
        const res = await songApi.pollJob(jobId)
        const job = res.data
        const e = findEntry()

        if (job.status === 'done' || job.status === 'complete' || job.status === 'ready') {
          if (e) {
            e.status = 'done'
            e.phase = 'done'
            e.message = 'Ready'
            e.progress = 100
          }
          await fetchSongs()
          setTimeout(() => removeUpload(uploadId), 2000)
          return job
        }

        if (job.status === 'failed') {
          const msg = job.error || 'Processing failed'
          if (e) { e.status = 'failed'; e.phase = 'failed'; e.error = msg; e.message = msg }
          setTimeout(() => removeUpload(uploadId), 8000)
          throw new Error(msg)
        }

        // In-flight: surface phase + message so the UI can render "Transcribing…" etc.
        if (e) {
          e.phase = job.phase || job.status || e.phase
          e.message = job.message || e.message
          if (job.progress != null) e.progress = job.progress
        }
        return null
      }, { intervalMs: 3000, maxAttempts: 300 })
    } catch (e) {
      if (e.message === 'Polling timed out') {
        const ent = findEntry()
        if (ent) { ent.status = 'failed'; ent.error = 'Processing timed out' }
        setTimeout(() => removeUpload(uploadId), 8000)
      }
      throw e
    }
  }

  function removeUpload(id) {
    uploads.value = uploads.value.filter(u => u.id !== id)
  }

  async function loadSong(song) {
    try {
      const res = await songApi.get(song.id)
      currentSong.value = res.data
    } catch (e) {
      console.error('Failed to load song details:', e)
      currentSong.value = song
    }
  }

  async function deleteSong(id) {
    try {
      await songApi.delete(id)
      songs.value = songs.value.filter(s => s.id !== id)
      if (id in jobProgress.value) {
        const next = { ...jobProgress.value }
        delete next[id]
        jobProgress.value = next
      }
      if (currentSong.value?.id === id) {
        currentSong.value = null
      }
    } catch (e) {
      error.value = e.message
    }
  }

  async function fetchLyrics(artist, title) {
    try {
      const res = await songApi.lyrics(artist, title)
      return res.data
    } catch (e) {
      console.warn('Lyrics fetch failed:', e.message)
      return null
    }
  }

  async function listLyricsSets(songId) {
    try {
      const res = await lyricsSetsApi.list(songId)
      return res.data
    } catch (e) {
      console.warn('listLyricsSets failed:', e.message)
      return []
    }
  }

  async function activateLyricsSet(songId, lid) {
    const res = await lyricsSetsApi.activate(songId, lid)
    if (currentSong.value?.id === songId) {
      // Refresh detail so word_sync + lyrics_sets reflect the change.
      await loadSong({ id: songId })
    }
    return res.data
  }

  async function verifyLyricsSet(songId, lid) {
    const res = await lyricsSetsApi.verify(songId, lid)
    if (currentSong.value?.id === songId) await loadSong({ id: songId })
    return res.data
  }

  async function deleteLyricsSet(songId, lid) {
    await lyricsSetsApi.remove(songId, lid)
    if (currentSong.value?.id === songId) await loadSong({ id: songId })
  }

  async function createManualLyricsSet(songId, { plainLyrics, syncedLyrics, label, activate = true } = {}) {
    const isLrc = !!syncedLyrics || (plainLyrics && /\[\d{1,2}:\d{2}/.test(plainLyrics))
    const body = {
      source: 'manual',
      label: label || 'manual edit',
      plain_lyrics: isLrc ? null : plainLyrics,
      synced_lyrics: isLrc ? (syncedLyrics || plainLyrics) : null,
      activate,
    }
    const res = await lyricsSetsApi.create(songId, body)
    if (currentSong.value?.id === songId) await loadSong({ id: songId })
    return res.data
  }

  async function reTranscribe(songId, body = {}) {
    const res = await lyricsSetsApi.transcribe(songId, body)
    return res.data    // { job_id, song_id, message }
  }

  async function realign(songId, body = {}) {
    const res = await lyricsSetsApi.realign(songId, body)
    return res.data    // { job_id, song_id, message }
  }

  // Re-run LLM page structuring on one lyrics set. Errors propagate: the
  // editor surfaces them next to the button that started the job, and the
  // three refusals the route can answer (no word timings, no LLM endpoint)
  // are all things the operator can act on.
  async function pageLyricsSet(songId, lid, body = {}) {
    const res = await lyricsSetsApi.page(songId, lid, body)
    return res.data    // { job_id, song_id, message }
  }

  // Re-run the Pass-2 lead/backing split on a song already in the library.
  async function resplitStems(songId, body = {}) {
    const res = await songApi.resplit(songId, body)
    return res.data    // { job_id, song_id, message }
  }

  // ─── Per-song job tracking ────────────────────────────────────────────────
  // Every long-running per-song action — re-fit, listen again, re-page,
  // re-split, retry ingest — is a 202 + a job to poll. That polling used to
  // live inside whichever component started the job, which is where the races
  // lived: a panel re-pointed at another song inherited the previous song's
  // "busy", and a job that finished after the deck moved on refreshed the
  // wrong song. Here the record is KEYED BY SONG ID and the id is captured
  // when the job starts, so a component only ever reads the job belonging to
  // the song it is showing, and closing a panel orphans nothing — the poll
  // was never the panel's to begin with.
  //
  // Shape: activeJobs[songId] = { kind, jobId, status, phase, progress,
  //                               message, error, envelope }
  // status: 'queued' | 'running' | 'done' | 'failed'.
  const activeJobs = ref({})

  // The two statuses that mean "still going". A job that has finished — well
  // or badly — stays on the record so the panel and the library row can say
  // what happened; only these two lock the controls.
  const JOB_IN_FLIGHT = ['queued', 'running']

  function jobFor(songId) {
    return activeJobs.value[songId] ?? null
  }

  function isJobRunning(songId) {
    return JOB_IN_FLIGHT.includes(activeJobs.value[songId]?.status)
  }

  function clearJob(songId) {
    if (!(songId in activeJobs.value)) return
    const next = { ...activeJobs.value }
    delete next[songId]
    activeJobs.value = next
  }

  // Writes only into an EXISTING record. A patch that arrives after the record
  // was cleared (panel closed, song deleted) must not resurrect a half-filled
  // job, and a patch for song A must never touch song B's record.
  function _patchJob(songId, patch) {
    const current = activeJobs.value[songId]
    if (!current) return
    activeJobs.value = { ...activeJobs.value, [songId]: { ...current, ...patch } }
  }

  /**
   * Start one job for one song and poll it to completion.
   *
   * `start` performs the request and resolves with the 202 envelope
   * ({ job_id, … }). Failures — the request's own 4xx as much as the job's —
   * are RECORDED rather than thrown: the detail the server sends is the whole
   * point of these refusals, and it belongs on the song's job record where the
   * panel showing that song can render it. Resolves with the finished job, or
   * null when it did not finish.
   */
  async function runSongJob(songId, kind, start, { onDone, intervalMs = 3000, maxAttempts = 300 } = {}) {
    const sid = songId                     // captured: never re-read from a prop
    if (isJobRunning(sid)) return null

    activeJobs.value = {
      ...activeJobs.value,
      [sid]: {
        kind, jobId: null, status: 'queued', phase: 'queued',
        progress: null, message: 'Queued…', error: null, envelope: null,
      },
    }

    let envelope
    try {
      envelope = await start()
    } catch (e) {
      _patchJob(sid, { status: 'failed', error: e.message, message: e.message })
      return null
    }

    const jobId = envelope?.job_id ?? null
    _patchJob(sid, { jobId, envelope, status: jobId ? 'running' : 'done' })
    if (!jobId) {
      // Nothing to poll — treat the request itself as the whole job.
      _patchJob(sid, { phase: 'done', progress: 100, message: envelope?.message || 'Done' })
      if (onDone) await _safeOnDone(onDone, envelope)
      return envelope ?? null
    }

    try {
      const job = await pollUntil(async () => {
        // A blip on one poll is not a failed job. Only the server SAYING
        // failed is, so a transient error waits for the next tick.
        let data
        try {
          data = (await songApi.pollJob(jobId)).data
        } catch (err) {
          console.warn('job poll failed:', err.message)
          return null
        }
        if (data.status === 'done' || data.status === 'complete' || data.status === 'ready') return data
        if (data.status === 'failed') {
          const err = new Error(data.message || data.error || 'The job failed')
          err.job = data
          throw err
        }
        _patchJob(sid, {
          status: 'running',
          phase: data.phase || data.status || null,
          progress: data.progress ?? null,
          message: data.message || null,
        })
        return null
      }, { intervalMs, maxAttempts })

      _patchJob(sid, {
        status: 'done', phase: 'done', progress: 100,
        message: job.message || 'Finished', error: null,
      })
      if (onDone) await _safeOnDone(onDone, job)
      return job
    } catch (e) {
      const message = e.message === 'Polling timed out'
        ? 'The job is taking longer than expected — it may still be running.'
        : e.message
      _patchJob(sid, { status: 'failed', error: message, message })
      return null
    }
  }

  // A completion hook that throws must not turn a job that SUCCEEDED into a
  // failed one — the work landed on the server either way.
  async function _safeOnDone(onDone, job) {
    try {
      await onDone(job)
    } catch (e) {
      console.warn('job completion hook failed:', e.message)
    }
  }

  // The song detail carries word_sync and the set list, so any lyrics job that
  // lands has to be reflected on the deck if that song is the one loaded.
  async function _refreshSongDetail(songId) {
    if (currentSong.value?.id === songId) await loadSong({ id: songId })
  }

  function startRealign(songId, body = {}) {
    return runSongJob(songId, 'realign', () => realign(songId, body), {
      onDone: () => _refreshSongDetail(songId),
    })
  }

  function startTranscribe(songId, body = {}) {
    return runSongJob(songId, 'transcribe', async () => {
      await prepareHeart(body.whisper_model || 'heart')
      return reTranscribe(songId, body)
    }, {
      onDone: () => _refreshSongDetail(songId),
    })
  }

  function startPageLyricsSet(songId, lid, body = {}) {
    return runSongJob(songId, 'page', () => pageLyricsSet(songId, lid, body), {
      onDone: () => _refreshSongDetail(songId),
    })
  }

  // No detail refresh here: a re-split rewrites the stem files at the SAME
  // URLs, so whoever is playing the song has to cache-bust and reload rather
  // than re-read a detail that looks identical. AudioPlayer watches this
  // record for exactly that.
  function startResplit(songId, body = {}) {
    return runSongJob(songId, 'resplit', () => resplitStems(songId, body))
  }

  function startRetryIngest(songId) {
    return runSongJob(songId, 'retry', async () => {
      let res
      try {
        res = await songApi.retryIngest(songId)
      } catch (error) {
        // The server knows the original job kind. Prepared-video retries do
        // not need transcription, so only its missing-Heart refusal opens setup.
        if (error.code !== 'heart_model_missing') throw error
        await prepareHeart()
        res = await songApi.retryIngest(songId)
      }
      // The 202 means the server has ALREADY moved the row to `processing`,
      // and every surface that reads the row is still looking at `failed`:
      // Details keeps offering a retry it will now refuse, Lyrics keeps
      // saying "retry the ingest first". Re-reading the library here is also
      // what starts the 3s processing poll — it only runs while something in
      // the list is processing, so without this refresh nothing would ever
      // notice the row changed for the whole length of the retried ingest.
      fetchSongs().catch(() => {})
      return res.data      // { job_id, song_id, options_recovered, message }
    }, {
      // The row's status/phase come from the library list, not the job.
      onDone: () => fetchSongs(),
    })
  }

  // Artist/title (and the other editable metadata) for one song. Updates the
  // library row and the loaded detail in place so every surface showing this
  // song agrees without a full re-fetch.
  async function updateSongMeta(songId, body = {}) {
    const res = await songApi.updateSong(songId, body)
    const updated = res.data
    const idx = songs.value.findIndex(s => s.id === songId)
    if (idx !== -1) songs.value[idx] = { ...songs.value[idx], ...updated }
    if (currentSong.value?.id === songId) {
      currentSong.value = { ...currentSong.value, ...updated }
    }
    return updated
  }

  async function cacheStatus(songId, params = {}) {
    try {
      const res = await lyricsSetsApi.cacheStatus(songId, params)
      return res.data    // { exists, path, label }
    } catch (e) {
      console.warn('cacheStatus failed:', e.message)
      return { exists: false, path: null, label: '' }
    }
  }

  return {
    songs, currentSong, uploads, statusFilter, searchQuery, loading, error,
    filteredSongs, readySongs, processingCount,
    jobLastChangeAt,
    fetchSongs, uploadSong, importVideoSong, importCdgSong, loadSong, deleteSong,
    fetchLyrics,
    listLyricsSets, activateLyricsSet, verifyLyricsSet, deleteLyricsSet,
    createManualLyricsSet, reTranscribe, realign, cacheStatus,
    pageLyricsSet, resplitStems,
    // Per-song job tracking
    activeJobs, jobFor, isJobRunning, clearJob, runSongJob,
    startRealign, startTranscribe, startPageLyricsSet, startResplit,
    startRetryIngest, updateSongMeta,
  }
})
