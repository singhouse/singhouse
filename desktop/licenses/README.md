# Supplementary dependency license

`@vue/devtools-api` 6.6.4 omits its MIT license text from the npm archive.
`vue-devtools-api-LICENSE` is copied unmodified from the package's published
`gitHead`, commit `df6ab6bb7791a7a525a97990de73b3ea5e9a1941`:

<https://github.com/vuejs/devtools-v6/blob/df6ab6bb7791a7a525a97990de73b3ea5e9a1941/LICENSE>

The build uses this copy only for that exact package version. Other missing
dependency license texts fail assembly for review.

## Tailwind CSS emitted stylesheet

Tailwind CSS contributes its Preflight reset and generated utility declarations
to the production stylesheet even though npm records it as a development
dependency. The notice collector therefore includes `tailwindcss` explicitly.
It copies the complete, unmodified MIT `LICENSE` from the installed npm package
to `notices/frontend/tailwindcss/LICENSE` and records the installed version and
license in `notices/frontend/inventory.json`.

The current frontend lock pins Tailwind CSS 3.4.19. Its package license credits
Tailwind Labs, Inc.; source provenance is the package's repository,
<https://github.com/tailwindlabs/tailwindcss/tree/v3.4.19>. The npm lock's resolved
archive and integrity identify the package consumed by the build. No separately
maintained license copy is needed because that package includes its license.
