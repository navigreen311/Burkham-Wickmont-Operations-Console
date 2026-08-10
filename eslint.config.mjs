import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Node globals, declared once. `no-undef` has no idea this is a Node project, and listing
 * them per-config-block is how one block quietly ends up missing `fetch` and reporting a
 * real typo as the same error as a missing global.
 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      'prisma/migrations/**',
      'packages/*/dist/**',
      'apps/*/dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: NODE_GLOBALS,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Entry points whose stdout is the operator interface, not leftover debugging: the API's
    // startup line, the worker's pass log, and the demo scripts. Library and service code stays
    // under the rule - a console call there is a log line with no scrubbing, in a system where
    // PII must never reach a log sink.
    files: [
      'apps/api/src/server.ts',
      'apps/portal-api/src/server.ts',
      'apps/worker/src/main.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests deliberately construct values the public types forbid, to check runtime behaviour.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
