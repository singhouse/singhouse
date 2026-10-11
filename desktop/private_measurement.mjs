// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, resolve } from 'node:path'
import { parseLaunch } from './policy.mjs'

const flag = '--private-test-resource-measurement'
const fullId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const modelsRequired = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']
const capabilitiesRequired = ['transcription', 'separation']

// An explicit existing profile preserves the absolute paths embedded in uv
// environments and prevents this test lane from choosing the ordinary profile.
export function privateMeasurementLaunch(argv, packaged) {
  const occurrences = argv.filter(value => value === flag).length
  if (!occurrences) return { enabled: false, profile: null }
  if (occurrences !== 1 || !packaged || argv.includes('--demo') || argv.includes('--recovery-anchor')) {
    throw new Error('Private resource measurement requires a packaged application and excludes demo or recovery mode')
  }
  const profiles = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--user-data-dir=')) profiles.push(argv[index].slice('--user-data-dir='.length))
    else if (argv[index] === '--user-data-dir') profiles.push(argv[++index])
  }
  if (profiles.length !== 1 || typeof profiles[0] !== 'string' || !isAbsolute(profiles[0])) {
    throw new Error('Private resource measurement requires one explicit absolute --user-data-dir test profile')
  }
  return { enabled: true, profile: resolve(profiles[0]) }
}

export function assertPrivateMeasurementRelease(enabled, packaged, policy) {
  if (enabled && (!packaged || policy?.channel !== 'private-test')) {
    throw new Error('Private resource measurement is available only in a packaged private-test release')
  }
}

export function assertPrivateMeasurementRuntime(enabled, processing, models, probe) {
  if (!enabled) return
  if (processing?.manifest?.schema !== 2 || !fullId(processing.id) || !fullId(models?.id)
      || !capabilitiesRequired.every(capability => processing.manifest.capabilities?.includes(capability))
      || !modelsRequired.every(model => processing.manifest.models?.includes(model) && models.manifest?.models?.includes(model))
      || probe?.runtimeManifestId !== processing.id || probe.probePassed !== true || probe.capabilitiesReady !== true
      || probe.probeSchema !== 2 || !capabilitiesRequired.every(capability => probe.verifiedCapabilities?.includes(capability))
      || !['deviceTensor', 'nativeAudio', ...capabilitiesRequired].every(check => probe.checks?.[check] === true)) {
    throw new Error('Private resource measurement requires an already verified uv runtime, complete model cache and successful functional probe')
  }
}

export function assertPrivateMeasurementMarker(value, enabled) {
  if (!enabled) return
  const marker = value?.resourceMeasurement
  if (!marker || Array.isArray(marker)
      || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(['mode', 'qualified', 'recommendationsEnabled'])
      || marker.mode !== 'private-test' || marker.qualified !== false || marker.recommendationsEnabled !== false) {
    throw Object.assign(new Error('Backend resource measurement marker mismatch'), { code: 'PRIVATE_MEASUREMENT_MARKER' })
  }
}

export function privateMeasurementHandshake(line, expectedIdentity, enabled) {
  const value = parseLaunch(line, expectedIdentity)
  assertPrivateMeasurementMarker(JSON.parse(line), enabled)
  return value
}
