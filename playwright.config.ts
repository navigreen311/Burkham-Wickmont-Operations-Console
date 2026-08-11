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

  /**
   * Three engines, and only one of them can hold a passkey.
   *
   * **The virtual authenticator is a Chrome DevTools Protocol feature**, so `passkey.spec.ts` skips
   * itself on Firefox and WebKit with a stated reason rather than quietly not existing there. What
   * the other two engines add is the layer Chromium was already covering incidentally: the page's
   * own markup and script, under a real CSP, in engines whose form semantics and DOM behaviour are
   * not Blink's.
   *
   * That is a narrower gain than the Chromium run, and it is worth being clear about rather than
   * letting three green ticks imply three times the coverage.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            // **Firefox only, and only because of `localhost`.** On a CI runner about one Firefox
            // navigation in five hung until the test timed out, on no particular test, while the
            // ones on either side answered in under a second. Changing what the navigation waited
            // for did not help, which puts it below the page: `localhost` resolves to both `::1`
            // and `127.0.0.1`, and Firefox is the only one of the three engines that stalls
            // choosing.
            //
            // The RP ID has to stay `localhost` - a WebAuthn relying party is a domain, never an
            // address - so the harness cannot simply be addressed by IP. Telling Firefox to use one
            // stack removes the choice.
            'network.dns.disableIPv6': true,
            // Playwright drives Firefox through an internal proxy, and `localhost` bypasses a proxy
            // by default - so a navigation to it takes a different path from every other request
            // the harness serves. This is the documented knob for that, and it is the fourth thing
            // tried against a hang that survived listening on both stacks, navigating on
            // `domcontentloaded`, and pinning DNS to one stack.
            'network.proxy.allow_hijacking_localhost': true,
          },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
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
