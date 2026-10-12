// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,rm,symlink,readFile,link,stat,rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UvRuntimeManager,normalizedPythonConfig,finalizeEnvironment } from '../uv_runtime_manager.mjs'
import { validateProcessingRecipe,recipeDigest,recipePath } from '../processing_recipe.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const identity = { appVersion:'1',backendVersion:'1',lyricsyncVersion:'1',platform:'linux',arch:'x64' }
function fixtureManifest() {
  const artifact = { url:'https://example.org/artifact',size:1,sha256:'a'.repeat(64) }
  const manifest = { schema:2,kind:'processing',...identity,pythonVersion:'3.12.14',accelerator:'cpu',python:'env/bin/python',capabilities:['separation'],models:['model'],modelCapabilities:{model:'separation'},probe:{schema:2,type:'python-functional-v1',modules:['audio_separator.separator','demucs.separate']},recipe:{schema:1,nativeTools:{nativeLockSha256:'c'.repeat(64),ffmpegRelease:'7.1.1'},python:{...artifact,version:'3.12.14',archive:'tar.gz',member:'python/bin/python3'},uv:{version:'0.12.8',sha256:'a'.repeat(64)},wheels:[{...artifact,name:'test',version:'1',filename:'test-1-py3-none-any.whl',sourceUrl:'https://example.org/source',sourceSha256:'b'.repeat(64),license:'MIT',notices:[{...artifact,filename:'000.txt'}]}],installedSize:100,files:[]}}
  return manifest
}
function bind(manifest) {
  delete manifest.provenance
  const sourceCommit = 'a'.repeat(40), packages = [{ name:'test' }]
  const lock = { ...manifest,kind:'processing-input',sourceCommit,packages }
  const inputLock = JSON.stringify(lock)
  manifest.provenance = { inputLock,lockSha256:sha(inputLock),sourceCommit,packages }
  return manifest
}
async function instance(t) {
  const root = await mkdtemp(join(tmpdir(),'uv-runtime-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const manifest = fixtureManifest()
  const contents = 'fixture executable'
  const config = 'home = @SINGHOUSE_RUNTIME_ROOT@/python/bin\n'
  manifest.recipe.files = [{path:'python/bin/python3',size:Buffer.byteLength(contents),sha256:sha(contents),executable:false},{path:'env/bin/python',target:'../../python/bin/python3'},{path:'env/pyvenv.cfg',kind:'uv-path-text',size:Buffer.byteLength(config),sha256:sha(config),executable:false}]
  bind(manifest)
  const recipeId = recipeDigest(manifest), nonce = 'b'.repeat(32), id = recipeDigest({recipeId,nonce})
  const directory = join(root,'envs',id.slice(0,16))
  await mkdir(join(directory,'python/bin'),{recursive:true})
  await mkdir(join(directory,'env/bin'),{recursive:true})
  await writeFile(join(directory,'python/bin/python3'),contents,{mode:0o600})
  await symlink('../../python/bin/python3',join(directory,'env/bin/python'))
  await writeFile(join(directory,'env/pyvenv.cfg'),config.replaceAll('@SINGHOUSE_RUNTIME_ROOT@',directory),{mode:0o600})
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest))
  await writeFile(join(directory,'receipt.json'),JSON.stringify({schema:1,kind:'processing-installation',recipeId,id,nonce,directory}))
  const manager = new UvRuntimeManager(root,identity,{trustedLocks:[manifest.provenance.lockSha256],nativeLockSha256:'c'.repeat(64)})
  return {root,directory,manifest,recipeId,id,manager}
}
test('trusted recipe inventory verifies stable paths and contained interpreter symlinks',async t => {
  const f = await instance(t)
  const active = await f.manager.verify(f.id)
  assert.equal(active.recipeId,f.recipeId)
  assert.equal(active.installedFiles[0].sha256,sha('fixture executable'))
})
test('schema2 launch reuses the bound probe and structural verification; full damage revokes it',async t => {
  const f = await instance(t)
  let probes = 0, full = 0
  const configure = manager => {
    manager.durableReplace = rename
    manager.directorySync = async () => {}
    const verifyFiles = manager.verifyFiles.bind(manager)
    manager.verifyFiles = async (...args) => { if (!args[2]?.quick) full++; return verifyFiles(...args) }
    manager.runProbe = async active => {
      probes++
      return { source:await readFile(new URL('../processing_probe.py',import.meta.url),'utf8'), raw:{schema:2,
        pythonVersion:'3.12.14',backendVersion:'1',lyricsyncVersion:'1',accelerator:'cpu',hardwareAvailable:true,
        capabilities:['separation'],components:{'audio_separator.separator':'1','demucs.separate':'1'},
        checks:{deviceTensor:true,nativeAudio:true,separation:true}} }
    }
    return manager
  }
  const manager = configure(f.manager)
  const first = await manager.launchVerify(f.id)
  await manager.launchProbe(first)
  assert.equal(full,1)
  assert.equal(probes,1)
  const restarted = configure(new UvRuntimeManager(f.root,identity,{trustedLocks:[f.manifest.provenance.lockSha256],nativeLockSha256:'c'.repeat(64)}))
  await restarted.launchProbe(await restarted.launchVerify(f.id))
  assert.equal(full,1,'second launch must not hash the payload')
  assert.equal(probes,1,'second launch must use the recorded functional result')
  await writeFile(join(f.directory,'python/bin/python3'),'x'.repeat('fixture executable'.length))
  await restarted.launchVerify(f.id) // Structural launch intentionally cannot detect same-size edits.
  await assert.rejects(restarted.recheck(f.id),/file changed/)
  assert.equal(await restarted.recordedProbe(first),null)
  await assert.rejects(restarted.launchVerify(f.id),/file changed/)
  await writeFile(join(f.directory,'python/bin/python3'),'fixture executable')
  const repaired = await restarted.verify(f.id)
  await restarted.forgetVerified(f.id)
  await restarted.probe(repaired)
  assert.equal(await restarted.recordedProbe(repaired),null,'a late probe must not undo a newer withdrawal')
})
function countLaunchChecks(manager) {
  const counts = { full:0, structural:0 }
  manager.durableReplace = rename
  manager.directorySync = async () => {}
  const verifyFiles = manager.verifyFiles.bind(manager)
  manager.verifyFiles = async (...args) => {
    counts[args[2]?.quick ? 'structural' : 'full']++
    return verifyFiles(...args)
  }
  return counts
}
test('cold launch lease repeats structure but consumes the earlier full verification once',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  f.manager.lockPython = process.platform === 'win32' ? 'python.exe' : 'python3'
  await f.manager.launchVerify(f.id)
  const lease = await f.manager.acquireUsage(f.id,{launch:true})
  try { assert.deepEqual(counts,{full:1,structural:2}) }
  finally { await lease.release() }
  assert.equal(await f.manager.recordedProbe(await f.manager.verify(f.id,{quick:true})),null,
    'lease proof must not fabricate a functional result')
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,2,'the lease proof is single-use')
})
test('launch lease proof is private to a manager and bound to native identity',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  await f.manager.launchVerify(f.id)
  const other = new UvRuntimeManager(f.root,identity,{trustedLocks:[f.manifest.provenance.lockSha256],nativeLockSha256:'c'.repeat(64)})
  const otherCounts = countLaunchChecks(other)
  await other.launchVerify(f.id,{reuseFull:true})
  assert.equal(otherCounts.full,1,'another manager must establish its own proof')
  f.manager.nativeRuntimeId = 'd'.repeat(64)
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,2,'a different native runtime cannot reuse the proof')
})
test('another manager revocation invalidates a pending lease proof',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  await f.manager.launchVerify(f.id)
  const other = new UvRuntimeManager(f.root,identity,{trustedLocks:[f.manifest.provenance.lockSha256],nativeLockSha256:'c'.repeat(64)})
  countLaunchChecks(other)
  await other.forgetVerified(f.id)
  await writeFile(join(f.directory,'python/bin/python3'),'x'.repeat('fixture executable'.length))
  await assert.rejects(f.manager.launchVerify(f.id,{reuseFull:true}),/file changed/)
  assert.equal(counts.full,2,'same-size damage must be hashed after revocation')
})
test('revocation during a full launch check cannot create a reusable lease proof',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  const verifyTree = f.manager.verifyTree.bind(f.manager)
  let revoke = true
  f.manager.verifyTree = async (...args) => {
    const result = await verifyTree(...args)
    if (!args[1] && revoke) { revoke = false; await f.manager.forgetVerified(f.id) }
    return result
  }
  await f.manager.launchVerify(f.id)
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,2)
})
test('cancellation after hashing cannot publish a lease verification proof',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  const controller = new AbortController()
  const markVerifiedAt = f.manager.markVerifiedAt.bind(f.manager)
  f.manager.markVerifiedAt = async (...args) => { await markVerifiedAt(...args); controller.abort() }
  await assert.rejects(f.manager.launchVerify(f.id,{signal:controller.signal}),{name:'AbortError'})
  f.manager.markVerifiedAt = markVerifiedAt
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,2)
})
test('cancelled and structurally failed lease checks discard their one-use proof',async t => {
  const f = await instance(t), counts = countLaunchChecks(f.manager)
  await f.manager.launchVerify(f.id)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.manager.launchVerify(f.id,{reuseFull:true,signal:controller.signal}),{name:'AbortError'})
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,2)
  await writeFile(join(f.directory,'unexpected'),'extra')
  await assert.rejects(f.manager.launchVerify(f.id,{reuseFull:true}),/inventory/)
  await rm(join(f.directory,'unexpected'))
  await f.manager.launchVerify(f.id,{reuseFull:true})
  assert.equal(counts.full,3)
})
test('rewriting local receipt cannot authorize changed executable bytes',async t => {
  const f = await instance(t)
  await writeFile(join(f.directory,'python/bin/python3'),'compromised')
  const receipt = JSON.parse(await readFile(join(f.directory,'receipt.json')))
  receipt.files = [{path:'python/bin/python3',sha256:sha('compromised')}]
  await writeFile(join(f.directory,'receipt.json'),JSON.stringify(receipt))
  await assert.rejects(f.manager.verify(f.id),/file changed/)
})
test('recipe inventory, source URLs and wheel hashes remain release allowlist bound',async t => {
  const f = await instance(t)
  const changed = structuredClone(f.manifest)
  changed.recipe.wheels[0].url = 'https://attacker.invalid/wheel'
  assert.throws(() => f.manager.validate(changed),/differs/)
  bind(changed)
  assert.throws(() => f.manager.validate(changed),/not trusted/)
})
test('a moved environment or additional executable is never silently adopted',async t => {
  const f = await instance(t)
  const receipt = JSON.parse(await readFile(join(f.directory,'receipt.json')))
  receipt.directory += '-moved'
  await writeFile(join(f.directory,'receipt.json'),JSON.stringify(receipt))
  await assert.rejects(f.manager.verify(f.id),/receipt changed/)
  receipt.directory = f.directory
  await writeFile(join(f.directory,'receipt.json'),JSON.stringify(receipt))
  await writeFile(join(f.directory,'extra.py'),'pass')
  await assert.rejects(f.manager.verify(f.id),/inventory changed/)
})
test('normalization only permits bounded uv config lines and rejects embedded token',() => {
  assert.equal(normalizedPythonConfig(Buffer.from('home = /safe/python\n'),'/safe').toString(),'home = @SINGHOUSE_RUNTIME_ROOT@/python\n')
  assert.throws(() => normalizedPythonConfig(Buffer.from('home = @SINGHOUSE_RUNTIME_ROOT@\n'),'/safe'),/configuration/)
  assert.throws(() => normalizedPythonConfig(Buffer.from('exec("unsafe")\n'),'/safe'),/configuration/)
})
test('schema rejects unpinned tools, dependency resolution inputs and unsafe inventory',async t => {
  const f = await instance(t)
  for (const mutate of [m => {m.recipe.uv.sha256='bad'},m => {m.recipe.wheels[0].build=true},m => {m.recipe.files[0].path='../python'},m => {m.recipe.files[0].kind='uv-path-text'}]) {
    const changed = structuredClone(f.manifest); mutate(changed);bind(changed)
    assert.throws(() => validateProcessingRecipe(changed,identity,[changed.provenance.lockSha256]))
  }
})
async function point(manager,id,sequence=1,slot=0) {
  const body={schema:2,sequence,id}
  await writeFile(join(manager.root,`active.${slot}.json`),JSON.stringify({...body,checksum:sha(JSON.stringify(body))}))
}
test('cancelled replacement preserves previous pointer and releases installer ownership',async t => {
  const f=await instance(t)
  f.manager.lockPython=process.platform==='win32'?'python.exe':'python3'
  await point(f.manager,f.id)
  const controller=new AbortController();controller.abort()
  await assert.rejects(f.manager.install(f.manifest,{signal:controller.signal}))
  assert.equal(f.manager.busy,false)
  assert.equal((await f.manager.active()).id,f.id)
})
test('retention preserves a live worker lease and both active rollback slots',async t => {
  const f=await instance(t)
  f.manager.lockPython=process.platform==='win32'?'python.exe':'python3'
  const lease=await f.manager.acquireUsage(f.id)
  try {assert.deepEqual((await f.manager.prune()).removed,[])} finally {await lease.release()}
  await point(f.manager,f.id,1,1)
  assert.deepEqual((await f.manager.prune()).removed,[])
  await rm(join(f.root,'active.1.json'))
  assert.deepEqual((await f.manager.prune()).removed,[f.id])
})
test('uv clone fallback hardlinks are detached before activation',async t => {
  const f=await instance(t)
  const cache=join(f.root,'shared-cache-file')
  await link(join(f.directory,'python/bin/python3'),cache)
  assert.equal((await stat(cache)).nlink,2)
  await finalizeEnvironment(f.directory,'linux')
  assert.equal((await stat(cache)).nlink,1)
  await writeFile(cache,'damaged shared cache')
  assert.equal((await f.manager.verify(f.id)).id,f.id)
})
test('retention bounds failed attempts and evicts unreferenced artifact inputs',async t => {
  const f=await instance(t)
  f.manager.lockPython=process.platform==='win32'?'python.exe':'python3'
  await point(f.manager,f.id)
  for(const name of ['1'.repeat(16),'2'.repeat(16),'3'.repeat(16)]) await mkdir(join(f.root,'envs',name))
  const kept=f.manifest.recipe.python.sha256,obsolete='f'.repeat(64)
  await mkdir(join(f.root,'artifacts',kept),{recursive:true})
  await mkdir(join(f.root,'artifacts',obsolete),{recursive:true})
  const result=await f.manager.prune({incompleteLimit:1})
  assert.equal(result.removed.length,2)
  await stat(join(f.root,'artifacts',kept))
  await assert.rejects(stat(join(f.root,'artifacts',obsolete)),{code:'ENOENT'})
  assert.equal((await f.manager.active()).id,f.id)
})
test('release generator sorted JSON input locks compare structurally',async t => {
  const f=await instance(t)
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value
  f.manifest.provenance.inputLock=JSON.stringify(sorted(JSON.parse(f.manifest.provenance.inputLock)),null,2)+'\n'
  f.manifest.provenance.lockSha256=sha(f.manifest.provenance.inputLock)
  assert.equal(validateProcessingRecipe(f.manifest,identity,[f.manifest.provenance.lockSha256]),f.manifest)
})
test('interrupted first transfer retains pending recipe references and partial bytes',async t => {
  const f=await instance(t)
  f.manager.lockPython=process.platform==='win32'?'python.exe':'python3'
  f.manager.verifiedUv=async()=>{}
  f.manager.diskFree=async()=>Number.MAX_SAFE_INTEGER
  const changed=structuredClone(f.manifest)
  changed.appVersion='2'
  bind(changed)
  f.manager.identity={...identity,appVersion:'2'}
  f.manager.trustedLocks=[changed.provenance.lockSha256]
  f.manager.transfer=async(record,path)=>{await writeFile(path,'partial');throw new Error('simulated interruption')}
  await assert.rejects(f.manager.install(changed),/simulated interruption/)
  const saved=join(f.root,'artifacts',changed.recipe.python.sha256,'python.archive')
  assert.equal(await readFile(saved,'utf8'),'partial')
  f.manager.transfer=async()=>{throw new Error('network must not be used')}
  await assert.rejects(f.manager.install(changed,{offline:true}),/Offline processing repair needs/)
  assert.equal(await readFile(saved,'utf8'),'partial')
})
test('protected previous-release artifacts survive newer application admission policy',async t => {
  const f=await instance(t)
  f.manager.lockPython=process.platform==='win32'?'python.exe':'python3'
  await point(f.manager,f.id)
  const artifact=join(f.root,'artifacts',f.manifest.recipe.python.sha256)
  await mkdir(artifact,{recursive:true})
  f.manager.identity={...identity,appVersion:'new-release'}
  f.manager.trustedLocks=[]
  await assert.rejects(f.manager.verify(f.id),/incompatible/)
  await f.manager.prune()
  await stat(artifact)
  await stat(f.directory)
})
test('runtime admission requires matching installed native-tool provenance',async t => {
  const f=await instance(t)
  f.manager.nativeLockSha256='d'.repeat(64)
  assert.throws(()=>f.manager.validate(f.manifest),/native tools do not match/)
  f.manager.nativeLockSha256=undefined
  assert.throws(()=>f.manager.validate(f.manifest),/provenance is unavailable/)
})

