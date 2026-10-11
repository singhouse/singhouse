// SPDX-License-Identifier: AGPL-3.0-only
// Full dependency-runtime validation; this does not acquire or qualify model weights.
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {UvRuntimeManager} from '../uv_runtime_manager.mjs'
const config=JSON.parse(await readFile(process.argv[2]))
const manifest=JSON.parse(await readFile(config.manifest))
const identity=Object.fromEntries(['appVersion','backendVersion','lyricsyncVersion','platform','arch'].map(key=>[key,manifest[key]]))
assert.equal(`${identity.platform}-${identity.arch}`,`${process.platform}-${process.arch}`)
const nativeLockSha256=createHash('sha256').update(await readFile(new URL('../locks/native.json',import.meta.url))).digest('hex')
assert.equal(manifest.recipe.nativeTools.nativeLockSha256,nativeLockSha256)
const manager=new UvRuntimeManager(config.runtimeRoot,identity,{uvPath:config.uv,lockPython:config.lockPython,
  durabilityHelper:fileURLToPath(new URL('../backend.py',import.meta.url)),nativeBin:config.nativeBin,
  nativeLockSha256,trustedLocks:[manifest.provenance.lockSha256],allowLocalRecipeSources:true})
let sourceBytes=0,lastLog=0
const transfer=manager.transfer.bind(manager)
manager.transfer=async(record,path,...args)=>{
  let offset=0
  try {const n=(await lstat(path)).size;if(n<record.size)offset=n}catch(error){if(error.code!=='ENOENT')throw error}
  const progress=manager.progress
  manager.progress=event=>{sourceBytes+=Math.max(0,event.received-offset);offset=event.received
    if(Date.now()-lastLog>5000){console.log(JSON.stringify({phase:'retrieve',sourceBytes}));lastLog=Date.now()}
    progress(event)}
  try{return await transfer(record,path,...args)}finally{manager.progress=progress}
}
let functionalProbe
const probe=manager.probe.bind(manager)
manager.probe=async(...args)=>{const result=await probe(...args);functionalProbe=result;return result}
async function usage(root){
  let logicalBytes=0,allocatedBytes=0,files=0
  for(const entry of await readdir(root,{withFileTypes:true})){
    const path=join(root,entry.name)
    if(entry.isDirectory()){const child=await usage(path);logicalBytes+=child.logicalBytes;allocatedBytes+=child.allocatedBytes||0;files+=child.files}
    else if(entry.isFile()){const info=await lstat(path);logicalBytes+=info.size;allocatedBytes+=(info.blocks||0)*512;files++}
  }
  return{logicalBytes,allocatedBytes:process.platform==='win32'?null:allocatedBytes,files}
}
async function verifyBackendInventory(active){
  const result=JSON.parse((await promisify(execFile)(config.lockPython,
    [fileURLToPath(new URL('./test_uv_installation.py',import.meta.url)),'--verify-installed',
      active.directory,active.id,config.runtimeRoot,manifest.provenance.lockSha256])).stdout)
  assert.equal(result.backendInventoryVerification,true)
  assert.equal(result.files,manifest.recipe.files.length)
  return result
}
let existed=false
try {await lstat(config.runtimeRoot);existed=true}catch(error){if(error.code!=='ENOENT')throw error}
const initialArtifacts=await usage(join(config.runtimeRoot,'artifacts')).catch(error=>{if(error.code==='ENOENT')return{files:0,logicalBytes:0};throw error})
const initialUvCache=await usage(join(config.runtimeRoot,'uv-cache')).catch(error=>{if(error.code==='ENOENT')return{files:0,logicalBytes:0};throw error})
const start=Date.now(),active=await manager.install(manifest)
if(!functionalProbe) await manager.probe(active)
const firstElapsedMs=Date.now()-start,firstSourceBytes=sourceBytes,backendInventoryVerification=await verifyBackendInventory(active)
assert.equal((await manager.active()).id,active.id)
// A second install of this exact recipe must work without any source retrieval.
// This is reuse/revalidation evidence, not an incremental dependency update.
manager.transfer=async()=>{throw new Error('Same-recipe reuse attempted source retrieval')}
manager.fetch=async()=>{throw new Error('Same-recipe reuse attempted network access')}
const reuseStart=Date.now(),reused=await manager.install(manifest)
assert.equal(reused.id,active.id)
await verifyBackendInventory(reused)
const records=[manifest.recipe.python,...manifest.recipe.wheels,...manifest.recipe.wheels.flatMap(wheel=>wheel.notices)]
const evidence={schema:1,qualification:'full-dependency-runtime-functional-only',target:`${process.platform}-${process.arch}`,
  accelerator:manifest.accelerator,sourceCommit:manifest.provenance.sourceCommit,lockSha256:manifest.provenance.lockSha256,
  nativeLockSha256,uvVersion:manifest.recipe.uv.version,pythonVersion:manifest.pythonVersion,
  packageCount:manifest.recipe.wheels.length,verifiedFiles:backendInventoryVerification.files,backendInventoryVerification:true,functionalProbe,
  modelDownloads:0,seededByHarness:false,acquisitionCacheInitiallyEmpty:initialArtifacts.files===0,uvCacheInitiallyEmpty:initialUvCache.files===0,mode:existed?'existing-recipe-revalidation':'cold-install',firstElapsedMs,firstSourceBytes,
  aggregateSourceByteEstimate:records.reduce((sum,record)=>sum+record.size,0),
  sameRecipeOfflineReuse:{passed:true,elapsedMs:Date.now()-reuseStart,transferredBytes:sourceBytes-firstSourceBytes},
  installedUsage:await usage(active.directory),artifactCacheUsage:await usage(join(config.runtimeRoot,'artifacts')),
  uvCacheUsage:await usage(join(config.runtimeRoot,'uv-cache')),retainedUsage:await usage(config.runtimeRoot),
  measurementScope:'Runtime dependencies and backend inventory only; full worker launch, resource policy, models, and user-media processing are not qualified. Regular-file logical bytes and reported blocks exclude directory/symlink blocks and do not measure shared reflink extents. Same-recipe reuse is not a dependency update.'}
await writeFile(config.evidence,JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify(evidence))
