// SPDX-License-Identifier: AGPL-3.0-only
// Native installer fixture. Its synthetic import probe does not qualify AI processing.
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, rename, lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { UvRuntimeManager } from '../uv_runtime_manager.mjs'
const config = JSON.parse(await readFile(process.argv[2]))
const sha = data => createHash('sha256').update(data).digest('hex')
const artifact = async path => { const bytes = await readFile(path); return { url:pathToFileURL(path).href, size:bytes.length, sha256:sha(bytes) } }
const identity = { appVersion:'1', backendVersion:'1', lyricsyncVersion:'1', platform:process.platform, arch:process.arch }
assert.equal(`${identity.platform}-${identity.arch}`, config.target)
const base = { schema:2, kind:'processing', ...identity, pythonVersion:config.pythonVersion, accelerator:'cpu',
  python:process.platform === 'win32' ? 'env/Scripts/python.exe' : 'env/bin/python',
  capabilities:['separation'], models:['fixture'], modelCapabilities:{fixture:'separation'},
  probe:{schema:2,type:'python-functional-v1',modules:['audio_separator.separator','demucs.separate']},
  recipe:{schema:1,nativeTools:{nativeLockSha256:config.nativeLockSha256,ffmpegRelease:config.ffmpegRelease}, python:{...await artifact(config.pythonArchive), version:config.pythonVersion, archive:'tar.gz',member:process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'},
    uv:{version:config.uvVersion,sha256:sha(await readFile(config.uv))},
    wheels:[{...await artifact(config.wheel),name:'fixture-113',version:'1.0',filename:'fixture_113-1.0-py3-none-any.whl',sourceUrl:'https://example.org/fixture',sourceSha256:'b'.repeat(64),license:'MIT',notices:[{...await artifact(config.notice),filename:'000.txt'}]}],
    files:config.files, installedSize:config.files.reduce((sum,file)=>sum+(file.size||0),0)} }
function manifest(commit, corrupt = false, updated = false) {
  const sourceCommit=commit.repeat(40),packages=[{name:'fixture-113'}], body=structuredClone(base)
  if(updated) {
    body.recipe.wheels[0]={...body.recipe.wheels[0],...updatedArtifact,version:'1.1',filename:'fixture_113-1.1-py3-none-any.whl'}
    body.recipe.files=config.updatedFiles
    body.recipe.installedSize=config.updatedFiles.reduce((sum,file)=>sum+(file.size||0),0)
  }
  if(corrupt) body.recipe.wheels[0].sha256='0'.repeat(64)
  const inputLock=JSON.stringify({...body,kind:'processing-input',sourceCommit,packages})
  return {...body,provenance:{sourceCommit,packages,inputLock,lockSha256:sha(inputLock)}}
}
const updatedArtifact=await artifact(config.updatedWheel)
const variants=['a','b','c','d','e'].map(commit=>manifest(commit))
variants.push(manifest('f',true),manifest('0'),manifest('1',false,true))
const evidence={schema:1,qualification:'native-installer-fixture-only',target:config.target,uvVersion:config.uvVersion,pythonVersion:config.pythonVersion,
  installedFiles:config.files.length,installedBytes:base.recipe.installedSize,runs:[],modelDownloads:0}
function manager(root) {
  const instance=new UvRuntimeManager(root,identity,{uvPath:config.uv,lockPython:config.lockPython,nativeLockSha256:config.nativeLockSha256,
    durabilityHelper:fileURLToPath(new URL('../backend.py',import.meta.url)),
    trustedLocks:variants.map(item=>item.provenance.lockSha256),allowLocalRecipeSources:true,
    fetchImpl:()=>{throw new Error('Native fixture attempted network access')} })
  instance.transferredSourceBytes = 0
  const transfer = instance.transfer.bind(instance)
  instance.transfer = async (record,path,...args) => {
    let offset = 0
    try { const size=(await lstat(path)).size; if(size<record.size)offset=size } catch(error) { if(error.code!=='ENOENT')throw error }
    const progress=instance.progress
    instance.progress = event => {
      instance.transferredSourceBytes += Math.max(0,event.received-offset)
      offset=event.received
      progress(event)
    }
    try { return await transfer(record,path,...args) } finally { instance.progress=progress }
  }
  const command = instance.command.bind(instance)
  instance.command = async (...args) => {
    try { return await command(...args) }
    catch (error) { console.error('Native fixture command failed:', args[0], args[1]); throw error }
  }
  instance.probe=async ({id})=>{
    const verified=await instance.verify(id)
    assert.equal(await instance.command(join(verified.directory,base.python),['-B','-c','import fixture_113; print(fixture_113.VALUE)']), '113')
  }
  return instance
}
// Restart checks execute this file in a fresh Node process with the same trusted inputs.
if(process.argv[3]==='--restart-check') {
  const restarted=manager(join(config.root,'runtime-first'))
  const selected=await restarted.active()
  assert.equal(selected.id,process.argv[4])
  await restarted.probe(selected)
  const version=await restarted.command(join(selected.directory,base.python),['-B','-c','import fixture_113; from importlib.metadata import version; assert fixture_113.VERSION == version("fixture-113"); print(fixture_113.VERSION)'])
  assert.equal(version,process.argv[5])
  console.log(JSON.stringify({id:selected.id,version}))
  process.exit(0)
}
// Logical totals include each retained generation. Allocated totals count each
// inode once when the platform exposes block allocation; neither is an estimate
// of unobserved peaks between samples.
async function usage(root) {
  let logicalBytes=0,allocatedBytes=0,allocationKnown=process.platform!=='win32',files=0
  const inodes=new Set()
  async function walk(at) {
    let items
    try {items=await readdir(at,{withFileTypes:true})} catch(error) {if(error.code==='ENOENT')return;throw error}
    for(const entry of items) {
      const path=join(at,entry.name)
      if(entry.isDirectory()) await walk(path)
      else if(entry.isFile()) {
        let info
        try {info=await lstat(path)} catch(error) {if(error.code==='ENOENT')continue;throw error}
        files++;logicalBytes+=info.size
        if(typeof info.blocks!=='number') allocationKnown=false
        else if(!inodes.has(`${info.dev}:${info.ino}`)) {inodes.add(`${info.dev}:${info.ino}`);allocatedBytes+=info.blocks*512}
      }
    }
  }
  await walk(root)
  return {logicalBytes,allocatedBytes:allocationKnown?allocatedBytes:null,files}
}
async function timed(instance, recipe, name, options) {
  console.log(`Native fixture phase: ${name}`)
  const before=await usage(instance.root),transferBefore=instance.transferredSourceBytes
  let done=false,samples=0,peakLogicalBytes=before.logicalBytes,peakAllocatedBytes=before.allocatedBytes
  const sample=async()=>{
    const current=await usage(instance.root);samples++
    peakLogicalBytes=Math.max(peakLogicalBytes,current.logicalBytes)
    if(current.allocatedBytes!==null&&peakAllocatedBytes!==null)peakAllocatedBytes=Math.max(peakAllocatedBytes,current.allocatedBytes)
    else peakAllocatedBytes=null
  }
  const sampler=(async()=>{while(!done){await sample();if(!done)await new Promise(resolve=>setTimeout(resolve,250))}})()
  const start=performance.now()
  let active
  try {active=await instance.install(recipe,options)} finally {done=true;await sampler}
  await sample()
  const inventoryVerification = JSON.parse((await promisify(execFile)(config.lockPython,
    [fileURLToPath(new URL('./test_uv_installation.py',import.meta.url)), '--verify-installed',
      active.directory,active.id,instance.root,recipe.provenance.lockSha256])).stdout)
  assert.equal(inventoryVerification.backendInventoryVerification,true)
  assert.equal(inventoryVerification.files,recipe.recipe.files.length)
  const elapsedMs=Math.round(performance.now()-start)
  const row={name,elapsedMs,id:active.id,backendInventoryVerification:inventoryVerification.backendInventoryVerification,transferredSourceBytes:instance.transferredSourceBytes-transferBefore,
    installedUsage:await usage(active.directory),cacheUsage:await usage(join(instance.root,'uv-cache')),
    artifactCacheUsage:await usage(join(instance.root,'artifacts')),retainedUsage:await usage(instance.root),
    sampledPeak:{logicalBytes:peakLogicalBytes,allocatedBytes:peakAllocatedBytes,samples,minimumIntervalMs:250}}
  evidence.runs.push(row)
  assert.equal((await instance.active()).id,active.id)
  return active
}
const first=manager(join(config.root,'runtime-first'))
await timed(first,variants[0],'cold-empty-cache')
let warm
for (const path of [config.wheel,config.pythonArchive]) await rename(path,path+'.unavailable')
try { warm=await timed(first,variants[1],'new-recipe-shared-cache') }
finally { for(const path of [config.wheel,config.pythonArchive]) await rename(path+'.unavailable',path) }
evidence.sharedCacheWorksWithoutWheelOrPythonSources=true
assert.notEqual(evidence.runs[0].id,warm.id)
const independent=manager(join(config.root,'runtime-second-longer-root'))
await timed(independent,variants[0],'independent-empty-cache')
const originalDiskFree=first.diskFree
const transferBeforeLowSpace=first.transferredSourceBytes
let lowSpaceActivation=false
first.diskFree=async()=>0
first.activationHook=async()=>{lowSpaceActivation=true}
try {
  await assert.rejects(first.install(variants[2]),/Not enough disk space/)
  assert.equal(first.transferredSourceBytes,transferBeforeLowSpace)
  assert.equal(lowSpaceActivation,false)
  assert.equal((await first.active()).id,warm.id)
  evidence.simulatedAvailableSpacePreflight={rejectedBeforeTransfer:true,previousActiveVerified:true,
    physicalEnospcQualified:false}
} finally {first.diskFree=originalDiskFree;first.activationHook=async()=>{}}
const aborted=new AbortController()
first.activationHook=async phase=>{if(phase==='pack-durable')aborted.abort()}
await assert.rejects(first.install(variants[2],{signal:aborted.signal}))
assert.equal((await first.active()).id,warm.id)
first.activationHook=async()=>{}
evidence.cancelledReplacementPreservedActive=true
await assert.rejects(first.install(variants[5]))
assert.equal((await first.active()).id,warm.id)
evidence.failedReplacementPreservedActive=true
// Change uv's unpacked wheel cache, never an installed environment. The trusted
// inventory must reject a new generation using it, and explicit refresh repair it.
async function fixtureFiles(root) {
  const result=[]
  for(const entry of await readdir(root,{withFileTypes:true})) {
    const path=join(root,entry.name)
    if(entry.isDirectory()) result.push(...await fixtureFiles(path))
    else if(entry.isFile()&&entry.name==='fixture_113.py') result.push(path)
  }
  return result
}
const cached=await fixtureFiles(join(first.root,'uv-cache'))
assert.ok(cached.length,'uv unpacked wheel cache was populated')
for(const path of cached) await writeFile(path,'VALUE = 999\n')
await timed(first,variants[3],'automatic-corrupt-cache-repair')
await first.verify(warm.id)
evidence.corruptCacheReplacementPreservedPrevious=true
for(const path of await fixtureFiles(join(first.root,'uv-cache'))) await writeFile(path,'VALUE = 999\n')
const repaired=await timed(first,variants[4],'explicit-corrupt-cache-repair',{refreshCache:true})
evidence.corruptCacheRepairPassed=true
const missing=await fixtureFiles(join(first.root,'uv-cache'))
assert.ok(missing.length,'cache repopulated after repair')
for(const path of missing) await rm(path)
await timed(first,variants[6],'automatic-missing-cache-member-repair')
await first.verify(repaired.id)
evidence.missingCacheMemberRepairPassed=true
const previous=await first.active()
// Keep an older generation leased even after both rollback slots move past it.
const lease=await first.acquireUsage(repaired.id)
try {
  for(const path of [config.wheel,config.pythonArchive,config.notice]) await rename(path,path+'.unavailable')
  let updated
  try { updated=await timed(first,variants[7],'synthetic-dependency-update-1.0-to-1.1') }
  finally {for(const path of [config.wheel,config.pythonArchive,config.notice]) await rename(path+'.unavailable',path)}
  const row=evidence.runs.at(-1)
  assert.equal(row.transferredSourceBytes,updatedArtifact.size)
  assert.ok(row.transferredSourceBytes>0)
  await first.verify(previous.id)
  const restart=async(id,version)=>JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(import.meta.url),process.argv[2],'--restart-check',id,version])).stdout)
  evidence.updatedRestart=await restart(updated.id,'1.1')
  await first.prune()
  await first.verify(repaired.id)
  evidence.inFlightLeasePreserved=true
  const installedFixture=(await fixtureFiles(updated.directory))[0]
  assert.ok(installedFixture)
  await writeFile(installedFixture,'VALUE = 999\n')
  evidence.corruptUpdateRestartFallback=await restart(previous.id,'1.0')
  evidence.syntheticDependencyUpdate={from:'1.0',to:'1.1',changedWheelBytes:updatedArtifact.size,
    unchangedPythonAndNoticeSourcesUnavailable:true,previousGenerationVerified:true}
} finally {await lease.release()}
evidence.initialTransferBytes=evidence.runs.find(row=>row.name==='cold-empty-cache').transferredSourceBytes
evidence.sameDependencyRecipeTransferBytes=evidence.runs.find(row=>row.name==='new-recipe-shared-cache').transferredSourceBytes
evidence.incrementalTransferBytes=evidence.runs.find(row=>row.name==='synthetic-dependency-update-1.0-to-1.1').transferredSourceBytes
assert.ok(evidence.incrementalTransferBytes<evidence.initialTransferBytes)
evidence.finalRetainedUsage=await usage(first.root)
evidence.measurementScope='Tiny synthetic wheel only; source bytes are streamed bytes written, allocation counts regular-file stat blocks when available (excluding directories and symlinks; shared reflink extents are not measured), peak is sampled and elapsed includes measurement overhead.'
await writeFile(join(config.root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify(evidence))
