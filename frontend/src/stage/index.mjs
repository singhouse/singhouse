// SPDX-License-Identifier: AGPL-3.0-only
// Harness entry point for the clean-room karaoke stage renderer.
//
//   describeFrame(model, timeSeconds, viewport) -> FrameDescriptor
//   normalizeWordSync(json) -> StageModel

export {
  describeFrame,
  computeStageTransform,
  computeReveal,
  computeLeadIn,
  computePageOpacity,
  describeCountdowns,
  validSyllables,
  isValidSyllable,
  STAGE_WIDTH,
  STAGE_HEIGHT,
} from './frame.mjs'

export { normalizeWordSync } from './adapter.mjs'
export { layoutLine, revealEdgeX, lineFont, lineFontPx } from './layout.mjs'
export { drawFrame } from './draw.mjs'
