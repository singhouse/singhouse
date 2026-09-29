// SPDX-License-Identifier: AGPL-3.0-only
// Explicit, real local inference. Run only with licensed evaluation audio.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseArguments(args) {
  const options = {}, valued = new Set(['--executable', '--runtime-manifest', '--audio', '--output', '--timeout-seconds'])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--download-models') { options.downloadModels = true; continue }
    if (flag === '--model-folder') throw new Error('The advanced application route has no combined offline model-folder import. Use --download-models explicitly; do not transplant cache pointers.')
    if (!valued.has(flag) || options[flag] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}`)
    options[flag] = args[++i]
  }
  for (const key of ['--executable', '--runtime-manifest', '--audio', '--output']) assert.ok(options[key], `Missing ${key}`)
  assert.ok(options.downloadModels, 'Explicit --download-models consent is required to retrieve the three model sets from policy-defined upstreams')
  const seconds = Number(options['--timeout-seconds'] ?? 3600)
  assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 14400, 'Timeout must be 60–14400 seconds')
  return { executable: resolve(options['--executable']), manifest: resolve(options['--runtime-manifest']),
    audio: resolve(options['--audio']), output: resolve(options['--output']), timeoutMs: seconds * 1000 }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const MODEL_IDS = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']

export async function run(options) {
  assert.equal(process.platform, 'win32', 'This qualification harness requires the Windows packaged application')
  assert.ok(statSync(options.executable).isFile(), 'Packaged executable is required')
  const nativeBin = join(dirname(options.executable), 'resources', 'native', 'ffmpeg', 'bin')
  const ffmpeg = join(nativeBin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const ffprobe = join(nativeBin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const inputProbe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', options.audio], { timeout: 30000, encoding: 'utf8' }))
  const inputDuration = Number(inputProbe.format?.duration)
  assert.ok(Number.isFinite(inputDuration) && inputDuration > 0 && inputDuration <= 120, 'Supply a vocal excerpt no longer than 120 seconds')
  assert.ok(statSync(options.audio).size > 0 && statSync(options.audio).size <= 64 * 1024 * 1024, 'Supply a short licensed audio excerpt of at most 64 MiB')
  const input = readFileSync(options.audio)
  const manifestBytes = readFileSync(options.manifest), manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.kind, 'processing')
  // The real app, not this harness, decides whether this lock is trusted.
  mkdirSync(options.output) // A fresh evidence/profile directory is mandatory.
  const profile = join(options.output, 'profile')
  const started = Date.now(), deadline = started + options.timeoutMs
  const evidence = { schema: 1, kind: 'packaged-local-processing-smoke', startedAt: new Date(started).toISOString(),
    status: 'running', input: { sha256: hash(input), bytes: input.length, durationSeconds: inputDuration },
    executableSha256: hash(readFileSync(options.executable)),
    runtimeManifestSha256: hash(manifestBytes), runtimeLockSha256: manifest.provenance?.lockSha256,
    consent: { modelRetrieval: true, localInference: true }, timingsMs: {}, transitions: [],
    limitations: ['Not corpus accuracy or listening evidence', 'Not physical output or show qualification',
      'No representative RAM/VRAM measurement', 'Does not qualify a release catalog'] }
  const save = () => writeFileSync(join(options.output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  save()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|windir|COMSPEC|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|LANG|LC_[A-Z_]+)$/u.test(key)))
  env.XDG_CONFIG_HOME = options.output
  let application, host
  const remaining = () => { const value = deadline - Date.now(); assert.ok(value > 0, 'Total processing smoke deadline exceeded'); return value }
  const bounded = async (operation, milliseconds = remaining()) => {
    let timer
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Processing smoke operation timed out')), Math.min(milliseconds, remaining())) })]) }
    finally { clearTimeout(timer) }
  }
  async function api(path) {
    return bounded(host.evaluate(async path => {
      const response = await fetch(path, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Application API returned ${response.status}`)
      return response.json()
    }, path), 20000)
  }
  async function close() {
    if (!application) return
    const owned = application; application = null
    let timer
    try {
      await Promise.race([owned.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Application close timed out')), 30000) })])
    } catch {
      const pid = owned.process().pid
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000, stdio: 'ignore' })
      else owned.process().kill('SIGKILL')
    } finally { clearTimeout(timer) }
  }
  async function launch() {
    const { _electron: electron } = await import('playwright')
    // Playwright owns launch timeout cleanup. An outer Promise.race could
    // abandon a late successful handle before it becomes ours to close.
    application = await electron.launch({ executablePath: options.executable,
      args: [`--user-data-dir=${profile}`], env, timeout: Math.min(300000, remaining()) })
    remaining() // Assign ownership first so an expired deadline still closes it.
    const identity = await bounded(application.evaluate(({ app }) => ({ packaged: app.isPackaged,
      userData: app.getPath('userData'), appVersion: app.getVersion(), platform: process.platform, arch: process.arch })))
    assert.equal(identity.packaged, true)
    const child = relative(options.output, identity.userData)
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Application profile escaped the isolated directory')
    if (evidence.application) assert.equal(evidence.application.userData, identity.userData)
    evidence.application = identity
    const launchDeadline = Date.now() + Math.min(300000, remaining())
    while (!(host = application.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url())))) {
      assert.ok(Date.now() < launchDeadline, 'Application host did not start'); remaining(); await pause(200)
    }
    await bounded(host.waitForLoadState('domcontentloaded'))
    assert.equal((await api('/health')).status, 'ok')
  }
  async function install(path, kind) {
    const installationStarted = Date.now()
    // Replace only the native file/consent dialogs. The actual advanced menu
    // callback owns manifest validation, transfer, probing and activation.
    await bounded(application.evaluate(({ Menu, dialog }, { path, kind }) => {
      const entry = Menu.getApplicationMenu()?.items.find(item => item.label === 'Processing')?.submenu?.items
        .find(item => item.label === 'Advanced: install runtime or model manifest…')
      if (!entry) throw new Error('Packaged advanced installation route is unavailable')
      const original = { showOpenDialog: dialog.showOpenDialog, showMessageBox: dialog.showMessageBox, showErrorBox: dialog.showErrorBox }
      globalThis.__processingSmoke = { done: false, error: null, restore: () => Object.assign(dialog, original) }
      dialog.showOpenDialog = async (_host, options) => {
        if (options.title !== 'Select a processing or upstream model manifest') throw new Error('Unexpected file dialog')
        return { canceled: false, filePaths: [path] }
      }
      dialog.showMessageBox = async (_host, options) => {
        if (options.message === 'Installation verified. Reopen the app to use it.') {
          globalThis.__processingSmoke.done = true; return { response: 0 }
        }
        const expected = kind === 'models' ? 'Install model files directly from declared upstream sources?' : 'Install this selected processing runtime?'
        if (options.message !== expected || options.buttons?.join('|') !== 'Cancel|Install') throw new Error('Unexpected installation consent dialog')
        return { response: 1 }
      }
      dialog.showErrorBox = (title, message) => { globalThis.__processingSmoke.error = `${title}: ${message}` }
      entry.click()
    }, { path, kind }))
    try {
      while (true) {
        remaining()
        const state = await bounded(application.evaluate(() => ({ done: globalThis.__processingSmoke.done, error: globalThis.__processingSmoke.error })))
        if (state.error) throw new Error(state.error)
        if (state.done) break
        await pause(500)
      }
      // Let the real operation's finally release its installation marker.
      await pause(100)
    } finally {
      await bounded(application.evaluate(() => { globalThis.__processingSmoke.restore(); delete globalThis.__processingSmoke }), 5000).catch(() => {})
    }
    evidence.timingsMs[`${kind}Installation`] = Date.now() - installationStarted; save()
  }
  try {
    await launch()
    const songs = await api('/api/songs')
    assert.equal(songs.total, 0, 'Qualification profile must have an empty library')
    const featurePolicy = await api('/api/features')
    assert.equal(featurePolicy.lyrics_lookup.enabled, false, 'External lyric lookup must be disabled')
    await install(options.manifest, 'processing')
    const policyEncoded = await bounded(application.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      return fs.readFileSync(path.join(app.getAppPath(), 'models.json')).toString('base64')
    }))
    const policyBytes = Buffer.from(policyEncoded, 'base64')
    const policy = JSON.parse(policyBytes.toString('utf8'))
    const entries = MODEL_IDS.map(id => { const matches = policy.models.filter(entry => entry.id === id); assert.equal(matches.length, 1); return matches[0] })
    const modelManifest = { schema: 1, kind: 'models', models: MODEL_IDS, files: entries.flatMap(entry => entry.files) }
    const modelPath = join(options.output, 'model-manifest.json')
    const modelManifestBytes = Buffer.from(`${JSON.stringify(modelManifest, null, 2)}\n`)
    writeFileSync(modelPath, modelManifestBytes, { flag: 'wx' })
    evidence.modelPolicySha256 = hash(policyBytes)
    evidence.modelManifestSha256 = hash(modelManifestBytes)
    await install(modelPath, 'models')
    await close(); await launch()
    const readiness = await api('/api/features/processing')
    evidence.readiness = readiness
    assert.equal(readiness.separation.ready, true); assert.equal(readiness.transcription.ready, true)
    assert.equal(readiness.modal.selected, false); assert.equal(readiness.modal.ready, false)
    assert.equal(readiness.runtime.accelerator, manifest.accelerator)
    assert.equal(readiness.runtime.id, hash(Buffer.from(JSON.stringify(manifest))), 'Application selected a different processing runtime')
    const inferenceStarted = Date.now()
    const submitted = await bounded(host.evaluate(async ({ bytes, filename }) => {
      const data = Uint8Array.from(atob(bytes), value => value.charCodeAt(0)), form = new FormData()
      form.append('file', new Blob([data], { type: 'application/octet-stream' }), filename)
      form.append('artist', 'Licensed qualification audio'); form.append('title', 'Isolated processing smoke')
      form.append('karaoke_model', 'roformer'); form.append('llm_correction', 'false'); form.append('llm_paging', 'false')
      // Ingest selects Heart internally; there is no whisper_model upload field.
      const response = await fetch('/api/separate', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
      if (response.status !== 202) throw new Error(`Audio upload returned ${response.status}`)
      return response.json()
    }, { bytes: input.toString('base64'), filename: basename(options.audio) }), 65000)
    evidence.songId = submitted.song_id; evidence.jobId = submitted.job_id
    let job, previous
    while (true) {
      remaining(); job = await api(`/api/jobs/${encodeURIComponent(submitted.job_id)}`)
      const state = `${job.status}/${job.phase}`
      if (state !== previous) { evidence.transitions.push({ elapsedMs: Date.now() - inferenceStarted, status: job.status, phase: job.phase }); previous = state; save() }
      if (job.status === 'failed') { evidence.jobError = job.error || 'No error details supplied'; throw new Error('Application processing job failed; inspect evidence.json and isolated application diagnostics') }
      if (job.status === 'done') break
      await pause(2000)
    }
    evidence.timingsMs.localPipeline = Date.now() - inferenceStarted
    const song = await api(`/api/songs/${submitted.song_id}`)
    assert.equal(song.status, 'ready'); assert.equal(song.word_sync?.metadata?.model, 'heart')
    const words = song.word_sync.lines?.flat() || []
    assert.equal(song.word_sync?.metadata?.pipeline_config?.correction?.enabled, false, 'External correction must remain disabled')
    assert.ok(words.length > 0, 'Real Heart inference must produce word timings for the vocal excerpt')
    assert.ok(words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start), 'Invalid word intervals')
    assert.ok(words.every((word, index) => index === 0 || word.start >= words[index - 1].start), 'Word intervals are not ordered')
    evidence.transcription = { model: 'heart', words: words.length, lastWordEnd: Math.max(...words.map(word => word.end)) }
    evidence.outputs = {}
    for (const role of ['lead_vocals', 'backing_vocals', 'instrumental', 'karaoke']) {
      const url = song.stems?.[role]; assert.ok(url, `Missing ${role} output`)
      const encoded = await bounded(host.evaluate(async url => {
        const target = new URL(url, location.href)
        if (target.origin !== location.origin) throw new Error('Unexpected nonlocal output URL')
        const response = await fetch(target, { signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error('Output could not be read')
        const bytes = new Uint8Array(await response.arrayBuffer())
        let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return btoa(binary)
      }, url), 35000)
      const bytes = Buffer.from(encoded, 'base64'), path = join(options.output, `${role}.wav`)
      writeFileSync(path, bytes, { flag: 'wx' })
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration_ts,time_base:format=duration', '-of', 'json', path], { timeout: Math.min(30000, remaining()), encoding: 'utf8' }))
      execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', path, '-f', 'null', '-'], { timeout: Math.min(60000, remaining()), stdio: 'pipe' })
      assert.equal(probe.streams?.[0]?.codec_name, 'pcm_s16le', 'Expected finite PCM16 playback output')
      evidence.outputs[role] = { sha256: hash(bytes), bytes: bytes.length, probe, decodePassed: true }
    }
    const reference = evidence.outputs.lead_vocals.probe.streams[0]
    assert.equal(reference.channels, 2, 'Expected stereo playback outputs')
    assert.ok(Number(reference.duration_ts) > 0 && Number(reference.sample_rate) > 0, 'Output audio is empty')
    assert.ok(Math.abs(Number(evidence.outputs.lead_vocals.probe.format.duration) - inputDuration) <= 0.1, 'Processing truncated or extended the input duration')
    for (const item of Object.values(evidence.outputs)) assert.deepEqual(item.probe.streams[0], reference, 'Output stems are not aligned')
    assert.ok(evidence.transcription.lastWordEnd <= Number(evidence.outputs.lead_vocals.probe.format.duration) + 0.5, 'Word timing exceeds audio duration')
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message
    if (application) await bounded(application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.label === 'Processing')?.submenu?.items.find(item => item.label === 'Cancel installation')?.click()), 5000).catch(() => {})
    throw error
  } finally {
    try { await close() }
    catch (error) { evidence.status = 'failed'; evidence.shutdownError = 'Owned application shutdown failed'; throw error }
    finally { evidence.finishedAt = new Date().toISOString(); evidence.timingsMs.total = Date.now() - started; save() }
  }
  console.log(`Real local processing smoke passed. Evidence: ${join(options.output, 'evidence.json')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
