// SPDX-License-Identifier: AGPL-3.0-only
import { readOnlyAppImageMount, verifiedAppImageRuntime, stableFirstInstallerExecutable } from './recovery_launcher.mjs'

// A mounted AppImage's inner executable can disappear when the old process
// exits. Relaunch its authenticated outer image, retaining the exact arguments
// (including an isolated user-data-dir). Ambient APPIMAGE/APPDIR are not inputs.
export function setupRelaunchOptions({ platform = process.platform, executablePath = process.execPath,
  args = process.argv.slice(1), detectMount = readOnlyAppImageMount, verifyImage = verifiedAppImageRuntime } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Invalid setup relaunch arguments')
  }
  let execPath = executablePath
  if (platform === 'linux' && detectMount({ platform, executablePath })) {
    const verifiedAppImage = verifyImage({ platform, executablePath })
    execPath = stableFirstInstallerExecutable({ platform, executablePath, verifiedAppImage })
  }
  return { execPath, args: [...args] }
}

export function relaunchForSetup(app, options) {
  // All selection/verification must succeed before quitting, so the caller's
  // restartForSetup catch can resume the backend on a rejected relaunch.
  app.relaunch(setupRelaunchOptions(options))
  app.quit()
}
