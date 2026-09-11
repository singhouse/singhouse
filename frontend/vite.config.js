// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { BRAND_NAME, BRAND_TAGLINE } from './src/brand.js'

// index.html sits outside the JS bundle, so it cannot import @/brand. Keep the
// brand strings in the one module anyway and substitute the %BRAND_*%
// placeholders at transform time.
const brandHtml = () => ({
  name: 'brand-html',
  transformIndexHtml: (html) =>
    html
      .replaceAll('%BRAND_NAME%', BRAND_NAME)
      .replaceAll('%BRAND_TAGLINE%', BRAND_TAGLINE)
})

export default defineConfig({
  plugins: [vue(), brandHtml()],
  // Compile-time auth-mode flag. A literal boolean so Rollup folds the
  // `if (__AUTH_MULTI__)` branch in main.js and DROPS the premium dynamic
  // import from the default (core) build entirely — no premium JS ships to the
  // public core dist. `build:multi` sets VITE_AUTH_MODE=multi to flip it true.
  define: {
    __AUTH_MULTI__: JSON.stringify(process.env.VITE_AUTH_MODE === 'multi')
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@premium': resolve(__dirname, '../premium/frontend/src')
    },
    // Premium frontend files live outside this root and have no node_modules of
    // their own; resolve shared runtime deps from the frontend root. This is
    // also what makes a bare import in an out-of-root file resolve AT ALL —
    // vuedraggable is on the list because the premium queue panel imports it
    // (the dependency itself stays declared here, where the build runs).
    dedupe: ['vue', 'vue-router', 'pinia', 'axios', 'vuedraggable']
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true
      },
      '/stems': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
