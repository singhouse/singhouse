// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSetupCatalog } from '../setup_catalog.mjs'

export async function prepareSetupCatalog(args) {
  const flags = new Set(['--runtime', '--qualification', '--terms', '--identity', '--output', '--locks', '--models', '--memory'])
  const values = {}
  let privateTestLocalSources = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--private-test-local-sources') { privateTestLocalSources = true; continue }
    if (!flags.has(flag) || values[flag] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid setup catalog argument: ${flag}`)
    values[flag] = args[++i]
  }
  for (const flag of ['--runtime', '--qualification', '--terms', '--identity', '--output']) {
    if (!values[flag]) throw new Error(`Missing ${flag}. Supply an explicit runtime manifest, passed qualification evidence, model terms, application identity, and output path; no qualification result is inferred.`)
  }
  async function json(path, label) {
    try { return JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`) }
  }
  const runtime = await json(values['--runtime'], 'runtime manifest')
  const qualification = await json(values['--qualification'], 'qualification evidence')
  const models = await json(values['--terms'], 'model terms (JSON array)')
  const identity = await json(values['--identity'], 'application identity')
  const locks = await json(values['--locks'] || new URL('../processing-locks.json', import.meta.url), 'application processing locks')
  const modelPolicy = await json(values['--models'] || new URL('../models.json', import.meta.url), 'application model policy')
  const memory = values['--memory'] ? await json(values['--memory'], 'memory evidence') : undefined
  const catalog = createSetupCatalog({ runtime, qualification, models, memory }, { identity, trustedLocks: locks.lockSha256, modelPolicy, privateTestLocalSources })
  // Exclusive creation avoids accidentally replacing a reviewed release input.
  await writeFile(resolve(values['--output']), `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' })
  return catalog
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareSetupCatalog(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
