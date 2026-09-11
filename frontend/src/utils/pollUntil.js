// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Poll until an async function returns truthy or max attempts are reached.
 * @param {Function} fn - async function called each tick. Return truthy to resolve.
 * @param {Object} opts
 * @param {number} opts.intervalMs - ms between polls (default 3000)
 * @param {number} opts.maxAttempts - max polls (default 120)
 * @param {Function} [opts.onTick] - called each tick with attempt index
 * @returns {Promise<any>} resolves with fn's return value, rejects on timeout
 */
export async function pollUntil(fn, { intervalMs = 3000, maxAttempts = 120, onTick } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await fn()
    if (result) return result
    onTick?.(attempt)
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, intervalMs))
    }
  }
  throw new Error('Polling timed out')
}
