// SPDX-License-Identifier: AGPL-3.0-only
// Spectrogram computation + painting for the line timing lane.
//
// Framework-free like the rest of src/editor/. `computeSpectrogram` is pure
// math (testable in node); `drawSpectrogram` touches the DOM (canvas) and is
// only exercised in the browser.
//
// Design notes:
// - Log-spaced frequency bins from fMin..fMax — vocals live ~80Hz–8kHz and
//   log spacing keeps formants readable instead of squashing them into the
//   bottom rows of a linear axis.
// - Hop size adapts to the requested window so the frame count stays bounded
//   (~one column per output pixel is plenty); a whole-song spectrogram is
//   never computed, only the selected line's window.

/** In-place radix-2 FFT. `re`/`im` are Float32Arrays, length a power of 2. */
export function fftInPlace(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vR = re[b] * curR - im[b] * curI
        const vI = re[b] * curI + im[b] * curR
        re[b] = re[a] - vR
        im[b] = im[a] - vI
        re[a] += vR
        im[a] += vI
        const nR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nR
      }
    }
  }
}

const hannCache = new Map()
function hannWindow(n) {
  let w = hannCache.get(n)
  if (!w) {
    w = new Float32Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    hannCache.set(n, w)
  }
  return w
}

/**
 * STFT magnitude spectrogram of `samples` over [t0, t1] seconds.
 * Returns {data, frames, bins, t0, t1} where data is a Float32Array of
 * frames×bins values normalized to 0..1 (column-major by frame:
 * data[frame * bins + bin], bin 0 = lowest frequency).
 */
export function computeSpectrogram(samples, sampleRate, opts = {}) {
  const {
    t0 = 0,
    t1 = samples.length / sampleRate,
    fftSize = 1024,
    bins = 96,
    fMin = 55,
    fMax = Math.min(8000, sampleRate / 2),
    maxFrames = 1600,
    dynamicRangeDb = 70,
  } = opts

  const span = Math.max(t1 - t0, 1e-3)
  const hop = Math.max(128, Math.ceil((span * sampleRate) / maxFrames))
  const frames = Math.max(1, Math.round((span * sampleRate) / hop))
  const half = fftSize / 2

  // Map each output bin to a [lo, hi) range of FFT bins on a log axis.
  const binRanges = []
  const hzPerFft = sampleRate / fftSize
  for (let b = 0; b < bins; b++) {
    const fLo = fMin * Math.pow(fMax / fMin, b / bins)
    const fHi = fMin * Math.pow(fMax / fMin, (b + 1) / bins)
    let lo = Math.floor(fLo / hzPerFft)
    let hi = Math.ceil(fHi / hzPerFft)
    lo = Math.min(Math.max(lo, 0), half - 1)
    hi = Math.min(Math.max(hi, lo + 1), half)
    binRanges.push([lo, hi])
  }

  const data = new Float32Array(frames * bins)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const win = hannWindow(fftSize)
  const startSample = Math.round(t0 * sampleRate)
  let maxDb = -Infinity

  for (let f = 0; f < frames; f++) {
    const base = startSample + f * hop - fftSize / 2
    for (let i = 0; i < fftSize; i++) {
      const s = base + i
      re[i] = (s >= 0 && s < samples.length ? samples[s] : 0) * win[i]
      im[i] = 0
    }
    fftInPlace(re, im)
    for (let b = 0; b < bins; b++) {
      const [lo, hi] = binRanges[b]
      let acc = 0
      for (let k = lo; k < hi; k++) acc += Math.hypot(re[k], im[k])
      const mag = acc / (hi - lo)
      const db = 20 * Math.log10(mag + 1e-9)
      data[f * bins + b] = db
      if (db > maxDb) maxDb = db
    }
  }

  // Normalize against the window's own peak with a fixed dynamic range floor.
  const floor = (Number.isFinite(maxDb) ? maxDb : 0) - dynamicRangeDb
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min(1, Math.max(0, (data[i] - floor) / dynamicRangeDb))
  }

  return { data, frames, bins, t0, t1 }
}

// black-navy → violet (accent) → cyan (primary) → white, matching the app palette.
const STOPS = [
  [0.0, [8, 8, 26]],
  [0.35, [46, 22, 94]],
  [0.65, [124, 58, 237]],
  [0.85, [67, 133, 228]],
  [1.0, [235, 253, 255]],
]

export function colormap(v) {
  const x = Math.min(1, Math.max(0, v))
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [x0, c0] = STOPS[i - 1]
      const [x1, c1] = STOPS[i]
      const t = (x - x0) / (x1 - x0)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

/** Paint a computed spectrogram onto `canvas`, stretched to its full size.
 * Bin 0 (lowest frequency) renders at the bottom. */
export function drawSpectrogram(canvas, spec) {
  const { data, frames, bins } = spec
  const ctx = canvas.getContext('2d')
  if (!ctx || !canvas.width || !canvas.height) return

  const off = document.createElement('canvas')
  off.width = frames
  off.height = bins
  const offCtx = off.getContext('2d')
  const img = offCtx.createImageData(frames, bins)
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < bins; b++) {
      const [r, g, bl] = colormap(data[f * bins + b])
      const p = ((bins - 1 - b) * frames + f) * 4
      img.data[p] = r
      img.data[p + 1] = g
      img.data[p + 2] = bl
      img.data[p + 3] = 255
    }
  }
  offCtx.putImageData(img, 0, 0)

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(off, 0, 0, frames, bins, 0, 0, canvas.width, canvas.height)
}
