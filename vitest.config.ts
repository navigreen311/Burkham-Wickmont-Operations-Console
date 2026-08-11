import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const WORKSPACE_PACKAGES = [
  'core',
  'crypto',
  'db',
  'ledger',
  'identity',
  'tenancy',
  'clients',
  'consent',
  'firewall',
  'integration',
  'middleware',
  'placement',
  'notifications',
  'workflow',
  'claims',
  'scanner',
  'deliverables',
  'vault',
  'intelligence',
  'capital',
  'lenders',
  'outcomes',
  'governance',
  'graph',
  'regulatory',
  'contracts',
  'billing',
  'sales',
  'evidence',
  'comms',
  'risk',
  'partners',
  'calls',
  'marketing',
  'dashboards',
  'interventure',
  'admin',
  'observability',
  'warehouse',
  'portal',
  'workbench',
  'http',
] as const;

export default defineConfig({
  resolve: {
    /**
     * Tests resolve @bwc/* to source, not to dist.
     *
     * Pointing them at built output means an edit that was never rebuilt is tested as if it
     * had shipped - green against code that no longer exists. That failure is silent in both
     * directions, so it is designed out here rather than guarded against with a build step
     * everyone eventually forgets.
     */
    alias: Object.fromEntries(WORKSPACE_PACKAGES.map((name) => [`@bwc/${name}`, pkg(name)])),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    /**
     * One Postgres database is shared across files. Parallel files would interleave writes
     * into the same per-tenant ledger sequence, and the resulting failure would read as a
     * chain break rather than as a test collision.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
