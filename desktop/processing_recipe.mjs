// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
export const recipeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value
const hash = value => /^[a-f0-9]{64}$/.test(value || '')
const token = value => typeof value === 'string' && /^[A-Za-z0-9._+-]{1,128}$/.test(value)
export const recipePath = value => typeof value === 'string' && value.length < 512 && value.split('/').every(part => token(part) && !['.', '..'].includes(part) && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort())
function artifact(value, names, { local = false } = {}) {
  if (!keys(value, names) || !hash(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1) throw new Error('Invalid processing recipe artifact')
  let url
  try { url = new URL(value.url) } catch { throw new Error('Invalid processing recipe source') }
  if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || (local && url.protocol === 'file:' && !url.hostname))) throw new Error('Processing recipe sources require credential-free HTTPS')
}
export function recipeTransfers(manifest) {
  return [manifest.recipe.python, ...manifest.recipe.wheels, ...manifest.recipe.wheels.flatMap(wheel => wheel.notices)]
}
export function recipeTransferBytes(manifest) { return recipeTransfers(manifest).reduce((sum, artifact) => sum + artifact.size, 0) }
export function validateProcessingRecipe(value, expected, trustedLocks = [], { local = false, nativeLockSha256 } = {}) {
  const top = ['schema','kind','appVersion','backendVersion','lyricsyncVersion','pythonVersion','platform','arch','accelerator','python','capabilities','models','modelCapabilities','probe','recipe','provenance']
  if (value?.excludedPackages !== undefined) top.push('excludedPackages')
  if (!keys(value, top) || value.schema !== 2 || value.kind !== 'processing' || !['cpu','cuda','metal'].includes(value.accelerator)
      || ['appVersion','backendVersion','lyricsyncVersion','pythonVersion','platform','arch'].some(key => !token(value[key]))
      || ['appVersion','backendVersion','lyricsyncVersion','platform','arch'].some(key => value[key] !== expected[key])
      || value.python !== (value.platform === 'win32' ? 'env/Scripts/python.exe' : 'env/bin/python')
      || (value.accelerator === 'metal' && value.platform !== 'darwin') || (value.accelerator === 'cuda' && value.platform === 'darwin')) throw new Error('Processing recipe is incompatible with this application')
  const p = value.provenance
  if (!p || !hash(p.lockSha256) || typeof p.inputLock !== 'string' || createHash('sha256').update(p.inputLock).digest('hex') !== p.lockSha256
      || !/^[a-f0-9]{40}$/.test(p.sourceCommit || '') || !Array.isArray(p.packages) || !p.packages.length
      || !(trustedLocks instanceof Set ? trustedLocks.has(p.lockSha256) : trustedLocks.includes(p.lockSha256))) throw new Error('Processing recipe input lock is not trusted by this application release')
  const { provenance, ...body } = value
  const lock = { ...body, schema: 2, kind: 'processing-input', sourceCommit: p.sourceCommit, packages: p.packages }
  let input
  try { input = JSON.parse(p.inputLock) } catch { throw new Error('Invalid processing recipe input lock') }
  if (recipeDigest(canonical(input)) !== recipeDigest(canonical(lock))) throw new Error('Processing recipe differs from its input lock')
  const required = { transcription: ['faster_whisper','lyricsync.transcription.heart','karaoke_backend.workers.heart_transcriptor'], separation: ['demucs.separate','audio_separator.separator'] }
  if (!Array.isArray(value.capabilities) || !value.capabilities.length || new Set(value.capabilities).size !== value.capabilities.length || value.capabilities.some(cap => !required[cap])
      || !Array.isArray(value.models) || value.models.some(model => !token(model)) || new Set(value.models).size !== value.models.length
      || !keys(value.modelCapabilities, value.models) || Object.values(value.modelCapabilities).some(cap => !value.capabilities.includes(cap))
      || !keys(value.probe, ['schema','type','modules']) || value.probe.schema !== 2 || value.probe.type !== 'python-functional-v1'
      || JSON.stringify(value.probe.modules) !== JSON.stringify([...new Set(value.capabilities.flatMap(cap => required[cap]))].sort())) throw new Error('Processing recipe capability probe is incomplete')
  const r = value.recipe
  if (!keys(r, ['schema','python','uv','nativeTools','wheels','installedSize','files']) || r.schema !== 1 || !Number.isSafeInteger(r.installedSize) || r.installedSize <= 0
      || !keys(r.uv, ['version','sha256']) || !token(r.uv.version) || !hash(r.uv.sha256) || !Array.isArray(r.wheels) || !r.wheels.length) throw new Error('Invalid processing installation recipe')
  if (!keys(r.nativeTools,['nativeLockSha256','ffmpegRelease']) || !hash(r.nativeTools.nativeLockSha256) || !token(r.nativeTools.ffmpegRelease)
      || (nativeLockSha256 !== undefined && r.nativeTools.nativeLockSha256 !== nativeLockSha256)) throw new Error('Processing native tools do not match this application release')
  artifact(r.python, ['version','url','size','sha256','archive','member'], { local })
  if (r.python.version !== value.pythonVersion || !['tar.gz','zip'].includes(r.python.archive) || (!recipePath(r.python.member) || !r.python.member.startsWith('python/'))) throw new Error('Invalid managed Python artifact')
  const names = new Set(), filenames = new Set()
  for (const wheel of r.wheels) {
    artifact(wheel, ['name','version','filename','url','size','sha256','sourceUrl','sourceSha256','license','notices'], { local })
    const name = wheel.name?.toLowerCase().replace(/[-_.]+/g, '-')
    if ((!token(wheel.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(wheel.name)) || !token(wheel.version) || !token(wheel.filename) || !wheel.filename.endsWith('.whl') || names.has(name) || filenames.has(wheel.filename.toLowerCase())
        || !hash(wheel.sourceSha256) || typeof wheel.license !== 'string' || !wheel.license.trim() || !Array.isArray(wheel.notices) || !wheel.notices.length) throw new Error('Invalid locked wheel provenance')
    let source
    try { source = new URL(wheel.sourceUrl) } catch { throw new Error('Invalid wheel provenance source') }
    if (source.protocol !== 'https:' || source.username || source.password || source.hash || source.search) throw new Error('Invalid wheel provenance source')
    names.add(name); filenames.add(wheel.filename.toLowerCase())
    const notices = new Set()
    for (const notice of wheel.notices) {
      artifact(notice, ['filename','url','size','sha256'], { local })
      if ((!token(notice.filename) || !recipePath(notice.filename)) || notices.has(notice.filename.toLowerCase())) throw new Error('Invalid wheel notice path')
      notices.add(notice.filename.toLowerCase())
    }
  }
  const paths = new Set()
  if (!Array.isArray(r.files) || !r.files.length) throw new Error('Missing trusted installed inventory')
  for (const file of r.files) {
    const key = value.platform === 'linux' ? file.path : file.path?.toLowerCase()
    if (!recipePath(file.path) || ['manifest.json','receipt.json'].includes(file.path) || paths.has(key)) throw new Error('Invalid installed inventory path')
    paths.add(key)
    if (file.target !== undefined) {
      if (!keys(file, ['path','target']) || typeof file.target !== 'string' || !file.target || file.target.includes('\0') || file.target.includes('\\') || file.target.startsWith('/')) throw new Error('Invalid installed inventory link')
    } else if (!keys(file, file.kind === undefined ? ['path','size','sha256','executable'] : ['path','size','sha256','executable','kind'])
        || !hash(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.executable !== 'boolean'
        || (file.kind !== undefined && (file.kind !== 'uv-path-text' || file.path !== 'env/pyvenv.cfg'))) throw new Error('Invalid installed inventory file')
  }
  if (!r.files.some(file => file.path === value.python)) throw new Error('Recipe lacks managed environment interpreter')
  if (!Number.isSafeInteger(recipeTransferBytes(value) + r.installedSize)) throw new Error('Processing recipe is too large')
  return value
}
