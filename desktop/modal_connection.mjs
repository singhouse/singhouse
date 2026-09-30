// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { childEnvironment } from './policy.mjs'

const failure = errorCode => ({ schema: 1, accessChecked: false, compatible: false,
  qualified: false, ready: false, stages: { access: 'failed', tags: 'not_checked', functions: 'not_checked' }, errorCode })

// The helper resolves metadata only. Credentials never enter process arguments,
// an inherited environment, diagnostic output, or a renderer response.
export function checkModalConnection({ python, helper, contract, configuration, signal, spawnImpl = spawn, timeoutMs = 30000 }) {
  if (!configuration) return Promise.resolve(failure('not_configured'))
  if (signal?.aborted) return Promise.resolve(failure('cancelled'))
  const { app, environment, version, tokenId, tokenSecret } = configuration
  return new Promise(resolve => {
    let child, timer, settled = false, output = ''
    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    function stop(code) {
      try { child?.kill('SIGKILL') } catch { /* Never forward OS errors containing paths. */ }
      finish(failure(code))
    }
    const abort = () => stop('cancelled')
    try {
      child = spawnImpl(python, ['-I', '-B', helper, ...(contract ? ['--contract', contract] : [])], {
        env: childEnvironment(process.env), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      })
      timer = setTimeout(() => stop('timeout'), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      child.on('error', () => finish(failure('client_unavailable')))
      child.stdin.on('error', () => stop('client_unavailable'))
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8')
        if (output.length > 32768) stop('invalid_response')
      })
      child.on('close', code => {
        if (settled) return
        try {
          const response = JSON.parse(output)
          if (code !== 0 || response.schema !== 1 || typeof response.accessChecked !== 'boolean'
              || typeof response.compatible !== 'boolean' || response.qualified !== false || response.ready !== false) {
            throw new Error('invalid response')
          }
          // Fixed fields only; never relay arbitrary helper output to the UI.
          const stages = {}
          for (const key of ['access', 'tags', 'functions']) {
            stages[key] = ['passed', 'failed', 'not_checked', 'unchecked', 'skipped', 'unavailable', 'missing'].includes(response.stages?.[key])
              ? response.stages[key] : 'not_checked'
          }
          const codes = new Set(['invalid-config', 'sdk-unavailable', 'release-contract-unavailable',
            'protocol-tags-mismatch', 'metadata-check-timeout', 'metadata-check-failed'])
          finish({ schema: 1, accessChecked: response.accessChecked, compatible: response.compatible,
            qualified: false, ready: false, stages,
            ...(response.errorCode ? { errorCode: codes.has(response.errorCode) ? response.errorCode : 'check_failed' } : {}) })
        } catch { finish(failure('invalid_response')) }
      })
      child.stdin.end(JSON.stringify({ app, environment, version, tokenId, tokenSecret }))
    } catch { stop('client_unavailable') }
  })
}
