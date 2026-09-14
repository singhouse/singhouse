// SPDX-License-Identifier: AGPL-3.0-only
import { ref } from 'vue'
import { useAudioOutput } from './useAudioOutput.js'
import { registerAnalysers, clearAnalysers } from './audioReactive.js'
import { loadStretchFactory } from './signalsmithLoader.js'

// Signalsmith Stretch factory (the vendored module's default export). Loaded
// lazily once via dynamic import and shared across engine instances — it's a
// context-independent loader that self-registers its worklet (a Blob module
// URL) the first time a node is built on a given AudioContext. Kept out of the
// app bundle by the @vite-ignore dynamic import.
let stretchFactory = null

export function useAudioEngine() {
  const output = useAudioOutput()
  let audioCtx = null
  const audioElements = {}
  const gainNodes = {}
  const sources = {}
  // Audio-reactive analyser taps (post-volume/post-mute) shared with the canvas
  // stage via audioReactive.js: `mix` sums every stem, `inst`/`vocals` tap one.
  const analysers = { mix: null, inst: null, vocals: null }
  // Transport publication must not depend on whether the host window is
  // composited. On Wayland an rAF owned by a window on an inactive workspace
  // can stop even with Electron backgroundThrottling disabled, while Web Audio
  // and the media elements continue playing. A regular timer remains active
  // under that Electron preference and lets the visible projector keep
  // receiving the one audio owner's clock.
  let clockTimer = null
  const CLOCK_INTERVAL_MS = 1000 / 60
  // Last callbacks handed to startAnimationLoop, retained so play() can
  // restart the loop after a natural end tore it down (see the end branch in
  // tick() and the re-arm in play()).
  let onTickCb = null
  let onEndedCb = null
  // Key of the element that drives the transport clock — the instrumental bed
  // when present, else the first loaded stem. Set in loadStems.
  let primaryKey = null

  const currentTime = ref(0)
  const duration = ref(0)
  const playerState = ref('stopped')

  // ── Key (pitch) shift ──────────────────────────────────────────────────
  // A musical key change must transpose pitch WITHOUT changing tempo, which
  // Web Audio has no native node for. We insert a Signalsmith Stretch
  // AudioWorkletNode (vendored at /vendor/signalsmith/SignalsmithStretch.mjs)
  // per stem, but ONLY when key != 0 — at key 0 the graph stays
  // src -> gain -> destination, byte-identical to no shift (zero latency, zero
  // artifacts). AudioWorklet is a secure-context API, so on insecure LAN HTTP
  // the feature degrades to "unsupported" and audio still plays normally
  // through the bypass path. Signalsmith runs at ~unity, so there is no makeup
  // gain in the chain (the old phase-vocoder needed one; this engine does not).
  const pitchNodes = {}   // Signalsmith StretchNode per stem, pre-created & disconnected
  const dipNodes = {}     // dedicated reroute-mute gain (always in chain, unity except during a swap)
  const dipTimers = {}    // pending zero-crossing reroute timer per stem
  let workletReady = false                                          // Signalsmith factory loaded
  const keyShiftSupported = ref(false)                              // secure ctx + worklet present (UI binds this)
  const keyOffset = ref(0)                                          // current semitone offset (-12..+12)
  // Total Signalsmith processing latency in SECONDS (node.latency() =
  // inputLatency + outputLatency, already /sampleRate), cached once at node
  // creation. Drives the lyric-sync offset while a key is engaged; 0 at key 0.
  let pitchLatencySeconds = 0

  async function initContext() {
    if (audioCtx) return
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const createdContext = audioCtx
    // Analyser taps for the audio-reactive backdrop. Modest FFT + light
    // built-in smoothing; audioReactive.js does its own attack/release shaping
    // on top and needs transients preserved for beat detection. Analysers are
    // pure sinks (they never connect onward), so tapping them costs no audio.
    for (const k of Object.keys(analysers)) {
      const a = audioCtx.createAnalyser()
      a.fftSize = 1024
      a.smoothingTimeConstant = 0.5
      analysers[k] = a
    }
    registerAnalysers({ ...analysers })
    // Detect key-shift capability once, then lazily load the Signalsmith
    // Stretch factory so it's available before loadStems pre-creates any node.
    // The factory registers its worklet internally on first node construction,
    // so there is no separate addModule() call here. Dynamic import keeps the
    // module (WASM embedded as a base64 data-URI) out of the app bundle.
    keyShiftSupported.value = !!(window.isSecureContext && audioCtx.audioWorklet)
    if (keyShiftSupported.value) {
      try {
        if (!stretchFactory) stretchFactory = await loadStretchFactory()
        workletReady = true
      } catch {
        keyShiftSupported.value = false
        workletReady = false
      }
    }
    if (output.enabled && audioCtx === createdContext) await output.attach(createdContext)
  }

  // stemList: ordered [{ key, url, kind: 'instrumental'|'vocal', volume }].
  // Builds one src->gain->dip->destination chain per stem, taps analysers by
  // kind, pre-creates a disconnected Signalsmith node per stem, and wires the
  // bypass (or a re-applied key). Returns durations + an availability map.
  async function loadStems(stemList) {
    await initContext()
    const list = Array.isArray(stemList) ? stemList : []
    primaryKey = (list.find((s) => s && s.kind === 'instrumental') || list[0] || {}).key ?? null

    const loadPromises = list.map(async (stem) => {
      if (!stem || !stem.url) return
      const { key, url, kind, volume } = stem

      const el = new Audio()
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      el.src = url

      const gain = audioCtx.createGain()
      gain.gain.value = typeof volume === 'number' ? volume : 1

      // A dedicated dip gain sits between the volume gain and the destination.
      // It stays at unity and is only briefly dipped to mask the reconnect
      // click when the key crosses 0 — so the user's volume gain is never
      // overwritten by the reroute.
      const dip = audioCtx.createGain()
      dip.gain.value = 1
      gain.connect(dip)
      dip.connect(audioCtx.destination)

      // Analyser taps (post-dip). Every stem feeds `mix`; the instrumental feeds
      // `inst`; every vocal feeds `vocals` (summed) — generalizes the old two
      // hardcoded taps to N voices without touching audioReactive.js.
      if (analysers.mix) dip.connect(analysers.mix)
      if (kind === 'instrumental' && analysers.inst) dip.connect(analysers.inst)
      if (kind === 'vocal' && analysers.vocals) dip.connect(analysers.vocals)

      const src = audioCtx.createMediaElementSource(el)

      audioElements[key] = el
      gainNodes[key] = gain
      dipNodes[key] = dip
      sources[key] = src

      // Pre-create this stem's Signalsmith node EAGERLY (creation is async) and
      // leave it disconnected, so a later transpose can wire it in synchronously
      // and instantly. A disconnected worklet node isn't pulled by the render
      // graph, so an idle key-0 deck pays ~nothing for it. Must run before
      // wireStem, which needs the node present if a non-zero key is being
      // re-applied after a reload.
      await createPitchNode(key)
      // Wire src -> (pitch path or bypass) -> volume gain. Reading keyOffset
      // here re-applies a non-zero key automatically after a reload.
      wireStem(key)

      await new Promise((resolve, reject) => {
        el.addEventListener('loadedmetadata', resolve, { once: true })
        el.addEventListener('error', reject, { once: true })
        el.load()
      })
    })

    await Promise.allSettled(loadPromises)

    const durations = Object.values(audioElements)
      .filter(Boolean)
      .map((el) => el.duration)
      .filter((d) => d && isFinite(d))

    const available = Object.fromEntries(
      list.filter((s) => s && s.url).map((s) => [s.key, !!audioElements[s.key]]),
    )

    return { durations, available }
  }

  async function play(fromTime) {
    // Nothing loaded yet — bail rather than flip to 'playing' over an empty
    // deck. The Play button is gated on loadState==='ready', but the Space-key
    // path is live from mount, so a keypress during the sub-second load window
    // could otherwise wedge the transport (state 'playing', no audio, and the
    // loadSong-armed loop then advancing an un-play()'d deck).
    if (!Object.values(audioElements).some(Boolean)) return
    if (audioCtx?.state === 'suspended') await audioCtx.resume()

    const t = fromTime ?? currentTime.value
    Object.values(audioElements).forEach(el => {
      if (!el) return
      el.currentTime = t
    })

    const plays = Object.values(audioElements)
      .filter(Boolean)
      .map(el => el.play().catch(() => {}))

    await Promise.allSettled(plays)
    resetClock()
    playerState.value = 'playing'

    // Re-arm the clock loop if a prior natural end let it stop. The end
    // branch in tick() runs stop() and clears the timer, while startAnimationLoop
    // is otherwise only called once, at song load. Without this, pressing Play
    // again after a song reaches its end leaves the transport clock frozen at
    // 0:00 and the stage dark until a hard reload.
    if (clockTimer == null && onTickCb) startAnimationLoop(onTickCb, onEndedCb)
  }

  function pause() {
    Object.values(audioElements).forEach(el => el?.pause())
    resetClock()
    playerState.value = 'paused'
  }

  function stop() {
    Object.values(audioElements).forEach(el => {
      if (!el) return
      el.pause()
      el.currentTime = 0
    })
    resetClock()
    currentTime.value = 0
    playerState.value = 'stopped'
  }

  function seek(time) {
    const clamped = Math.max(0, Math.min(time, duration.value - 0.01))
    const wasPlaying = playerState.value === 'playing'
    if (wasPlaying) pause()

    Object.values(audioElements).forEach(el => {
      if (el) el.currentTime = clamped
    })
    resetClock()
    currentTime.value = clamped

    if (wasPlaying) play(clamped)
  }

  function setVolume(key, value) {
    if (gainNodes[key] && audioCtx) {
      gainNodes[key].gain.setTargetAtTime(value, audioCtx.currentTime, 0.05)
    }
  }

  // Eagerly create one Signalsmith StretchNode for a stem (async: the factory
  // may register its worklet on the first call). Activates passthrough with
  // start() and leaves the node DISCONNECTED — setKey/wireStem splice it in
  // synchronously later. Called once per stem from loadStems. Uses the module's
  // default options (outputChannelCount:[2] — the A/B-validated stereo config);
  // a MediaElementAudioSourceNode's channel count isn't reliably known before
  // audio flows, so we do not try to match mono stems here.
  async function createPitchNode(key) {
    if (!workletReady || !stretchFactory || !audioCtx || pitchNodes[key]) return
    try {
      const node = await stretchFactory(audioCtx)
      await node.start()
      pitchNodes[key] = node
      // All nodes share one config, so a single cached latency drives lyric
      // sync. latency() returns TOTAL seconds already divided by sampleRate.
      try { pitchLatencySeconds = await node.latency() } catch {}
    } catch {
      // Creation should never fail once the factory is loaded, but if it does,
      // disable key shift so callers fall back to the bypass path.
      keyShiftSupported.value = false
      workletReady = false
    }
  }

  // (Re)build a single stem's chain up to its volume gain (the volume gain ->
  // dip -> destination tail is set up once in loadStems and never touched here).
  //   key == 0 (or unsupported):  src -> gain          (bypass)
  //   key != 0:                   src -> pitch -> gain  (no makeup; ~unity)
  function wireStem(key) {
    const src = sources[key]
    const gain = gainNodes[key]
    if (!src || !gain || !audioCtx) return

    try { src.disconnect() } catch {}
    if (pitchNodes[key]) { try { pitchNodes[key].disconnect() } catch {} }

    // If the node couldn't be pre-created, fall back to bypass so the stem
    // stays audible rather than throwing on a null deref.
    if (workletReady && keyOffset.value !== 0 && pitchNodes[key]) {
      pitchNodes[key].schedule({ semitones: keyOffset.value, formantCompensation: false }).catch(() => {})
      src.connect(pitchNodes[key])
      pitchNodes[key].connect(gain)
      return
    }
    src.connect(gain)
  }

  // Transpose every stem by `semitones` (clamped -12..+12), preserving tempo.
  // Returns whether key shifting is supported in this context.
  function setKey(semitones) {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones || 0)))
    const prev = keyOffset.value
    if (clamped === prev) return keyShiftSupported.value
    keyOffset.value = clamped
    if (!workletReady || !audioCtx) return keyShiftSupported.value

    const crossingZero = (prev === 0) !== (clamped === 0)

    for (const key of Object.keys(sources)) {
      const src = sources[key]
      const gain = gainNodes[key]
      const dip = dipNodes[key]
      if (!src || !gain || !dip) continue

      // Non-zero -> non-zero: retune the live node via schedule(), no reroute,
      // no glitch. schedule() is async — fire-and-forget is fine here.
      if (!crossingZero) {
        if (pitchNodes[key]) {
          pitchNodes[key].schedule({ semitones: clamped, formantCompensation: false }).catch(() => {})
        }
        continue
      }

      // Crossing the 0 boundary inserts/removes the pitch path. Dip the
      // dedicated dip gain (NOT the user's volume gain) to mask the reconnect
      // click, swap, then restore to unity. The media elements never pause, so
      // transport position is untouched. A pending dip from a prior rapid
      // crossing is cancelled so overlapping timers can't leave a wrong gain.
      const ctxAtSchedule = audioCtx
      const now = audioCtx.currentTime
      dip.gain.cancelScheduledValues(now)
      dip.gain.setTargetAtTime(0, now, 0.005)
      if (dipTimers[key]) clearTimeout(dipTimers[key])
      dipTimers[key] = setTimeout(() => {
        dipTimers[key] = null
        // Bail if the context was torn down / replaced while dipped.
        if (audioCtx !== ctxAtSchedule || !sources[key] || !dipNodes[key]) return
        wireStem(key)   // re-reads keyOffset.value -> bypass vs pitch path
        const d = dipNodes[key]
        const t = audioCtx.currentTime
        d.gain.cancelScheduledValues(t)
        d.gain.setTargetAtTime(1, t, 0.01)
      }, 20)
    }
    return true
  }

  // ── Smooth playback clock ──────────────────────────────────────────────
  // HTMLMediaElement.currentTime only updates a few times per second, so
  // reading it per frame makes the syllable wipe step visibly (the POC is
  // smooth because it renders off audioCtx.currentTime, which is sample-
  // accurate). Extrapolate between media-time updates on the AudioContext
  // clock: gently slew onto each fresh media reading, hard re-anchor on a
  // large error (seek, stall), and keep the result monotonic so the wipe
  // never ticks backwards mid-line.
  let clockRunning = false
  let anchorMedia = 0
  let anchorCtx = 0
  let lastMediaTime = -1
  let lastSmooth = 0

  function resetClock() {
    clockRunning = false
    lastMediaTime = -1
  }

  function smoothedTime(primary) {
    const m = primary.currentTime
    const now = audioCtx ? audioCtx.currentTime : performance.now() / 1000
    if (!clockRunning) {
      clockRunning = true
      anchorMedia = m
      anchorCtx = now
      lastMediaTime = m
      lastSmooth = m
      return m
    }
    if (m !== lastMediaTime) {
      lastMediaTime = m
      const err = m - (anchorMedia + (now - anchorCtx))
      if (Math.abs(err) > 0.25) {
        // Seek or stall: snap to the media clock (backwards jumps allowed).
        anchorMedia = m
        anchorCtx = now
        lastSmooth = m
        return m
      }
      // Absorb a fraction of the error per media update; the residual per-
      // frame correction (≤ a few ms) hides under the ~16.7ms frame advance.
      anchorMedia += err * 0.1
    }
    lastSmooth = Math.max(anchorMedia + (now - anchorCtx), lastSmooth)
    return lastSmooth
  }

  function startAnimationLoop(onTick, onEnded) {
    // Retained so play() can restart the loop after a natural end.
    onTickCb = onTick
    onEndedCb = onEnded
    stopAnimation()
    let timer = null
    const tick = () => {
      const primary = audioElements[primaryKey] || Object.values(audioElements).find(Boolean)
      if (primary && playerState.value === 'playing') {
        const primaryTime = primary.currentTime
        currentTime.value = smoothedTime(primary)
        // The Signalsmith node delays audible output by its reported total
        // latency when a key is engaged; advance the lyrics clock to match what
        // the singer hears. pitchLatencySeconds is cached once at node creation
        // (node.latency(), in seconds). At key 0 the path is untouched
        // (lyricLatency === 0).
        const lyricLatency = (workletReady && keyOffset.value !== 0)
          ? pitchLatencySeconds
          : 0
        // Same contract as onEnded below: a throwing time-update listener must
        // not escape tick(), or that publication is lost and the error can
        // obscure the real transport state. The interval itself survives, but
        // catching here also keeps listener failures local to the listener.
        try {
          onTick?.(Math.max(0, currentTime.value - lyricLatency))
        } catch (e) {
          console.error('onTick listener threw:', e)
        }

        // Resync drifted tracks (>100ms)
        for (const el of Object.values(audioElements)) {
          if (el && el !== primary && Math.abs(el.currentTime - primaryTime) > 0.1) {
            el.currentTime = primaryTime
          }
        }

        // Auto-stop at end. onEnded FIRST, then stop(): stop() zeroes
        // currentTime and flips playerState to 'stopped', so a listener that
        // ran after it could neither read where the track ended nor tell a
        // natural end from a manual stop. Running it first also means anything
        // a listener kicks off synchronously (a queue advance, say) is already
        // in flight by the time the 'stopped' transition reaches other
        // surfaces. onEnded is called exactly once per end.
        //
        // The catch is what makes that ordering safe to keep: a listener that
        // throws must not be able to wedge the transport by skipping stop()
        // and leaving the deck reporting 'playing' forever with no clock
        // tick scheduled. Ordering is a contract with the listener; running the
        // transport is not negotiable.
        if (primaryTime >= duration.value - 0.1) {
          try {
            onEnded?.()
          } catch (e) {
            console.error('onEnded listener threw:', e)
          }
          stop()
          // Tear the timer down: a stopped deck should not keep polling. Null
          // clockTimer (stop() does not) so play() can tell the loop is dead
          // and restart it.
          clearInterval(timer)
          if (clockTimer === timer) clockTimer = null
          return
        }
      }
    }
    timer = setInterval(tick, CLOCK_INTERVAL_MS)
    clockTimer = timer
  }

  function stopAnimation() {
    if (clockTimer != null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }

  function cleanup() {
    output.detach()
    stopAnimation()
    // Drop the retained loop callbacks with the loop: they belong to the song
    // being torn down, and play()'s re-arm guard keys on onTickCb being set.
    onTickCb = null
    onEndedCb = null
    Object.keys(audioElements).forEach(key => {
      const el = audioElements[key]
      if (el) {
        el.pause()
        el.src = ''
        audioElements[key] = null
      }
      if (sources[key]) {
        try { sources[key].disconnect() } catch {}
        sources[key] = null
      }
      if (gainNodes[key]) {
        try { gainNodes[key].disconnect() } catch {}
        gainNodes[key] = null
      }
      if (pitchNodes[key]) {
        try { pitchNodes[key].disconnect() } catch {}
        pitchNodes[key] = null
      }
      if (dipNodes[key]) {
        try { dipNodes[key].disconnect() } catch {}
        dipNodes[key] = null
      }
      if (dipTimers[key]) {
        clearTimeout(dipTimers[key])
        dipTimers[key] = null
      }
    })
    clearAnalysers()
    for (const k of Object.keys(analysers)) {
      if (analysers[k]) { try { analysers[k].disconnect() } catch {} }
      analysers[k] = null
    }
    for (const reg of [audioElements, gainNodes, sources, pitchNodes, dipNodes, dipTimers]) {
      for (const k of Object.keys(reg)) delete reg[k]
    }
    primaryKey = null
    if (audioCtx) {
      audioCtx.close().catch(() => {})
      audioCtx = null
    }
    workletReady = false
    pitchLatencySeconds = 0           // re-cached when nodes are re-created
    keyShiftSupported.value = false   // re-detected on the next initContext
    keyOffset.value = 0               // each new song starts at key 0
    playerState.value = 'stopped'
  }

  return {
    currentTime, duration, playerState, output,
    audioElements, gainNodes,
    keyOffset, keyShiftSupported,
    initContext, loadStems, play, pause, stop, seek,
    setVolume, setKey, startAnimationLoop, stopAnimation, cleanup,
  }
}