test('inventory paths admit upstream wheel spaces and parentheses without unsafe syntax', () => {
  for (const path of ['env/lib/scipy/Transparent Busy.ani','env/lib/setuptools/script (dev).tmpl']) assert.equal(recipePath(path),true)
  for (const path of ['', '/absolute', '../escape','a/../b','a\\b','a/ leading','a/trailing ','a/end.','a/CON','a/aux.txt','a/line\nfeed','a/'+'x'.repeat(510)]) assert.equal(recipePath(path),false,path)
})

async function bundledTransferFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uv-bundled-artifact-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  const bundle = join(root, 'processing-artifacts'), cache = join(root, 'cache')
  await mkdir(bundle); await mkdir(cache)
  const contents = Buffer.from('release wheel or notice bytes')
  const record = { filename:'test-1-py3-none-any.whl', size:contents.length, sha256:sha(contents) }
  record.url = `https://github.com/singhouse/processing-packs/releases/download/rc-0.1.1/${record.sha256}-${record.filename}`
  const source = join(bundle, `${record.sha256}-${record.filename}`), destination = join(cache, record.filename)
  await writeFile(source, contents)
  const fetched = [], progress = []
  const manager = new UvRuntimeManager(root, identity, { bundledArtifactsDirectory:bundle,
    fetchImpl:async url => { fetched.push(String(url)); return new Response(contents) }, progress:value => progress.push(value) })
  return { manager, source, destination, record, contents, fetched, progress, bundle }
}

