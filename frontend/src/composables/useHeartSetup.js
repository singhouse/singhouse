// SPDX-License-Identifier: AGPL-3.0-only

/** Called only from an explicit action that needs local Heart transcription. */
export async function prepareHeart(model = 'heart') {
  if (model !== 'heart' || !globalThis.window?.karaokeDesktop?.isDesktop) return
  const desktop = window.karaokeDesktop
  if (typeof desktop.prepareHeart !== 'function') {
    throw new Error('Heart model setup is unavailable in this desktop version.')
  }
  const result = await desktop.prepareHeart()
  if (result?.restartRequired) {
    throw new Error('Heart model installed. Reopen the app, then retry this action. Your library is unchanged.')
  }
  if (result?.installed !== true) {
    throw new Error(result?.reason || 'Heart model setup was cancelled. Nothing was queued.')
  }
}
