// SPDX-License-Identifier: AGPL-3.0-only
// Test-only HTTPS file server for operator-supplied local processing pack files.
// It serves exactly one flat directory, read-only, on the loopback interface.
// It never fetches, mirrors or lists anything; it only answers for files the
// operator already placed in that directory.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer } from 'node:https'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HOST = '127.0.0.1'
const NAME = /^[A-Za-z0-9._-]+$/u
const PREFIX = /^\/[A-Za-z0-9._-]+$/u
const RANGE = /^bytes=(\d+)-$/u

export function validFileName(name) {
  return typeof name === 'string' && NAME.test(name) && name !== '.' && name !== '..'
}

export function parseServerArguments(args) {
  const valued = new Set(['--directory', '--port', '--cert', '--key', '--redirect-via', '--fail-after-bytes'])
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!valued.has(flag) || options[flag] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith('--')) {
      throw new Error(`Invalid argument: ${flag}`)
    }
    options[flag] = args[++i]
  }
  for (const key of ['--directory', '--port', '--cert', '--key']) assert.ok(options[key], `Missing ${key}`)
  const port = Number(options['--port'])
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, 'Port must be an explicit integer 1-65535')
  const redirectVia = options['--redirect-via']
  if (redirectVia !== undefined) assert.match(redirectVia, PREFIX, 'Redirect prefix must be one path segment such as /redirected')
  let failAfterBytes
  if (options['--fail-after-bytes'] !== undefined) {
    assert.match(options['--fail-after-bytes'], /^\d+$/u, 'Fail-after-bytes must be a non-negative integer')
    failAfterBytes = Number(options['--fail-after-bytes'])
    assert.ok(Number.isSafeInteger(failAfterBytes), 'Fail-after-bytes is too large')
  }
  return { directory: resolve(options['--directory']), port, cert: resolve(options['--cert']), key: resolve(options['--key']),
    redirectVia, failAfterBytes }
}

// Pure request classification; no filesystem access.
export function routeRequest({ method, url }, { redirectVia } = {}) {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405 }
  if (typeof url !== 'string' || !url.startsWith('/') || url.includes('%') || url.includes('\\') || url.includes('#')) return { status: 400 }
  const queryAt = url.indexOf('?')
  const path = queryAt === -1 ? url : url.slice(0, queryAt)
  const hasQuery = queryAt !== -1
  if (redirectVia !== undefined) {
    if (path.startsWith(`${redirectVia}/`)) {
      const name = path.slice(redirectVia.length + 1)
      if (!validFileName(name)) return { status: 404 }
      return hasQuery ? { status: 200, name } : { status: 404 }
    }
    const name = path.slice(1)
    if (!validFileName(name)) return { status: 404 }
    if (hasQuery) return { status: 400 }
    return { status: 302, name, location: `${redirectVia}/${name}?attempt=${randomBytes(8).toString('hex')}` }
  }
  if (hasQuery) return { status: 400 }
  const name = path.slice(1)
  return validFileName(name) ? { status: 200, name } : { status: 404 }
}

// Only the exact open-ended form is supported; that is the only form the
// application sends when resuming a partial transfer.
export function parseRange(header, size) {
  if (header === undefined) return { status: 200, start: 0 }
  const match = RANGE.exec(header)
  if (!match) return { status: 416 }
  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start >= size) return { status: 416 }
  return { status: 206, start, contentRange: `bytes ${start}-${size - 1}/${size}` }
}

function physicalDirectory(directory) {
  assert.ok(isAbsolute(directory), 'Served directory must be absolute')
  const info = lstatSync(directory)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Served directory must be a physical directory')
  assert.equal(realpathSync(directory), directory, 'Served directory must be a physical path')
}

export function createPackServer({ directory, cert, key, redirectVia, failAfterBytes, log = line => process.stdout.write(`${line}\n`) }) {
  physicalDirectory(directory)
  if (redirectVia !== undefined) assert.match(redirectVia, PREFIX, 'Invalid redirect prefix')
  let failurePending = failAfterBytes !== undefined
  const record = entry => log(JSON.stringify({ time: new Date().toISOString(), ...entry }))
  const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, async (request, response) => {
    const entry = { method: request.method, url: request.url, range: request.headers.range ?? null }
    const finish = (status, headers = {}, extra = {}) => {
      response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': '0', ...headers })
      response.end()
      record({ ...entry, status, bytes: 0, ...extra })
    }
    const route = routeRequest(request, { redirectVia })
    if (route.status === 405) return finish(405, { Allow: 'GET, HEAD' })
    if (route.status === 302) return finish(302, { Location: route.location })
    if (route.status !== 200) return finish(route.status)
    let handle
    try {
      const path = join(directory, route.name)
      const named = lstatSync(path, { throwIfNoEntry: false })
      if (!named || !named.isFile() || named.isSymbolicLink()) return finish(404)
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.ino !== named.ino || info.dev !== named.dev) return finish(404)
      const size = info.size
      const range = parseRange(request.headers.range, size)
      if (range.status === 416) return finish(416, { 'Content-Range': `bytes */${size}` })
      const length = size - range.start
      const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'Content-Length': String(length), ...(range.contentRange && { 'Content-Range': range.contentRange }) }
      response.writeHead(range.status, headers)
      if (request.method === 'HEAD') { response.end(); record({ ...entry, status: range.status, bytes: 0 }); return }
      const limit = failurePending ? failAfterBytes : Infinity
      if (failurePending) failurePending = false
      let sent = 0, position = range.start
      const closed = new Promise(resolveClosed => response.once('close', resolveClosed))
      const buffer = Buffer.allocUnsafe(64 * 1024)
      while (position < size) {
        const want = Math.min(buffer.length, size - position, limit - sent)
        if (want <= 0) break
        const { bytesRead } = await handle.read(buffer, 0, want, position)
        if (!bytesRead) throw new Error('File shrank while serving')
        position += bytesRead; sent += bytesRead
        if (!response.write(Buffer.from(buffer.subarray(0, bytesRead)))) {
          const drained = await Promise.race([new Promise(resolveDrain => response.once('drain', () => resolveDrain(true))), closed.then(() => false)])
          if (!drained) throw new Error('Client closed the connection')
        }
      }
      if (sent < length) {
        // Injected failure: the advertised length is never delivered.
        await new Promise(resolveFlush => response.write('', () => resolveFlush()))
        response.socket?.destroy()
        record({ ...entry, status: range.status, bytes: sent, outcome: 'injected-failure' })
        return
      }
      response.end()
      record({ ...entry, status: range.status, bytes: sent, outcome: 'complete' })
    } catch (error) {
      if (!response.headersSent) return finish(500, {}, { error: 'read-failed' })
      response.socket?.destroy()
      record({ ...entry, status: response.statusCode, outcome: 'aborted', error: error.message })
    } finally { await handle?.close().catch(() => {}) }
  })
  return server
}

export function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen({ host: HOST, port, exclusive: true }, () => { server.off('error', reject); resolveListen(server.address().port) })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(async () => {
    const options = parseServerArguments(process.argv.slice(2))
    const server = createPackServer({ ...options, cert: readFileSync(options.cert), key: readFileSync(options.key) })
    const port = await listen(server, options.port)
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), listening: `https://${HOST}:${port}/`,
      directory: options.directory, redirectVia: options.redirectVia ?? null, failAfterBytes: options.failAfterBytes ?? null })}\n`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)))
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