test('release artifacts are verified from bundled resources without a host fetch and preserve cache progress', async t => {
  const f = await bundledTransferFixture(t)
  await f.manager.transfer(f.record, f.destination)
  assert.deepEqual(await readFile(f.destination), f.contents)
  assert.deepEqual(f.fetched, [])
  assert.equal(f.progress.at(-1).received, f.record.size)
  // Normal safe cache reuse is retained, with the expected source still verified.
  await f.manager.transfer(f.record, f.destination)
  assert.deepEqual(f.fetched, [])
  assert.deepEqual(await readFile(f.destination), f.contents)
})

test('missing, corrupt, linked and mismatched expected bundle artifacts never fall back to HTTP', async t => {
  for (const damage of ['missing', 'checksum', 'size', 'link', 'identity']) {
    const f = await bundledTransferFixture(t)
    if (damage === 'missing') await rm(f.source)
    if (damage === 'checksum') await writeFile(f.source, Buffer.alloc(f.contents.length))
    if (damage === 'size') await writeFile(f.source, 'short')
    if (damage === 'link') { await rm(f.source); await writeFile(f.source + '.real', f.contents); await symlink(f.source + '.real', f.source) }
    if (damage === 'identity') f.record.sha256 = 'b'.repeat(64)
    await assert.rejects(f.manager.transfer(f.record, f.destination))
    assert.deepEqual(f.fetched, [], damage)
    await assert.rejects(stat(f.destination), { code:'ENOENT' })
  }
})

