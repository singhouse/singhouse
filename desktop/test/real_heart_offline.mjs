// SPDX-License-Identifier: AGPL-3.0-only
// Explicit acceptance runner. Supply local artifacts; never retrieves weights.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { RuntimeManager, ModelCache, processingAttestation } from '../runtime_manager.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [mode, stateArg, manifestArg, nativeArg, sourceArg] = process.argv.slice(2)
if (!['install', 'restart'].includes(mode) || !stateArg || !manifestArg || !nativeArg || (mode === 'install' && !sourceArg)) {
  throw new Error('Usage: real_heart_offline.mjs install|restart STATE MANIFEST NATIVE [LOCAL_HEART_FOLDER]')
}
const state = resolve(stateArg), native = resolve(nativeArg)
const identity = JSON.parse(await readFile(join(native, 'manifest.json'), 'utf8'))
const nativeBootstrap = await readFile(join(native, 'backend.py'))
const nativeBootstrapSha256 = createHash('sha256').update(nativeBootstrap).digest('hex')
const nativePolicy = await readFile(join(native, 'models.json'))
const nativeTrust = await readFile(join(native, 'processing-locks.json'))
assert.deepEqual(nativePolicy, await readFile(join(desktop, 'models.json')), 'Assembled model policy must match the intended application policy')
assert.deepEqual(nativeTrust, await readFile(join(desktop, 'processing-locks.json')), 'Assembled runtime trust must match the intended application policy')
const policy = JSON.parse(nativePolicy.toString('utf8'))
const trust = JSON.parse(nativeTrust.toString('utf8'))
const installationEvidence = mode === 'restart' ? JSON.parse(await readFile(join(state, 'install-evidence.json'), 'utf8')) : null
const manifest = JSON.parse(await readFile(resolve(manifestArg), 'utf8'))
assert.ok(trust.lockSha256.includes(manifest.provenance.lockSha256), 'Pack must be trusted by the actual application policy')
const python = join(native, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
const options = { lockPython: python, durabilityHelper: join(native, 'backend.py'),
  fetchImpl: async () => { throw new Error('Offline acceptance must not use the network') } }
await mkdir(state, { recursive: true })
const manager = new RuntimeManager(join(state, 'processing'), identity, { ...options, nativeBin: join(native, 'ffmpeg/bin'), trustedLocks: trust.lockSha256 })
const cache = new ModelCache(join(state, 'model-cache'), policy, options)
const heart = policy.models.find(model => model.id === 'heart-transcriptor')
if (mode === 'install') {
  assert.equal(await manager.active(), null, 'Choose a new acceptance state directory')
  await manager.install(manifest, { probeTimeout: 120000 })
  await cache.installFromDirectory({ schema: 1, kind: 'models', models: [heart.id], files: heart.files }, resolve(sourceArg), { prefix: heart.directory })
}
const active = await manager.active(), models = await cache.active()
assert.ok(active && models)
const requestedId = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
assert.equal(active.id, requestedId, 'Active runtime must match the requested acceptance artifact')
assert.equal(active.manifest.provenance.lockSha256, manifest.provenance.lockSha256)
if (installationEvidence) {
  assert.equal(installationEvidence.mode, 'install', 'Restart requires installation evidence')
  assert.ok(installationEvidence.nativeIdentity && /^[a-f0-9]{64}$/.test(installationEvidence.nativeBootstrapSha256),
    'Installation evidence must identify the assembled native bootstrap')
  assert.equal(active.id, installationEvidence.runtimeId, 'Replacement must retain the installed processing runtime')
  assert.equal(models.id, installationEvidence.modelManifestId, 'Replacement must retain the installed model cache')
}
const probe = await manager.probe(active, { timeout: 120000 })
assert.equal(probe.capabilitiesReady, true)
assert.ok(probe.verifiedCapabilities.includes('transcription'))
const attestation = processingAttestation(active, probe)

// The native bootstrap independently validates the same trust and cache before
// starting the real worker. An empty VAD selection loads the real checkpoint and
// processor without repeating an operator's already completed regeneration.
const bootstrap = `import importlib.util,json,os,pathlib,subprocess,sys,wave
native,state,identity,processing,models,probe=sys.argv[1:]
native=pathlib.Path(native)
spec=importlib.util.spec_from_file_location('desktop_bootstrap',native/'backend.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
identity=json.loads(identity)
assert module.validate_native(native)==identity, 'Assembled native identity failed validation'
state=pathlib.Path(state)
env=module.processing_environment(state/'backend',identity,pathlib.Path(processing),pathlib.Path(models),json.loads(probe))
assert env['KARAOKE_PROCESSING_PYTHON']
checkpoint=pathlib.Path(env['KARAOKE_HEART_CKPT'])
assert checkpoint.is_dir()
scratch=state/'acceptance';scratch.mkdir(exist_ok=True)
audio=scratch/'empty.wav'
with wave.open(str(audio),'wb') as stream:
 stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(16000);stream.writeframes(b'\\0\\0'*160)
vad=scratch/'empty-vad.json';vad.write_text('[]')
child_env={k:v for k,v in os.environ.items() if k in {'PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'}}
child_env.update(env)
child_env.update(PYTHONDONTWRITEBYTECODE='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',TOKENIZERS_PARALLELISM='false')
command=[env['KARAOKE_PROCESSING_PYTHON'],'-I','-B','-m','karaoke_backend.workers.heart_transcriptor',str(audio),'--vad-segments',str(vad),'--device',{'metal':'mps'}.get(env['KARAOKE_PROCESSING_ACCELERATOR'],env['KARAOKE_PROCESSING_ACCELERATOR'])]
result=subprocess.run(command,cwd=scratch,env=child_env,text=True,capture_output=True,timeout=300)
if result.returncode: raise RuntimeError(result.stderr[-4000:])
value=json.loads(result.stdout)
assert value['transcriber']=='heart' and value['segments']==[]
print(json.dumps({'checkpointLoaded':True,'worker':'heart','regenerationRepeated':False,'modelRevision':json.loads(env['KARAOKE_HEART_MODEL_STATUS_JSON'])['revision']}))
`
const result = await new Promise((resolveRun, reject) => {
  const child = spawn(python, ['-I', '-B', '-c', bootstrap, native, state, JSON.stringify(identity), active.directory, models.directory, JSON.stringify(attestation)],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-8192) })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolveRun(JSON.parse(output)) : reject(new Error(error)))
})
// Loading must not alter either immutable pack.
assert.equal((await manager.active()).id, active.id)
assert.equal((await cache.active()).id, models.id)
const report = { mode, runtimeId: active.id, inputLockSha256: active.manifest.provenance.lockSha256,
  modelManifestId: models.id, nativeRuntimeId: identity.runtimeId, nativeIdentity: identity,
  nativeBootstrapSha256,
  ...(installationEvidence ? { installedNativeIdentity: installationEvidence.nativeIdentity,
    installedNativeBootstrapSha256: installationEvidence.nativeBootstrapSha256,
    nativeIdentityChanged: !isDeepStrictEqual(installationEvidence.nativeIdentity, identity) } : {}),
  probe, ...result }
await writeFile(join(state, `${mode}-evidence.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
