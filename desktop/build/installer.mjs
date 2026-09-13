// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const native = resolve(process.env.KARAOKE_NATIVE_PAYLOAD || resolve(desktop, 'native'))
const manifest = JSON.parse(readFileSync(resolve(native, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8'))
const { BRAND_NAME } = await import(pathToFileURL(resolve(desktop, '../frontend/src/brand.js')))
if (manifest.appVersion !== pkg.version || !existsSync(resolve(native, 'backend.py'))) {
  throw new Error('Assemble a matching native runtime before creating an installer')
}
export default {
  appId: 'org.karaoke.desktop',
  productName: BRAND_NAME,
  executableName: BRAND_NAME,
  directories: { app: desktop, output: resolve(desktop, 'artifacts') },
  files: ['package.json', 'main.mjs', 'preload.cjs', 'policy.mjs', 'lifecycle.mjs', 'runtime_manager.mjs', 'processing_probe.py', 'heart_setup.mjs', 'models.json', 'processing-locks.json'],
  extraResources: [{ from: native, to: 'native', filter: ['**/*'] },
    { from: resolve(desktop, 'models.json'), to: 'native/models.json' },
    { from: resolve(desktop, 'processing-locks.json'), to: 'native/processing-locks.json' }],
  asar: true,
  npmRebuild: false,
  // Builds are private test artifacts; publication is a separate operation.
  publish: null,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  linux: { target: ['AppImage', 'tar.gz'], category: 'AudioVideo' },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.music', minimumSystemVersion: '14.0', identity: null },
  win: { target: ['nsis'], signAndEditExecutable: false },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
}
