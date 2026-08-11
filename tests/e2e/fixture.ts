/**
 * What the browser tests and the server they run against both need to know.
 *
 * A module rather than a file written at boot: the values are fixed, and a handshake through the
 * filesystem would be a second thing to keep in step for no gain.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode, totp } from '@bwc/identity';

export const E2E_PORT = 4300;

/**
 * `localhost`, deliberately.
 *
 * WebAuthn requires a secure context, and `localhost` is one without a certificate. Any other host
 * would mean TLS in a test harness, which is a thing to keep working rather than a thing being
 * tested.
 */
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const E2E_RP_ID = 'localhost';

export const E2E_EMAIL = 'e2e-client@example.com';

/**
 * One account per test that changes an account.
 *
 * **Registering a key, and above all turning the password off, are permanent.** A spec that shared
 * an account with the next one would leave it in a state the next one did not ask for - and the
 * failure would look like a flake rather than like two tests fighting. Each of these is claimed by
 * exactly one test, named in the spec.
 */
export const E2E_MUTABLE_ACCOUNTS = [
  'e2e-registers@example.com',
  'e2e-passwordless@example.com',
  'e2e-turns-off@example.com',
] as const;
export const E2E_PASSWORD = 'a-long-enough-portal-password';
export const E2E_CLIENT_NAME = 'End To End Holdings LLC';

/**
 * Open the portal.
 *
 * **`domcontentloaded`, not `load`.** `load` waits for every subresource, which makes a navigation
 * depend on a stylesheet finishing rather than on the page being usable - and one Firefox
 * navigation in CI hung there for the full test timeout while the ones on either side of it did
 * not. Every spec asserts against an element, and those assertions wait on their own; waiting for
 * `load` first adds a way to fail that none of them is about.
 */
export const openPortal = async (page: {
  goto: (url: string, options: { waitUntil: 'domcontentloaded' }) => Promise<unknown>;
}): Promise<void> => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
};

/**
 * A display name carrying markup.
 *
 * The page puts every value on the screen with `textContent`, and this is the value that proves it:
 * if anything ever reaches the DOM as markup, this is the string that becomes an element.
 */
/* --- the internal Console ------------------------------------------------- */

/** A second process on a second port. The Console and the portal are separate surfaces (ADR-0022). */
export const E2E_CONSOLE_PORT = 4301;
export const E2E_CONSOLE_ORIGIN = `http://localhost:${E2E_CONSOLE_PORT}`;

/**
 * One Console account per spec that signs in.
 *
 * The same reasoning as `E2E_MUTABLE_ACCOUNTS`, arriving from a different direction. A TOTP code is
 * spent when it is accepted, and a code at or below the last accepted step is refused as a replay -
 * so **one authenticator cannot sign in twice inside thirty seconds**, which is the whole point of
 * the guard and is exactly what a suite of fast specs would try to do. A person waits; a spec does
 * not.
 *
 * Each spec claims one of these by name, so no spec is queueing behind another one's clock.
 */
export const E2E_CONSOLE_ACCOUNTS = [
  'e2e-operator-overview@example.com',
  'e2e-operator-health@example.com',
  'e2e-operator-clients@example.com',
  'e2e-operator-file@example.com',
  'e2e-operator-signout@example.com',
  'e2e-operator-refusal@example.com',
  'e2e-operator-writes-compliance@example.com',
  'e2e-operator-writes-firewall@example.com',
  'e2e-operator-writes-newfile@example.com',
  'e2e-operator-observer@example.com',
  'e2e-operator-placement-refused@example.com',
  'e2e-operator-placement-ok@example.com',
  'e2e-operator-placement-vocabulary@example.com',
  'e2e-operator-inviter@example.com',
  /** The five module panels: 5.1/5.6, 9.1/9.2, 1.2, 1.3, 8.1/8.3. Reads only, so one account does. */
  'e2e-operator-modules@example.com',
] as const;

/**
 * The address the browser journey enrols at.
 *
 * Its Actor is seeded with **no credential at all** - the whole point of that spec is to watch one
 * be created, by the person it belongs to.
 */
export const E2E_INVITEE_EMAIL = 'e2e-invitee@example.com';
export const E2E_INVITEE_PASSWORD = 'a-long-enough-invitee-password';

