<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup>
// The product mark: a bar-sign house plate holding a microphone. The drawing
// is the ONLY copy of the logo geometry in the repo -- the favicon is an
// export of it and the CD+G attribution card is rasterised FROM this file
// (backend/scripts/gen-card-asset.py parses it), so a redraw here must be
// followed by regenerating that asset; the backend test suite fails otherwise.
//
// Colours are the three brand tokens with literal fallbacks (the generator
// reads the fallbacks). Every colour plane is painted with fills only, so the
// mark rasterises identically at any size with no stroke scaling surprises.
import { computed } from 'vue'
import { BRAND_NAME } from '@/brand'

const props = defineProps({
  // A number is pixels; a string is any CSS length expression (clamp(),
  // vmin, ...). Either way it is applied as CSS, never as SVG width/height
  // attributes, which take plain lengths only.
  size: { type: [Number, String], default: 32 },
  decorative: { type: Boolean, default: false },
})

const cssSize = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
)
</script>

<template>
  <svg
    class="brand-mark-svg"
    :style="{ width: cssSize, height: cssSize }"
    viewBox="0 0 512 512"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : BRAND_NAME"
    :aria-hidden="decorative ? 'true' : undefined"
  >
    <defs>
      <clipPath id="brand-mark-ball"><circle cx="0" cy="0" r="100" /></clipPath>
    </defs>
    <!-- plate: frame, keyline, field -->
    <path fill="var(--brand-cherry, #E23E57)" d="M231.18 50.2Q256 30 280.82 50.2L460 196L460 434Q460 478 416 478L96 478Q52 478 52 434L52 196Z" />
    <path fill="var(--brand-cream, #F7E7C8)" d="M242.04 92.93Q256 81.57 269.96 92.93L420 215.02L420 416Q420 438 398 438L114 438Q92 438 92 416L92 215.02Z" />
    <path fill="var(--brand-ink, #141821)" d="M245.14 105.88Q256 97.04 266.86 105.88L408 220.73L408 408Q408 426 390 426L122 426Q104 426 104 408L104 220.73Z" />
    <!-- microphone -->
    <g transform="translate(238 214) rotate(-26) scale(0.62)">
      <g fill="var(--brand-ink, #141821)" stroke="var(--brand-ink, #141821)" stroke-width="26" stroke-linejoin="round">
        <circle cx="0" cy="0" r="100" />
        <path d="M -50 88 L 50 88 L 43 300 A 43 43 0 0 1 -43 300 Z" />
        <rect x="-64" y="70" width="128" height="48" rx="16" />
      </g>
      <path fill="var(--brand-cherry, #E23E57)" d="M -50 88 L 50 88 L 43 300 A 43 43 0 0 1 -43 300 Z" />
      <circle cx="0" cy="0" r="100" fill="var(--brand-cream, #F7E7C8)" />
      <rect fill="var(--brand-cream, #F7E7C8)" x="-64" y="70" width="128" height="48" rx="16" />
      <g clip-path="url(#brand-mark-ball)" fill="var(--brand-ink, #141821)">
        <rect x="-100" y="-64" width="200" height="28" />
        <rect x="-100" y="-20" width="200" height="28" />
        <rect x="-100" y="24" width="200" height="28" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.brand-mark-svg { display: block; flex: none; }
</style>
