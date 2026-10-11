// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,rm,symlink,readFile,link,stat } from 'node:fs/promises'
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
