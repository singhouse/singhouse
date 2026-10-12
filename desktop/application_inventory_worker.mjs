// SPDX-License-Identifier: AGPL-3.0-only
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { observeReceiptApplication } from './application_inventory.mjs'

// The same physical-file observer runs in a worker so even a cold, writable
// installation cannot block Electron's close events. No verification is skipped.
export function observeReceiptApplicationOffThread(options, { signal, diagnostic = () => {} } = {}) {
  signal?.throwIfAborted()
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./application_inventory_worker.mjs', import.meta.url), { workerData: options })
    let result, failure, aborted = false
    const abort = () => {
      aborted = true
      void worker.terminate().catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    worker.on('message', message => {
      if (message.type === 'result') result = message.value
      else if (message.type === 'phase') diagnostic(message.value)
    })
    worker.on('error', error => { failure = error })
    worker.on('exit', code => {
      signal?.removeEventListener('abort', abort)
      diagnostic({ phase: 'application-inventory', status: aborted ? 'cancelled' : failure || code !== 0 || !result ? 'failed' : 'complete',
        elapsedMs: Math.round(performance.now() - started), ...(result ? { mode: result.mode } : {}) })
      if (aborted) reject(signal.reason ?? new Error('Application verification cancelled'))
      else if (failure) reject(failure)
      else if (code !== 0 || !result) reject(new Error('Application verification worker stopped before completion'))
      else resolve(result)
    })
  })
}

if (!isMainThread) {
  // Electron's patched fs interprets app.asar as a directory. Always use its
  // original-fs in Electron; plain Node is only used by the standalone tests.
  const physicalFs = createRequire(import.meta.url)(process.versions.electron ? 'original-fs' : 'node:fs')
  parentPort.postMessage({ type: 'phase', value: { phase: 'application-inventory', status: 'started' } })
  const { identity, mode, launchInventory } = observeReceiptApplication({ ...workerData, physicalFs })
  // The main process needs identity/cache only, not another copy of all records.
  parentPort.postMessage({ type: 'result', value: { identity, mode, launchInventory } })
}
