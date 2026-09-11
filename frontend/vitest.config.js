// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  // Mirror vite.config's compile-time flag. Tests exercise the core (single-
  // host) bundle, so the auth-mode literal is false.
  define: {
    __AUTH_MULTI__: 'false',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // Mirrors the real build's resolution for out-of-root packages.
    dedupe: ['vue', 'vue-router', 'pinia', 'axios'],
  },
  test: {
    // Core tests are pure node; component tests opt into happy-dom via a
    // `// @vitest-environment happy-dom` docblock at the top of the file.
    environment: 'node',
    // Core tests ONLY. The premium suite has its own config and its own
    // runner (premium/frontend/vitest.config.js) — nothing under frontend/ may
    // reference premium/, because the public build excludes that directory
    // outright.
    include: ['tests/**/*.test.js'],
  },
})
