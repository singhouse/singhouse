// SPDX-License-Identifier: AGPL-3.0-only
// Pure-math coverage for the lane's spectrogram: FFT correctness on known
// signals, log-bin mapping, normalization bounds, degenerate-input safety.
// drawSpectrogram (canvas) is browser-only and not tested here.

import { describe, expect, it } from 'vitest'

import { colormap, computeSpectrogram, fftInPlace } from '../../src/editor/spectrogram.js'

const SR = 44100

function sine(freq, seconds, sr = SR) {
  const out = new Float32Array(Math.round(seconds * sr))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr)
  return out
}

describe('fftInPlace', () => {
  it('puts a pure tone into the right bin', () => {
    const n = 1024
    const binIdx = 64 // exact bin frequency → no leakage
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * binIdx * i) / n)
    fftInPlace(re, im)
    const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]))
    const peak = mags.indexOf(Math.max(...mags))
    expect(peak).toBe(binIdx)
    // energy concentrated: peak dwarfs everything else
    const rest = mags.filter((_, k) => k !== binIdx)
    expect(Math.max(...rest)).toBeLessThan(mags[binIdx] / 100)
  })

  it('DC signal lands in bin 0', () => {
    const re = new Float32Array(256).fill(1)
    const im = new Float32Array(256)
    fftInPlace(re, im)
    expect(re[0]).toBeCloseTo(256, 3)
    expect(Math.hypot(re[8], im[8])).toBeCloseTo(0, 3)
  })
})

describe('computeSpectrogram', () => {
  it('concentrates a 1kHz tone in the matching log bin across all frames', () => {
    const spec = computeSpectrogram(sine(1000, 2), SR, { t0: 0, t1: 2, bins: 96 })
    expect(spec.frames).toBeGreaterThan(10)

    // expected log-bin: b = bins * log(f/fMin) / log(fMax/fMin), fMin=55 fMax=8000
    const expected = Math.floor((96 * Math.log(1000 / 55)) / Math.log(8000 / 55))
    const midFrame = Math.floor(spec.frames / 2)
    const col = Array.from({ length: spec.bins }, (_, b) => spec.data[midFrame * spec.bins + b])
    const peak = col.indexOf(Math.max(...col))
    expect(Math.abs(peak - expected)).toBeLessThanOrEqual(1)
  })

  it('normalizes to 0..1 with the peak at 1', () => {
    const spec = computeSpectrogram(sine(440, 1), SR, { t0: 0, t1: 1 })
    let min = Infinity
    let max = -Infinity
    for (const v of spec.data) {
      // Math.min/max propagate NaN; the bound assertions also reject infinities.
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1)
    expect(max).toBeCloseTo(1, 5)
  })

  it('survives total silence without NaN', () => {
    const spec = computeSpectrogram(new Float32Array(SR), SR, { t0: 0, t1: 1 })
    expect(spec.data.every(Number.isFinite)).toBe(true)
  })

  it('zero-pads windows outside the sample range', () => {
    // Window extends well past the 0.5s of audio — must not throw or NaN.
    const spec = computeSpectrogram(sine(440, 0.5), SR, { t0: -1, t1: 4 })
    expect(spec.frames).toBeGreaterThan(0)
    expect(spec.data.every(Number.isFinite)).toBe(true)
  })

  it('caps frame count near maxFrames', () => {
    const spec = computeSpectrogram(sine(440, 10), SR, { t0: 0, t1: 10, maxFrames: 500 })
    expect(spec.frames).toBeLessThanOrEqual(510)
  })
})

describe('colormap', () => {
  it('interpolates the palette endpoints and clamps out-of-range input', () => {
    expect(colormap(0)).toEqual([8, 8, 26])
    expect(colormap(1)).toEqual([235, 253, 255])
    expect(colormap(-5)).toEqual(colormap(0))
    expect(colormap(7)).toEqual(colormap(1))
    const mid = colormap(0.85)
    expect(mid).toEqual([67, 133, 228]) // primary accent stop
  })
})
