/**
 * Browser end-to-end tests for the Client Portal and the internal Console.
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
import { E2E_CONSOLE_ORIGIN, E2E_CONSOLE_PORT, E2E_ORIGIN, E2E_PORT } from './tests/e2e/fixture.js';

/**
 * What each engine runs, and which of them CI installs.
 *
 * **CI installs Chromium and nothing else.** Firefox and WebKit found no defect of their own across
 * the runs they were present for, and the browser job's time is dominated by installing them rather
 * than by running anything.
 *
 * What that costs is smaller than it sounds, and worth stating exactly. `cross-browser.spec.ts` -
 * the Content-Security-Policy actually being enforced, and the page's no-WebAuthn fallback - **still
 * runs on every CI run**, in Chromium. What stops being continuously verified is the *cross-engine*
 * half of it: that Gecko and WebKit enforce the policy too.
 *
 * That half is a **manual check**, not a covered one:
 *
 * ```
 * pnpm exec playwright install firefox webkit
 * E2E_ALL_ENGINES=1 pnpm test:e2e
 * ```
 *
 * It is opt-in rather than deleted so the answer is reproducible on demand rather than re-derived,
 * and it is called a manual check rather than left to read as coverage - a control nobody runs is
 * not a control.
 */
const CROSS_ENGINE = /(cross-browser|passkey)\.spec\.ts$/u;

/** Opt in with `E2E_ALL_ENGINES=1`. CI does not. */
const ALL_ENGINES = process.env['E2E_ALL_ENGINES'] !== undefined;

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Present only when asked for. See the note above `CROSS_ENGINE`.
    ...(ALL_ENGINES
      ? [
          {
            name: 'firefox',
            testMatch: CROSS_ENGINE,
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
          { name: 'webkit', testMatch: CROSS_ENGINE, use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],

  /**
   * Two servers, because there are two processes.
   *
   * The Console and the Client Portal are separate deployments on separate trust boundaries
   * (ADR-0022). A harness that served both from one would be testing an architecture this system
   * does not have - and the property the portal test rests on, that it serves no internal
   * capability, would stop being true of the thing under test.
   *
   * **Never reused, even locally.** A left-running harness holds a Prisma connection pool against
   * the same development database the vitest suite uses, and a full run immediately after a browser
   * run failed once in exactly that overlap - not reproduced in three runs afterwards. The cause is
   * unproved; the fix is free, and the alternative is a flake nobody can chase.
   */
  webServer: [
    {
      command: 'pnpm tsx tests/e2e/server.ts',
      url: `${E2E_ORIGIN}/portal/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PORT: String(E2E_PORT) },
    },
    {
      command: 'pnpm tsx tests/e2e/console-server.ts',
      // The Console's liveness route, which is unauthenticated and says nothing about components.
      url: `${E2E_CONSOLE_ORIGIN}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PORT: String(E2E_CONSOLE_PORT) },
    },
  ],
});
