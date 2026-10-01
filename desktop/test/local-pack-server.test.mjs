// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPackServer, listen, parseRange, parseServerArguments, routeRequest, validFileName } from './local-pack-server.mjs'

function openssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false }
}
const OPENSSL = openssl()
const SKIP = OPENSSL ? false : 'openssl CLI is not available to create a throwaway test certificate'

test('arguments require an explicit directory, port and PEM pair', () => {
  const base = ['--directory', 'packs', '--port', '8443', '--cert', 'c.pem', '--key', 'k.pem']
  const parsed = parseServerArguments(base)
  assert.equal(parsed.port, 8443); assert.ok(parsed.directory.endsWith('packs'))
  for (const missing of ['--directory', '--port', '--cert', '--key']) {
    const index = base.indexOf(missing)
    assert.throws(() => parseServerArguments([...base.slice(0, index), ...base.slice(index + 2)]), /Missing/)
  }
  for (const port of ['0', '65536', 'x', '1.5']) {
    assert.throws(() => parseServerArguments(base.map((value, i) => i === 3 ? port : value)), /Port/)
  }
  assert.throws(() => parseServerArguments([...base, '--host', '0.0.0.0']), /Invalid argument/)
  assert.throws(() => parseServerArguments([...base, '--port', '1']), /Invalid argument/)
  assert.equal(parseServerArguments([...base, '--redirect-via', '/hop']).redirectVia, '/hop')
  for (const prefix of ['hop', '/a/b', '/..%2f', '/']) assert.throws(() => parseServerArguments([...base, '--redirect-via', prefix]))
  assert.equal(parseServerArguments([...base, '--fail-after-bytes', '10']).failAfterBytes, 10)
  assert.throws(() => parseServerArguments([...base, '--fail-after-bytes', '-1']), /Invalid argument|non-negative/)
})

test('routes accept only flat file names and never list or traverse', () => {
  assert.equal(validFileName('runtime-0001.part_a.bin'), true)
  for (const name of ['', '.', '..', 'a/b', 'a b', 'ä', 'a\\b']) assert.equal(validFileName(name), false)
  assert.deepEqual(routeRequest({ method: 'GET', url: '/blob.bin' }), { status: 200, name: 'blob.bin' })
  assert.deepEqual(routeRequest({ method: 'HEAD', url: '/blob.bin' }), { status: 200, name: 'blob.bin' })
  for (const url of ['/', '/..', '/a/../b', '/sub/blob.bin']) assert.equal(routeRequest({ method: 'GET', url }).status, 404)
  for (const url of ['/%2e%2e/x', '/blob.bin?x=1', '/a\\b', 'blob.bin']) assert.equal(routeRequest({ method: 'GET', url }).status, 400)
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(routeRequest({ method, url: '/blob.bin' }).status, 405)
})

test('redirect mode answers the public path with a same-origin query-bearing location', () => {
  const route = routeRequest({ method: 'GET', url: '/blob.bin' }, { redirectVia: '/hop' })
  assert.equal(route.status, 302); assert.match(route.location, /^\/hop\/blob\.bin\?attempt=[a-f0-9]{16}$/)
  assert.deepEqual(routeRequest({ method: 'GET', url: route.location }, { redirectVia: '/hop' }), { status: 200, name: 'blob.bin' })
  assert.equal(routeRequest({ method: 'GET', url: '/hop/blob.bin' }, { redirectVia: '/hop' }).status, 404)
  assert.equal(routeRequest({ method: 'GET', url: '/hop/../x?y' }, { redirectVia: '/hop' }).status, 404)
})

test('ranges support exactly the open-ended resume form', () => {
  assert.deepEqual(parseRange(undefined, 10), { status: 200, start: 0 })
  assert.deepEqual(parseRange('bytes=4-', 10), { status: 206, start: 4, contentRange: 'bytes 4-9/10' })
  assert.deepEqual(parseRange('bytes=0-', 10), { status: 206, start: 0, contentRange: 'bytes 0-9/10' })
  for (const header of ['bytes=10-', 'bytes=11-', 'bytes=0-4', 'bytes=-4', 'bytes=1-,3-', 'items=1-', 'bytes= 1-', 'bytes=x-']) {
    assert.equal(parseRange(header, 10).status, 416, header)
  }
  assert.equal(parseRange('bytes=0-', 0).status, 416)
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pack-server-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const served = join(root, 'served'); mkdirSync(served)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')],
  { stdio: 'ignore', timeout: 20000 })
  return { root, served, cert: readFileSync(join(root, 'cert.pem')), key: readFileSync(join(root, 'key.pem')) }
}