/**
 * The Authority Level each account holds. Level 3 unless named here.
 *
 * `e2e-operator-observer` is Level 0 on purpose: it is the account that proves the page offers no
 * write it cannot perform, and - more importantly - that the server refuses the write anyway.
 */
export const E2E_CONSOLE_LEVELS: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  'e2e-operator-observer@example.com': 0,
};

export const E2E_CONSOLE_PASSWORD = 'a-long-enough-console-password';

/**
 * Where the Console harness leaves what the specs need.
 *
 * **A handshake through the filesystem, and here it earns its keep.** A staff sign-in needs a code
 * derived from the TOTP secret, and that secret is generated inside `enrolStaffFromInvitation` - which is
 * exactly where it should be generated, so it cannot be a constant agreed in this file. The seeding
 * process is the only one that ever sees it, and the spec process has to compute a code from it.
 *
 * The alternative is an endpoint that hands out a secret, which is a worse thing to have existed
 * than a file in a temp directory that lives for the length of one run.
 */
export const E2E_CONSOLE_HANDOFF = join(tmpdir(), 'bwc-e2e-console.json');

/**
 * One client per spec that CHANGES a client.
 *
 * The same lesson as `E2E_MUTABLE_ACCOUNTS`, reached a third time. A compliance transition and a
 * triggered Firewall are both permanent, so a spec sharing the read-only client would leave the
 * one that reads it asserting against a state it did not ask for - and the failure would look like
 * a flake rather than like two specs fighting over one row.
 *
 * The first entry is the file every read-only spec looks at. Nothing writes to it.
 */
export const E2E_CONSOLE_CLIENTS = [
  'Console End To End Holdings LLC',
  'Console Compliance Subject LLC',
  'Console Firewall Subject LLC',
  // Built so a placement can actually succeed: an approved provider whose box it fits, a primary
  // entity with revenue, a passing compliance state, and consent scoped to E2E_PLACEMENT_REF.
  'Console Placement Subject LLC',
] as const;

/** The one reference the placeable client has authorised. Any other is refused, by design. */
export const E2E_PLACEMENT_REF = 'APP-E2E-001';

export interface ConsoleHandoff {
  readonly tenantId: string;
  /** The base32 secret per account email, as an authenticator would be given it. */
  readonly secrets: Readonly<Record<string, string>>;
  /** The read-only file. Kept for the specs that only look. */
  readonly clientName: string;
  readonly label: string;
  /** An Actor holding no credential, for the enrolment journey. */
  readonly inviteeActorId: string;
}

/**
 * A code for the step AFTER the current one.
 *
 * Not the current step, deliberately: seeding spends one code confirming the authenticator works,
 * and a code at or below the last accepted step is refused as a replay. `verifyTotp` accepts one
 * step of drift in either direction, so a code for the next step verifies now AND is greater than
 * the one enrolment spent - which is what a person who waits half a minute would present.
 */
export const nextStepCode = (
  secretBase32: string,
  stepsAhead = 1,
  now: Date = new Date(),
): string => {
  const secret = base32Decode(secretBase32);
  if (secret === null) throw new Error('the handoff carried an unreadable secret');
  const step = Math.floor(now.getTime() / 1000 / 30) + stepsAhead;
  return totp(secret, new Date(step * 30 * 1000));
};

/**
 * A code for the CURRENT step.
 *
 * For a factor that has never been used - a freshly enrolled one, whose `totpLastUsedStep` is null.
 * Nothing has been spent yet, so the current step is available, and spending it leaves the next one
 * free for the sign-in that follows immediately. Presenting `nextStepCode` twice in a row would be
 * a replay of a code the first call had just spent.
 */
export const currentStepCode = (secretBase32: string): string => nextStepCode(secretBase32, 0);

/** Open the Console. `domcontentloaded` for the reason `openPortal` gives. */
export const openConsole = async (page: {
  goto: (url: string, options: { waitUntil: 'domcontentloaded' }) => Promise<unknown>;
}): Promise<void> => {
  await page.goto(`${E2E_CONSOLE_ORIGIN}/console/`, { waitUntil: 'domcontentloaded' });
};

export const E2E_MESSAGE_WITH_MARKUP = '<img src=x onerror="document.title=\'xss\'">';
