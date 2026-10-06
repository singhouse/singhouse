// SPDX-License-Identifier: AGPL-3.0-only
// Song export on the desktop. The renderer chooses a song and its options;
// the destination folder comes only from the native folder picker and is kept
// in application state, so no renderer-selected path ever reaches the disk.
import { mkdir, open, unlink } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const EXPORT_FORMATS = ['video', 'mp3g']
export const EXPORT_AUDIO = ['karaoke', 'instrumental']
// Formats the backend can produce today; video arrives with its renderer.
const WRITABLE_FORMATS = new Set(['mp3g'])
const STATE_KEY = 'export'

export function defaultExportFolder({ getPath, home, brand = 'singhouse' }) {
  let base = null
  try { base = getPath('music') } catch { /* No music folder on this system. */ }
  return join(base || home, brand)
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Display form of a folder: the home-folder prefix shown as "~".
export function folderLabel(folder, home) {
  if (!home || !isAbsolute(home)) return folder
  const rest = relative(home, folder)
  if (rest === '') return '~'
  if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) return folder
  return `~${sep}${rest}`
}

export function exportDefaults(value, defaultFolder, home) {
  const stored = plain(value)
  const folder = typeof stored.folder === 'string' && isAbsolute(stored.folder) ? stored.folder : defaultFolder
  return {
    folder,
    label: folderLabel(folder, home),
    format: EXPORT_FORMATS.includes(stored.format) ? stored.format : 'video',
    audio: EXPORT_AUDIO.includes(stored.audio) ? stored.audio : 'karaoke',
  }
}

// `state` is a keyed JSON store with read() and save(key, value), such as
// OnboardingState. Only fields the user chose are stored, so the computed
// default folder follows the system until a folder is picked.
export class ExportPreferences {
  constructor({ state, defaultFolder, home }) {
    this.state = state
    this.defaultFolder = defaultFolder
    this.home = home
    this.pending = Promise.resolve()
  }

  async stored() { return plain((await this.state.read())?.[STATE_KEY]) }

  async get() {
    await this.pending
    return exportDefaults(await this.stored(), this.defaultFolder, this.home)
  }

  update(change) {
    const action = this.pending.then(async () => {
      const next = { ...await this.stored(), ...change }
      await this.state.save(STATE_KEY, next)
      return exportDefaults(next, this.defaultFolder, this.home)
    })
    this.pending = action.catch(() => {})
    return action
  }

  async chooseFolder(choose) {
    const folder = await choose()
    if (typeof folder !== 'string' || !isAbsolute(folder)) return this.get()
    return this.update({ folder })
  }

  saveDefaults(value) {
    const { format, audio } = plain(value)
    if (!EXPORT_FORMATS.includes(format) || !EXPORT_AUDIO.includes(audio)) {
      return Promise.reject(new Error('Unknown export format or audio choice'))
    }
    return this.update({ format, audio })
  }
}

export function exportRequestPath(request) {
  const { songId, format, audio, lyricsSet } = plain(request)
  if (!Number.isSafeInteger(songId) || songId <= 0) throw new Error('Choose a song to export')
  if (format === 'video') throw new Error('Video export is not available yet')
  if (!WRITABLE_FORMATS.has(format)) throw new Error('Unknown export format')
  const params = new URLSearchParams({ format })
  if (audio != null) {
    if (!EXPORT_AUDIO.includes(audio)) throw new Error('Unknown export audio choice')
    params.set('audio', audio)
  }
  if (lyricsSet != null) {
    if (!Number.isSafeInteger(lyricsSet) || lyricsSet <= 0) throw new Error('Unknown lyrics set')
    params.set('lyrics_set', String(lyricsSet))
  }
  params.set('card', 'true')
  return `/api/export/songs/${songId}?${params}`
}

// Prefer the RFC 5987 encoded form, then the quoted one, then a bare token.
export function filenameFromDisposition(value, fallback) {
  if (value) {
    const star = /filename\*=utf-8''([^;]+)/i.exec(value)
    if (star) {
      try { return decodeURIComponent(star[1].trim()) } catch { /* fall through */ }
    }
    const quoted = /filename="([^"]+)"/i.exec(value)
    if (quoted) return quoted[1]
    const bare = /filename=([^;]+)/i.exec(value)
    if (bare) return bare[1].trim()
  }
  return fallback
}

// The name comes from the server, but it still must not leave the folder or
// be unusable on any desktop platform.
export function safeFilename(name, fallback) {
  let cleaned = String(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '')
  if (!cleaned || /^\.+$/.test(cleaned)) cleaned = fallback
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  if (cleaned.length > 200) {
    const ext = extname(cleaned).slice(0, 16)
    cleaned = cleaned.slice(0, 200 - ext.length) + ext
  }
  return cleaned
}

// Reserve the first free name: "name.zip", "name (2).zip", "name (3).zip"…
// The exclusive open never replaces an existing file, even one created
// between attempts.
export async function createUniqueFile(folder, name, { openFile = open, limit = 1000 } = {}) {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let index = 1; index <= limit; index++) {
    const path = join(folder, index === 1 ? name : `${stem} (${index})${ext}`)
    try { return { path, handle: await openFile(path, 'wx', 0o644) } }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  throw new Error('Could not find a free file name in the export folder')
}

async function failureMessage(response) {
  try {
    const body = await response.json()
    if (typeof body?.detail === 'string' && body.detail) return body.detail
  } catch { /* fall through */ }
  return `Export failed: the server answered ${response.status}`
}

// `fetch(path, init)` is the authenticated application-session fetch.
export async function writeExport({ fetch, folder, request, signal }) {
  const path = exportRequestPath(request)
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Choose a folder to save the export to')
  let response
  try { response = await fetch(path, { signal }) }
  catch (error) { throw new Error(`Export failed: ${error?.message || 'the request did not complete'}`) }
  if (!response.ok) throw new Error(await failureMessage(response))

  const fallback = `export-song-${request.songId}.zip`
  const name = safeFilename(filenameFromDisposition(response.headers.get('content-disposition'), fallback), fallback)
  try { await mkdir(folder, { recursive: true }) }
  catch (error) { throw new Error(`Could not create the export folder: ${error.message}`) }
  const { path: target, handle } = await createUniqueFile(folder, name)
  try {
    const body = response.body ? Readable.fromWeb(response.body) : Readable.from([])
    await pipeline(body, handle.createWriteStream())
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(target).catch(() => {})
    throw new Error(`Export failed: ${error?.message || 'the file could not be written'}`)
  }
  return { path: target }
}
