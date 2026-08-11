/**
 * Browser end-to-end tests for the Client Portal.
 *
 * ADR-0031 named these as the honest gap in the UI slice: the transforms were tested and the DOM
 * layer was read. **The reason to add them is not coverage of the DOM** - it is that a virtual
 * authenticator can do what nothing else in this repository can, and register and use a real
 * passkey through a real browser against the real routes.
 *
 * A separate runner from vitest, and a separate CI job, because it needs a browser binary. Vitest
 * collects `tests/**\/*.test.ts`; these are `.spec.ts`, so neither runner sees the other's files.
 */

import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN, E2E_PORT } from './tests/e2e/fixture.js';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // One worker: the specs share a seeded account, and a second browser signing it in and out
  // underneath the first is a flake nobody would enjoy diagnosing.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: process.env['CI'] !== undefined ? 'list' : 'line',
  timeout: 30_000,

  use: {
    baseURL: E2E_ORIGIN,
    // Kept on failure only. A trace is a copy of the page, and this page shows a client's file.
    trace: 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      // Chromium only, and that is a decision rather than an omission: the virtual authenticator
      // these tests rest on is a Chrome DevTools Protocol feature. A Firefox or WebKit run would
      // cover the DOM layer, which is the layer with the least in it.
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm tsx tests/e2e/server.ts',
    url: `${E2E_ORIGIN}/portal/health`,
    // **Never reused, even locally.** A left-running harness holds a Prisma connection pool against
    // the same development database the vitest suite uses, and a full run immediately after a
    // browser run failed once in exactly that overlap - not reproduced in three runs afterwards.
    // The cause is unproved; the fix is free, and the alternative is a flake nobody can chase.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PORT: String(E2E_PORT) },
  },
});
