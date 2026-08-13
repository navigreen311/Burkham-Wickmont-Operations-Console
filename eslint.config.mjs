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
  URLSearchParams: 'readonly',
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
      // The e2e harness. Its stdout is what a human watching a browser run reads.
      'tests/e2e/server.ts',
      'tests/e2e/console-server.ts',
      'apps/worker/src/main.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    /**
     * The two served pages - the Client Portal's and the internal Console's. The only browser code
     * in the repository.
     *
     * Their globals are listed here rather than added to `NODE_GLOBALS`, because `document` and
     * `navigator` existing in server code would be a mistake nobody would catch - the point of
     * `no-undef` is that a global has to be declared somewhere, and where it is declared says where
     * it is allowed to be used.
     *
     * One block for both, because the rule is the same one. Two blocks would be two places to
     * remember when a global is added, and the second is the one that gets forgotten.
     */
    files: ['apps/portal-api/public/**/*.js', 'apps/api/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        // The page dispatches one to tell panel modules a session exists, so they can defer their
        // first authenticated fetch instead of making it before sign-in.
        CustomEvent: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    /**
     * Browser end-to-end specs. Their `page.evaluate` and `addInitScript` callbacks run in the
     * PAGE, so `window` is a global there and nowhere else in `tests/`. Declared for these files
     * only, for the same reason the portal's own page has its own block: where a global is declared
     * says where it is allowed to be used.
     */
    files: ['tests/e2e/**/*.spec.ts'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests deliberately construct values the public types forbid, to check runtime behaviour.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
