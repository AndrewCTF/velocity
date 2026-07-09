// Flat ESLint config for the web console. Scope matches the package's lint
// script (`eslint src --max-warnings=0`): TypeScript correctness rules only —
// formatting is prettier's job, type safety is tsc's job.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Classic hooks rules only. The plugin's "recommended" preset now also
      // ships React-Compiler preview rules (refs-in-render, set-state-in-
      // effect, …) that flag established React 18 subscription patterns this
      // codebase uses deliberately — adopt those with the compiler, not here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The adapters intentionally log operational warnings; everything else
      // must justify a console call inline.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // `catch { /* reason */ }` with an explanatory comment is the local
      // idiom for best-effort upstream calls.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Cesium's option-bag APIs make unavoidable use of `any` at the
      // boundary; tsc --strict already polices our own surface.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Guardrail (CLAUDE.md "Auth"): every browser→backend call goes through
    // apiFetch so auth headers are never forgotten. Raw fetch is reserved for
    // third-party hosts — add the file to the ignores below with a comment
    // naming the host.
    files: ['**/*.{ts,tsx}'],
    ignores: [
      'src/transport/**', // apiFetch's own implementation
      'src/sim/TrafficController.ts', // overpass-api.de (third-party OSM)
      'src/imagery/ChipLayer.tsx', // imagery chip hrefs (third-party STAC)
      '**/*.test.*',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use apiFetch (src/transport/http.ts); raw fetch only for third-party hosts (scoped ignore in eslint.config.js).' },
      ],
    },
  },
  {
    // Guardrail (CLAUDE.md "Refresh smoothness"): this adapter upserts by id;
    // removeAll()+add() re-creates entities every poll, resets the motion
    // model, and makes contacts blink. Deliberate change requires editing this
    // rule, not silencing it.
    files: ['src/globe/adapters/PollGeoJsonAdapter.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name="removeAll"]',
          message: 'PollGeoJsonAdapter is upsert-by-id — removeAll() churns entities (CLAUDE.md refresh-smoothness invariant).',
        },
      ],
    },
  },
);
