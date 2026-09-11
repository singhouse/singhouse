// SPDX-License-Identifier: AGPL-3.0-only
// audioReactive.js — process-wide audio-analysis singleton shared between the
// audio engine (which owns the AudioContext + AnalyserNodes) and the canvas
// stage (which samples once per animation frame).
//
// The engine and the stage live in different component trees, and the stage's
// canvas may be reparented into a Document-Picture-in-Picture window that runs
// its own rAF. A composable return value or a prop chain can't bridge that, so
// a module singleton is the reliable shared handle. AnalyserNodes belong to the
// AudioContext (not the DOM), so reading them from the PiP window's rAF is
// correct. When no song is loaded (analysers cleared), sample() returns a
// zeroed frame and every visualizer simply rests.

// Three taps, all post-volume/post-mute so they reflect what the room hears:
//   mix    — summed output of all stems
//   inst   — instrumental stem only (locks to the beat even if vocals soloed)
//   vocals — lead-vocal stem only
let _analysers = null // { mix, inst, vocals } of AnalyserNode, or null

const SOURCES = ['mix', 'inst', 'vocals']

// Per-source scratch: reused typed arrays + smoothing state, so sampling
// allocates nothing per frame.
const _scratch = { mix: null, inst: null, vocals: null }

export function registerAnalysers(a) {
  _analysers = a
  for (const s of SOURCES) _scratch[s] = null
}

export function clearAnalysers() {
  _analysers = null
  for (const s of SOURCES) _scratch[s] = null
}

export function hasAnalysers() {
  return !!_analysers
}

const ZERO_FRAME = Object.freeze({
  level: 0,
  bands: Object.freeze({ bass: 0, mid: 0, treble: 0 }),
  beat: 0,
  freq: null,
  waveform: null,
})

// Sample one source for the current frame. Returns
//   { level, bands:{bass,mid,treble}, beat, freq, waveform }
// where the scalars are smoothed 0..1 and freq/waveform are the analyser's live
// scratch Uint8Arrays (read them within the frame, don't retain). Unknown or
// unavailable sources fall back to the mix; with no analysers at all it returns
// the frozen zero frame.
export function sample(source = 'mix') {
  if (!_analysers) return ZERO_FRAME
  const key = _analysers[source] ? source : 'mix'
  const an = _analysers[key]
  if (!an) return ZERO_FRAME

  let sc = _scratch[key]
  if (!sc || sc.freq.length !== an.frequencyBinCount) {
    sc = {
      freq: new Uint8Array(an.frequencyBinCount),
      wave: new Uint8Array(an.fftSize),
      level: 0, bass: 0, mid: 0, treble: 0, beat: 0, prevBass: 0,
    }
    _scratch[key] = sc
  }

  an.getByteFrequencyData(sc.freq)
  an.getByteTimeDomainData(sc.wave)

  // Band split. Bins are linear in frequency and musical energy skews low, so
  // bass is a small slice of bins but carries most of the felt pulse. Mean per
  // slice, normalised to 0..1.
  const n = sc.freq.length
  const bassEnd = Math.max(1, Math.floor(n * 0.08))
  const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.40))
  let bassSum = 0, midSum = 0, trebSum = 0
  for (let i = 0; i < bassEnd; i++) bassSum += sc.freq[i]
  for (let i = bassEnd; i < midEnd; i++) midSum += sc.freq[i]
  for (let i = midEnd; i < n; i++) trebSum += sc.freq[i]
  const bass = bassSum / (bassEnd * 255)
  const mid = midSum / ((midEnd - bassEnd) * 255)
  const treble = trebSum / ((n - midEnd) * 255)

  // Overall level from time-domain RMS — perceptually steadier than a bin mean,
  // and already reflects post-gain/mute output.
  let sq = 0
  for (let i = 0; i < sc.wave.length; i++) {
    const v = (sc.wave[i] - 128) / 128
    sq += v * v
  }
  const rms = Math.sqrt(sq / sc.wave.length)
  const level = Math.min(1, rms * 1.8) // headroom scale; RMS rarely nears 1

  // Attack-fast / release-slow smoothing: a hit reads immediately, the glow
  // decays gently.
  const smooth = (prev, next) => (next > prev ? next : prev * 0.86 + next * 0.14)
  sc.level = smooth(sc.level, level)
  sc.bass = smooth(sc.bass, bass)
  sc.mid = smooth(sc.mid, mid)
  sc.treble = smooth(sc.treble, treble)

  // Beat: positive-going bass transient, otherwise decaying each frame.
  const onset = Math.max(0, bass - sc.prevBass) * 3
  sc.prevBass = bass
  sc.beat = Math.max(onset, sc.beat * 0.82)

  return {
    level: sc.level,
    bands: { bass: sc.bass, mid: sc.mid, treble: sc.treble },
    beat: Math.min(1, sc.beat),
    freq: sc.freq,
    waveform: sc.wave,
  }
}
