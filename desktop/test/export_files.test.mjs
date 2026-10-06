// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnboardingState } from '../onboarding_state.mjs'
import {
  ExportPreferences, createUniqueFile, defaultExportFolder, exportDefaults, exportRequestPath,
  filenameFromDisposition, folderLabel, safeFilename, writeExport,
} from '../export_files.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'singhouse-export-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function streamResponse(chunks, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers })
}

const request = { songId: 7, format: 'mp3g', audio: 'karaoke' }

test('default folder is the brand folder under music, falling back to home', () => {
  assert.equal(defaultExportFolder({ getPath: () => '/home/someone/Music', home: '/home/someone' }),
    join('/home/someone/Music', 'singhouse'))
  assert.equal(defaultExportFolder({ getPath: () => { throw new Error('no music folder') }, home: '/home/someone' }),
    join('/home/someone', 'singhouse'))
  assert.equal(defaultExportFolder({ getPath: () => '', home: '/home/someone' }), join('/home/someone', 'singhouse'))
})

test('defaults are validated and never invent a relative folder', () => {
  assert.deepEqual(exportDefaults(undefined, '/m/singhouse'), { folder: '/m/singhouse', label: '/m/singhouse', format: 'video', audio: 'karaoke' })
  for (const value of [null, 42, 'x', [], { folder: 'relative/dir', format: 'cdg', audio: 'loud' }]) {
    assert.deepEqual(exportDefaults(value, '/m/singhouse'), { folder: '/m/singhouse', label: '/m/singhouse', format: 'video', audio: 'karaoke' })
  }
  assert.deepEqual(exportDefaults({ folder: '/x/y', format: 'mp3g', audio: 'instrumental' }, '/m', '/x'),
    { folder: '/x/y', label: join('~', 'y'), format: 'mp3g', audio: 'instrumental' })
})

test('folders under home are labelled with ~ and others are shown in full', async t => {
  assert.equal(folderLabel('/home/someone/Music/singhouse', '/home/someone'), join('~', 'Music', 'singhouse'))
  assert.equal(folderLabel('/home/someone', '/home/someone'), '~')
  assert.equal(folderLabel('/home/someoneelse/x', '/home/someone'), '/home/someoneelse/x')
  assert.equal(folderLabel('/home/someone/..data', '/home/someone'), join('~', '..data'))
  assert.equal(folderLabel('/srv/exports', '/home/someone'), '/srv/exports')
  assert.equal(folderLabel('/srv/exports', undefined), '/srv/exports')

  const directory = await fixture(t)
  const preferences = new ExportPreferences({ state: new OnboardingState(join(directory, 'export.json')),
    defaultFolder: '/home/someone/Music/singhouse', home: '/home/someone' })
  assert.equal((await preferences.get()).label, join('~', 'Music', 'singhouse'))
  const chosen = await preferences.chooseFolder(async () => '/home/someone/Desktop/gig friday')
  assert.deepEqual([chosen.folder, chosen.label], ['/home/someone/Desktop/gig friday', join('~', 'Desktop', 'gig friday')])
})

test('reading defaults does not create the folder', async t => {
  const directory = await fixture(t)
  const folder = join(directory, 'Music', 'singhouse')
  const preferences = new ExportPreferences({ state: new OnboardingState(join(directory, 'export.json')), defaultFolder: folder })
  assert.deepEqual(await preferences.get(), { folder, label: folder, format: 'video', audio: 'karaoke' })
  assert.deepEqual(await readdir(directory), [])
})

test('choose-folder persists a picked folder and ignores a cancelled picker', async t => {
  const directory = await fixture(t)
  const path = join(directory, 'export.json')
  const preferences = new ExportPreferences({ state: new OnboardingState(path), defaultFolder: '/m/singhouse' })

  assert.deepEqual(await preferences.chooseFolder(async () => null), { folder: '/m/singhouse', label: '/m/singhouse', format: 'video', audio: 'karaoke' })
  await assert.rejects(readFile(path), { code: 'ENOENT' })

  const picked = join(directory, 'gig')
  assert.deepEqual(await preferences.chooseFolder(async () => picked), { folder: picked, label: picked, format: 'video', audio: 'karaoke' })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { export: { folder: picked } })

  // A fresh store over the same file sees the choice: it survives restarts.
  const reopened = new ExportPreferences({ state: new OnboardingState(path), defaultFolder: '/m/singhouse' })
  assert.equal((await reopened.get()).folder, picked)

  assert.equal((await reopened.chooseFolder(async () => 'relative')).folder, picked)
})