async function start(t, f, options = {}) {
  const lines = []
  const server = createPackServer({ directory: f.served, cert: f.cert, key: f.key, log: line => lines.push(JSON.parse(line)), ...options })
  const port = await listen(server, 0)
  t.after(() => new Promise(resolveClose => { server.closeAllConnections?.(); server.close(() => resolveClose()) }))
  // Trust is scoped to this request through `ca`; verification stays on.
  const fetch = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolveFetch, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: f.cert, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolveFetch({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete }))
      response.on('error', error => resolveFetch({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), error }))
      response.on('aborted', () => {})
    })
    req.on('error', reject)
    req.end()
  })
  return { port, lines, fetch }
}

test('serves full files, HEAD, exact resume ranges and 416 over verified TLS', { skip: SKIP }, async t => {
  const f = fixture(t), bytes = Buffer.from('0123456789abcdef'.repeat(4096))
  writeFileSync(join(f.served, 'blob.bin'), bytes)
  const s = await start(t, f)
  const full = await s.fetch('/blob.bin')
  assert.equal(full.status, 200); assert.equal(full.headers['content-length'], String(bytes.length)); assert.deepEqual(full.body, bytes)
  assert.equal(full.headers['accept-ranges'], 'bytes')
  const head = await s.fetch('/blob.bin', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.headers['content-length'], String(bytes.length)); assert.equal(head.body.length, 0)
  const partial = await s.fetch('/blob.bin', { headers: { Range: 'bytes=100-' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers['content-range'], `bytes 100-${bytes.length - 1}/${bytes.length}`)
  assert.equal(partial.headers['content-length'], String(bytes.length - 100)); assert.deepEqual(partial.body, bytes.subarray(100))
  for (const range of [`bytes=${bytes.length}-`, 'bytes=0-10']) {
    const refused = await s.fetch('/blob.bin', { headers: { Range: range } })
    assert.equal(refused.status, 416); assert.equal(refused.headers['content-range'], `bytes */${bytes.length}`)
  }
  assert.equal((await s.fetch('/blob.bin', { method: 'POST' })).status, 405)
  assert.equal((await s.fetch('/missing.bin')).status, 404)
  assert.equal((await s.fetch('/')).status, 404)
  assert.ok(s.lines.every(line => typeof line.time === 'string' && typeof line.status === 'number'))
  assert.deepEqual(s.lines.slice(0, 3).map(line => [line.method, line.status, line.bytes]),
    [['GET', 200, bytes.length], ['HEAD', 200, 0], ['GET', 206, bytes.length - 100]])
})

test('refuses symbolic links and subdirectories inside the served directory', { skip: SKIP }, async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'outside.bin'), 'outside')
  symlinkSync(join(f.root, 'outside.bin'), join(f.served, 'link.bin'))
  mkdirSync(join(f.served, 'nested'))
  const s = await start(t, f)
  assert.equal((await s.fetch('/link.bin')).status, 404)
  assert.equal((await s.fetch('/nested')).status, 404)
  assert.throws(() => createPackServer({ directory: join(f.root, 'linked-root'), cert: f.cert, key: f.key }))
  symlinkSync(f.served, join(f.root, 'linked-root'))
  assert.throws(() => createPackServer({ directory: join(f.root, 'linked-root'), cert: f.cert, key: f.key }), /physical/)
})

test('redirect mode serves the query-bearing second path on the same origin', { skip: SKIP }, async t => {
  const f = fixture(t)
  writeFileSync(join(f.served, 'blob.bin'), 'payload')
  const s = await start(t, f, { redirectVia: '/hop' })
  const first = await s.fetch('/blob.bin')
  assert.equal(first.status, 302); assert.match(first.headers.location, /^\/hop\/blob\.bin\?attempt=/)
  const second = await s.fetch(first.headers.location)
  assert.equal(second.status, 200); assert.equal(second.body.toString(), 'payload')
})

test('fail-after-bytes truncates exactly one response, then resume completes', { skip: SKIP }, async t => {
  const f = fixture(t), bytes = Buffer.alloc(300 * 1024, 7)
  writeFileSync(join(f.served, 'blob.bin'), bytes)
  const s = await start(t, f, { failAfterBytes: 1000 })
  const first = await s.fetch('/blob.bin').catch(error => ({ error }))
  assert.ok(first.error || first.complete === false || first.body.length < bytes.length, 'first response must be truncated')
  assert.ok(!first.body || first.body.length <= 1000)
  const resumed = await s.fetch('/blob.bin', { headers: { Range: 'bytes=1000-' } })
  assert.equal(resumed.status, 206); assert.equal(resumed.body.length, bytes.length - 1000)
  const again = await s.fetch('/blob.bin')
  assert.equal(again.status, 200); assert.equal(again.body.length, bytes.length)
  assert.equal(s.lines[0].outcome, 'injected-failure'); assert.equal(s.lines[0].bytes, 1000)
  assert.equal(s.lines.filter(line => line.outcome === 'injected-failure').length, 1)
})
