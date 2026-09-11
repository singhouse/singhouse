#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Golden-frame harness for the clean-room karaoke stage renderer.
//
// Usage:
//   node harness/run-harness.mjs --renderer <path/to/your/entry.mjs>
//   RENDERER_ENTRY=<path> node harness/run-harness.mjs
//
// The renderer entry module must export:
//   describeFrame(model, timeSeconds, viewport) -> FrameDescriptor
//   normalizeWordSync(json) -> StageModel
//
// See README.md for the FrameDescriptor contract and timing conventions.
// Requires Node 18+. No dependencies.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAdapterChecks } from './adapter-checks.mjs'

const TOL = 1e-6
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function fail(msg) {
  console.error(msg)
  process.exit(2)
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// --- locate the renderer entry -------------------------------------------

let entryPath = process.env.RENDERER_ENTRY || null
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--renderer') entryPath = argv[i + 1]
}
if (!entryPath) {
  fail('No renderer given. Use --renderer <path> or set RENDERER_ENTRY.')
}
entryPath = resolve(process.cwd(), entryPath)

const renderer = await import(pathToFileURL(entryPath).href)
if (typeof renderer.describeFrame !== 'function') {
  fail(`Renderer entry ${entryPath} does not export describeFrame(model, time, viewport).`)
}
if (typeof renderer.normalizeWordSync !== 'function') {
  fail(`Renderer entry ${entryPath} does not export normalizeWordSync(json).`)
}

// --- subset comparison -----------------------------------------------------
// Golden values are the required subset: every key present in the golden must
// exist in the actual output and match (numbers within TOL). Extra keys in the
// actual output are allowed. Arrays must match in length and order.
// null in the golden matches null or undefined in the actual output.

function diffValue(expected, actual, path, diffs) {
  if (expected === null) {
    if (actual !== null && actual !== undefined) {
      diffs.push(`${path}: expected null, got ${JSON.stringify(actual)}`)
    }
    return
  }
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > TOL) {
      diffs.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`)
    }
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected array, got ${JSON.stringify(actual)}`)
      return
    }
    if (actual.length !== expected.length) {
      diffs.push(`${path}: expected ${expected.length} entries, got ${actual.length}`)
      return
    }
    expected.forEach((e, i) => diffValue(e, actual[i], `${path}[${i}]`, diffs))
    return
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      diffs.push(`${path}: expected object, got ${JSON.stringify(actual)}`)
      return
    }
    for (const key of Object.keys(expected)) {
      diffValue(expected[key], actual[key], `${path}.${key}`, diffs)
    }
    return
  }
  if (expected !== actual) {
    diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// --- golden-frame checks ---------------------------------------------------

let passed = 0
let failed = 0
const failures = []

const goldenDir = join(ROOT, 'goldens')
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort()

for (const file of goldenFiles) {
  const golden = loadJson(join(goldenDir, file))
  const model = loadJson(join(ROOT, 'fixtures', golden.fixture))
  const viewport = golden.viewport
  let fixtureFailed = false

  for (const sample of golden.samples) {
    let frame
    try {
      frame = renderer.describeFrame(model, sample.time, viewport)
    } catch (err) {
      failures.push(`${file} @ t=${sample.time}: describeFrame threw: ${err && err.stack || err}`)
      fixtureFailed = true
      continue
    }
    const diffs = []
    if (golden.stageTransform) {
      diffValue(golden.stageTransform, frame && frame.stageTransform, 'stageTransform', diffs)
    }
    diffValue(sample.pages, frame && frame.pages, 'pages', diffs)
    diffValue(sample.countdowns, frame && frame.countdowns, 'countdowns', diffs)
    if (diffs.length) {
      failures.push(`${file} @ t=${sample.time}:\n    ${diffs.join('\n    ')}`)
      fixtureFailed = true
    }
  }

  if (fixtureFailed) {
    failed++
    console.log(`FAIL  golden ${file}`)
  } else {
    passed++
    console.log(`ok    golden ${file} (${golden.samples.length} samples)`)
  }
}

// --- word-sync adapter checks ----------------------------------------------

const adapterResults = runAdapterChecks(renderer.normalizeWordSync, join(ROOT, 'fixtures', 'wordsync'), loadJson)
for (const r of adapterResults) {
  if (r.errors.length) {
    failed++
    console.log(`FAIL  adapter ${r.name}`)
    failures.push(`adapter ${r.name}:\n    ${r.errors.join('\n    ')}`)
  } else {
    passed++
    console.log(`ok    adapter ${r.name} (${r.checks} checks)`)
  }
}

// --- report ------------------------------------------------------------------

console.log('')
if (failures.length) {
  console.log('Failures:\n')
  for (const f of failures) console.log(`  ${f}\n`)
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