test('save-defaults persists format and audio alongside the chosen folder', async t => {
  const directory = await fixture(t)
  const path = join(directory, 'export.json')
  const preferences = new ExportPreferences({ state: new OnboardingState(path), defaultFolder: '/m/singhouse' })
  await preferences.chooseFolder(async () => '/x/gig')
  assert.deepEqual(await preferences.saveDefaults({ format: 'mp3g', audio: 'instrumental', folder: '/elsewhere' }),
    { folder: '/x/gig', label: '/x/gig', format: 'mp3g', audio: 'instrumental' })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).export, { folder: '/x/gig', format: 'mp3g', audio: 'instrumental' })
  await assert.rejects(preferences.saveDefaults({ format: 'cdg', audio: 'karaoke' }), /Unknown export format/)
  await assert.rejects(preferences.saveDefaults(null), /Unknown export format/)
  assert.equal((await preferences.get()).format, 'mp3g')
})

test('the export request always asks for the card and accepts only known options', () => {
  assert.equal(exportRequestPath(request), '/api/export/songs/7?format=mp3g&audio=karaoke&card=true')
  assert.equal(exportRequestPath({ ...request, audio: 'instrumental', lyricsSet: 3 }),
    '/api/export/songs/7?format=mp3g&audio=instrumental&lyrics_set=3&card=true')
  assert.throws(() => exportRequestPath({ ...request, format: 'video' }), /Video export is not available yet/)
  assert.throws(() => exportRequestPath({ ...request, format: 'cdg' }), /Unknown export format/)
  assert.throws(() => exportRequestPath({ ...request, audio: 'loud' }), /Unknown export audio/)
  assert.throws(() => exportRequestPath({ ...request, songId: '7/../../x' }), /Choose a song/)
  assert.throws(() => exportRequestPath({ ...request, lyricsSet: 1.5 }), /Unknown lyrics set/)
  assert.throws(() => exportRequestPath(undefined), /Choose a song/)
})

