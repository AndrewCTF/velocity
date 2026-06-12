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
);
