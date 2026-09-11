// SPDX-License-Identifier: AGPL-3.0-only
// Isolates the lazy, bundle-excluded load of the vendored Signalsmith Stretch
// module behind one function, so useAudioEngine obtains the factory through a
// single seam (mockable in tests — a `/vendor/...` dynamic import can't resolve
// under jsdom). The specifier is held in a variable, not a literal, so Rollup
// does not statically resolve this public-directory asset at build time; it's
// fetched at runtime from the served /vendor path. The module has its WASM
// embedded as a base64 data-URI and self-registers its AudioWorklet, so nothing
// else needs to know where it lives.
//
// Returns the module's default export: an async factory
// `SignalsmithStretch(audioCtx, options?)` -> Promise<StretchNode>.
export async function loadStretchFactory() {
  const modUrl = '/vendor/signalsmith/SignalsmithStretch.mjs'
  const mod = await import(/* @vite-ignore */ modUrl)
  return mod.default
}