test('Content-Disposition parsing prefers the encoded name', () => {
  assert.equal(filenameFromDisposition('attachment; filename="A - B.zip"', 'f.zip'), 'A - B.zip')
  assert.equal(filenameFromDisposition(`attachment; filename="S_ng.zip"; filename*=UTF-8''S%C3%B8ng%20One.zip`, 'f.zip'), 'Søng One.zip')
  assert.equal(filenameFromDisposition('attachment; filename=plain.zip', 'f.zip'), 'plain.zip')
  assert.equal(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A.zip; filename="ok.zip"`, 'f.zip'), 'ok.zip')
  assert.equal(filenameFromDisposition(null, 'f.zip'), 'f.zip')
  assert.equal(filenameFromDisposition('attachment', 'f.zip'), 'f.zip')
})

test('server names cannot leave the folder or use reserved names', () => {
  assert.equal(safeFilename('../../etc/passwd', 'f.zip'), '.._.._etc_passwd')
  assert.equal(safeFilename('a\\b:c*?.zip', 'f.zip'), 'a_b_c__.zip')
  assert.equal(safeFilename('..', 'f.zip'), 'f.zip')
  assert.equal(safeFilename('  ', 'f.zip'), 'f.zip')
  assert.equal(safeFilename('name.zip. ', 'f.zip'), 'name.zip')
  assert.equal(safeFilename('CON.zip', 'f.zip'), '_CON.zip')
  const long = safeFilename(`${'x'.repeat(400)}.zip`, 'f.zip')
  assert.equal(long.length, 200)
  assert.ok(long.endsWith('.zip'))
})

test('unique names count up and never replace an existing file', async t => {
  const directory = await fixture(t)
  await writeFile(join(directory, 'Song.zip'), 'first')
  await writeFile(join(directory, 'Song (2).zip'), 'second')
  const { path, handle } = await createUniqueFile(directory, 'Song.zip')
  await handle.close()
  assert.equal(path, join(directory, 'Song (3).zip'))
  assert.equal(await readFile(join(directory, 'Song.zip'), 'utf8'), 'first')

  const bare = await createUniqueFile(directory, 'Song')
  await bare.handle.close()
  assert.equal(bare.path, join(directory, 'Song'))

  await assert.rejects(createUniqueFile(directory, 'Song.zip', { limit: 3 }), /free file name/)
})

test('writes the streamed body into the folder, creating it on first write', async t => {
  const directory = await fixture(t)
  const folder = join(directory, 'Music', 'singhouse')
  const calls = []
  const fetch = async (path, init) => {
    calls.push({ path, init })
    return streamResponse(['zip-', 'bytes'], { headers: { 'Content-Disposition': 'attachment; filename="Ackerman - Zither Blues.zip"' } })
  }
  const signal = AbortSignal.timeout(10_000)
  const first = await writeExport({ fetch, folder, request, signal })
  assert.deepEqual(first, { path: join(folder, 'Ackerman - Zither Blues.zip') })
  assert.equal(await readFile(first.path, 'utf8'), 'zip-bytes')
  assert.equal(calls[0].path, '/api/export/songs/7?format=mp3g&audio=karaoke&card=true')
  assert.equal(calls[0].init.signal, signal)

  const second = await writeExport({ fetch, folder, request })
  assert.equal(second.path, join(folder, 'Ackerman - Zither Blues (2).zip'))
  assert.equal(await readFile(first.path, 'utf8'), 'zip-bytes')
})

test('falls back to an id-based name without a Content-Disposition header', async t => {
  const folder = await fixture(t)
  const result = await writeExport({ fetch: async () => streamResponse(['x']), folder, request })
  assert.equal(result.path, join(folder, 'export-song-7.zip'))
})

test('a server refusal surfaces its detail and writes nothing', async t => {
  const folder = await fixture(t)
  const fetch = async () => new Response(JSON.stringify({ detail: 'Song has no word sync' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } })
  await assert.rejects(writeExport({ fetch, folder, request }), { message: 'Song has no word sync' })
  const html = async () => new Response('<html>oops</html>', { status: 500 })
  await assert.rejects(writeExport({ fetch: html, folder, request }), { message: 'Export failed: the server answered 500' })
  const offline = async () => { throw new Error('net::ERR_CONNECTION_REFUSED') }
  await assert.rejects(writeExport({ fetch: offline, folder, request }), { message: 'Export failed: net::ERR_CONNECTION_REFUSED' })
  assert.deepEqual(await readdir(folder), [])
})

test('a stream that fails midway leaves no partial file', async t => {
  const folder = await fixture(t)
  const fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'))
      controller.error(new Error('connection reset'))
    },
  }), { headers: { 'Content-Disposition': 'attachment; filename="x.zip"' } })
  await assert.rejects(writeExport({ fetch, folder, request }), /Export failed: connection reset/)
  assert.deepEqual(await readdir(folder), [])
})

test('invalid requests and folders are refused before any fetch', async t => {
  const directory = await fixture(t)
  let fetched = false
  const fetch = async () => { fetched = true; return streamResponse(['x']) }
  await assert.rejects(writeExport({ fetch, folder: directory, request: { ...request, format: 'video' } }), /not available yet/)
  await assert.rejects(writeExport({ fetch, folder: 'relative', request }), /Choose a folder/)
  assert.equal(fetched, false)
  await mkdir(join(directory, 'blocked'))
  await writeFile(join(directory, 'blocked', 'file'), '')
  await assert.rejects(writeExport({ fetch, folder: join(directory, 'blocked', 'file'), request }), /Could not create the export folder/)
})