test('bundle retrieval keeps upstream HTTPS transfers unchanged and honors cancellation', async t => {
  const f = await bundledTransferFixture(t)
  const upstream = { ...f.record, url:'https://example.org/test-1-py3-none-any.whl' }
  await f.manager.transfer(upstream, f.destination)
  assert.deepEqual(f.fetched, [upstream.url])
  assert.deepEqual(await readFile(f.destination), f.contents)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.manager.transfer(f.record, f.destination, abort.signal), { name:'AbortError' })
  assert.deepEqual(f.fetched, [upstream.url])
})

test('only the exact release asset path can select a bundled artifact', async t => {
  const f = await bundledTransferFixture(t)
  for (const url of [f.record.url.replace('github.com/', 'github.com.evil.invalid/'),
    f.record.url.replace('/singhouse/', '/other/'), f.record.url + '?download=1']) {
    await rm(f.destination, { force:true })
    await f.manager.transfer({ ...f.record, url }, f.destination)
    assert.equal(f.fetched.at(-1), url)
  }
  assert.throws(() => new UvRuntimeManager('/tmp/test', identity, { bundledArtifactsDirectory:'relative' }), /absolute resources/)
})


test('an expected damaged bundle is not hidden by an existing valid cache entry', async t => {
  const f = await bundledTransferFixture(t)
  await f.manager.transfer(f.record, f.destination)
  await rm(f.source)
  await assert.rejects(f.manager.transfer(f.record, f.destination), { code:'ENOENT' })
  assert.deepEqual(f.fetched, [])
  assert.deepEqual(await readFile(f.destination), f.contents)
})
