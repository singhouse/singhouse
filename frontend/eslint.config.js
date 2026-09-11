// SPDX-License-Identifier: AGPL-3.0-only
// ESLint flat config (ESLint 9+ format; the installed major is 10, where flat
// config is the only supported format).
//
// ADVISORY ONLY. The `lint` job in .github/workflows/ci.yml runs this with
// `continue-on-error: true`, so a violation cannot fail a build. Findings are
// LOG-ONLY there: ESLint ships no GitHub-annotation formatter, so nothing
// appears inline on a pull request — read the job log. ESLint had never
// actually run on this codebase before this config existed (the previous
// `lint` script referenced an uninstalled binary and used the `--ext` flag
// that ESLint 9 removed), so treat the current violation list as a backlog to
// burn down, not a regression.
//
// This file is ESM. package.json deliberately has no `"type": "module"`:
// adding one would change how every other .js file in this package is
// interpreted. Node's module-syntax detection loads this file as ESM anyway
// and prints a MODULE_TYPELESS_PACKAGE_JSON warning while doing so; the
// warning is expected and harmless.

import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    // Flat config ignores are global only when the object has no other keys.
    ignores: [
      'dist/**',
      'node_modules/**',
      // Third-party vendored bundle, shipped as-is with its own LICENSE.
      'public/vendor/**',
      // Stage-harness goldens and fixtures: generated JSON data, not source.
      'tests/stage-harness/goldens/**',
      'tests/stage-harness/fixtures/**',
      // Optional local fixtures; not part of the repository.
      'fixtures/**',
    ],
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // Application source runs in the browser. Node globals are deliberately NOT
  // declared here: merging both environments everywhere would tell `no-undef`
  // that `process`, `require` and `__dirname` are fine in browser code, which
  // is precisely what the rule exists to catch.
  {
    files: ['src/**/*.{js,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Substituted at build time by the bundler's `define`, so it is a real
        // value at runtime even though no source file declares it.
        __AUTH_MULTI__: 'readonly',
      },
    },
  },

  // Build config, scripts and test harnesses genuinely run under Node.
  {
    files: ['*.config.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
