/**
 * The firm-wide client MFA mandate - 11.7 policy, 11.1 enforcement. ADR-0046.
 *
 * Four properties carry this file.
 *
 * **Off is the default, and off means nothing changed.** The mandate is a parameter a tenant turns
 * on, so a tenant that has never considered it behaves exactly as it did before this slice.
 *
 * **Turning it on is two acts, not one.** It is registered high-risk, so `setParameter` records a
 * STAGED change and the effective value does not move until somebody comes back and promotes it.
 * The test asserts the staged change does not bite, because "staged" that took effect immediately
 * would be a label rather than a control.
 *
 * **The gate does not block the act that clears it** (ADR-0033). A client refused a session for
 * having no second factor can still enrol one with their password, and the sentence they get says
 * so. A mandate that locked people out of the only path back would be discovered by the person it
 * trapped.
 *
 * **The refusal is not an oracle.** It lands after a correct password, never instead of one, so a
 * wrong password under an active mandate still gets the same sentence as every other failure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import {
  CLIENT_MFA_REQUIRED_KEY,
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  beginMfaEnrolment,
  byPassword,
  clientMfaRequired,
  confirmMfaEnrolment,
  enrolClientUser,
  inviteClientUser,
  TOTP_STEP_SECONDS,
  totp,
  type RelyingParty,
} from '@bwc/identity';
import {
  effectiveValue,
  parameterFor,
  promoteStagedChange,
  setParameter,
  stagedChanges,
} from '@bwc/admin';
import { completeSignInMfa, signIn } from '@bwc/portal';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-14T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

/**
 * A moment in a later TOTP time step.
 *
 * Confirming an enrolment spends the step its code came from, so answering a challenge with the
 * same code would be refused as a replay - correctly, and for a reason that has nothing to do with
 * the mandate under test.
 */
const LATER = new Date(NOW.getTime() + 2 * TOTP_STEP_SECONDS * 1000);

beforeAll(async () => {
  fx = await makeFixture('mfa-mandate');
  clientId = (await createClient(fx.tenant.id, 'Mandate Test LLC', HUMAN())).id;
  process.env[MFA_SECRET_KEY_VARIABLE] ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddee00';
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const enrol = async (email: string): Promise<string> => {
  const invited = await inviteClientUser({
    tenantId: fx.tenant.id,
    clientId,
    email,
    displayName: 'A Client Person',
    issuedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (invited.status !== 'ok') throw new Error('setup: invite');

  const enrolled = await enrolClientUser({
    tenantId: fx.tenant.id,
    token: invited.value.token,
    password: PASSWORD,
    actor: HUMAN(),
    now: NOW,
  });
  if (enrolled.status !== 'ok') throw new Error('setup: enrol');
  return enrolled.value.id;
};

/** Add a confirmed authenticator to an existing client user, returning its secret. */
const addAuthenticator = async (userId: string): Promise<Buffer> => {
  const offer = await beginMfaEnrolment({ tenantId: fx.tenant.id, clientUserId: userId, now: NOW });
  if (offer.status !== 'ok') throw new Error(`setup: begin (${offer.status})`);

  const secret = base32Decode(offer.value.secret);
  if (secret === null) throw new Error('setup: secret');

  const confirmed = await confirmMfaEnrolment({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    confirmation: byPassword(PASSWORD),
    rp: RP,
    code: totp(secret, NOW),
    now: NOW,
  });
  if (confirmed.status !== 'ok') throw new Error(`setup: confirm (${confirmed.status})`);
  return secret;
};

/** Turn the mandate on properly: record the change, then promote it out of staging. */
const requireMfa = async (reason: string): Promise<void> => {
  const staged = await setParameter({
    tenantId: fx.tenant.id,
    key: CLIENT_MFA_REQUIRED_KEY,
    value: 1,
    reason,
    changedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (staged.status !== 'ok') throw new Error(`setup: set (${staged.status})`);

  const promoted = await promoteStagedChange({
    tenantId: fx.tenant.id,
    changeId: staged.value.id,
    promotedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (promoted.status !== 'ok') throw new Error(`setup: promote (${promoted.status})`);
};

describe('the mandate is a parameter, and it is off until somebody chooses it', () => {
  it('is registered as configurable rather than absent, and defaults to off', async () => {
    // ADR-0019's test: a parameter is a policy choice with a defensible range. This one is
    // admissible as a parameter precisely because it can only turn a control ON.
    const parameter = parameterFor(CLIENT_MFA_REQUIRED_KEY);
    expect(parameter).not.toBeNull();
    expect(parameter?.compiledDefault).toBe(0);
    expect(parameter?.highRisk).toBe(true);

    expect(await clientMfaRequired(fx.tenant.id)).toBe(false);
  });

  it('lets a client with no second factor hold a session while it is off', async () => {
    const email = 'off-by-default@example.com';
    await enrol(email);

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email,
      password: PASSWORD,
      now: NOW,
    });
    if (signedIn.status !== 'ok') throw new Error(`sign in refused: ${signedIn.status}`);
    expect(signedIn.value.kind).toBe('session');
  });

  it('reads the same answer through 11.7 as through 11.1', async () => {
    // Two readers of one setting is the shape that goes quietly wrong, and this one has two
    // deliberately: `@bwc/admin` already depends on `@bwc/identity`, so the enforcement cannot
    // import the registry back without a package cycle.
    const throughAdmin = await effectiveValue(fx.tenant.id, CLIENT_MFA_REQUIRED_KEY);
    if (throughAdmin.status !== 'ok') throw new Error('effectiveValue failed');

    expect(throughAdmin.value.value === 1).toBe(await clientMfaRequired(fx.tenant.id));
    expect(throughAdmin.value.source).toBe('compiled_default');
  });
});

describe('turning it on', () => {
  it('stages the change, and a staged mandate does not lock anybody out', async () => {
    const email = 'staged-not-applied@example.com';
    await enrol(email);

    const staged = await setParameter({
      tenantId: fx.tenant.id,
      key: CLIENT_MFA_REQUIRED_KEY,
      value: 1,
      reason: 'Rolling out second factors to every client account this quarter.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (staged.status !== 'ok') throw new Error('set failed');

    // Recorded, and deliberately not in force. `effectiveValue` reads applied changes only.
    expect(staged.value.staged).toBe(true);
    expect(staged.value.appliedAt).toBeNull();
    expect(await clientMfaRequired(fx.tenant.id)).toBe(false);
    expect((await stagedChanges(fx.tenant.id)).map((change) => change.key)).toContain(
      CLIENT_MFA_REQUIRED_KEY,
    );

    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    if (signedIn.status !== 'ok') throw new Error('sign in refused while merely staged');
    expect(signedIn.value.kind).toBe('session');

    // Nothing is undone here, and that is the point: a staged change never moved the value, so
    // there is nothing to put back. `rollback` on it would refuse - "it is already 0" - which is
    // the correct answer and worth knowing, because "roll back the change I just made" is what an
    // operator would try first on a mandate they staged by mistake. What they want is to leave it
    // unpromoted.
    const undo = await setParameter({
      tenantId: fx.tenant.id,
      key: CLIENT_MFA_REQUIRED_KEY,
      value: 0,
      reason: 'Trying to undo a change that was only ever staged.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(undo.status).toBe('refused');
    if (undo.status !== 'refused') throw new Error('expected a refusal');
    expect(undo.reason).toMatch(/already 0/);
  });

  it('refuses to seat a client who has no second factor, once promoted', async () => {
    const email = 'no-factor-under-mandate@example.com';
    await enrol(email);

    await requireMfa('Board decision: every client account carries a second factor from today.');
    expect(await clientMfaRequired(fx.tenant.id)).toBe(true);

    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    expect(signedIn.status).toBe('refused');
    if (signedIn.status !== 'refused') throw new Error('expected a refusal');

    // An honest refusal names the reason and the way out, rather than a generic failure the
    // client would read as "my password is wrong".
    expect(signedIn.reason).toMatch(/second factor/i);
    expect(signedIn.reason).toMatch(/does not need a session/i);
    expect(signedIn.principle).toMatch(/ADR-0046/);
  });

  it('still refuses a wrong password with the same sentence as always', async () => {
    // The mandate check sits AFTER the password, so it cannot be used to discover which addresses
    // are real client accounts. A different sentence here would undo what
    // `authenticateClientUser` is careful about.
    const wrong = await signIn({
      tenantId: fx.tenant.id,
      email: 'no-factor-under-mandate@example.com',
      password: 'not-the-right-password',
      now: NOW,
    });
    expect(wrong.status).toBe('refused');
    if (wrong.status !== 'refused') throw new Error('expected a refusal');
    expect(wrong.reason).toBe('Those sign-in details are not correct.');
    expect(wrong.reason).not.toMatch(/second factor/i);

    const unknown = await signIn({
      tenantId: fx.tenant.id,
      email: 'nobody-here@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(unknown.status).toBe('refused');
    if (unknown.status !== 'refused') throw new Error('expected a refusal');
    expect(unknown.reason).toBe('Those sign-in details are not correct.');
  });
});

describe('the gate does not block the act that clears it', () => {
  it('lets a locked-out client enrol a factor and then sign in', async () => {
    const email = 'clears-the-gate@example.com';
    const userId = await enrol(email);

    // Mandate is on from the block above. This client is refused.
    expect(await clientMfaRequired(fx.tenant.id)).toBe(true);
    expect(
      (await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW })).status,
    ).toBe('refused');

    // ADR-0033. Enrolment takes the password and a code, and needs no session - so the way out is
    // open to exactly the person who has just proved they own the account.
    const secret = await addAuthenticator(userId);

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email,
      password: PASSWORD,
      now: LATER,
    });
    if (signedIn.status !== 'ok') throw new Error(`sign in still refused: ${signedIn.status}`);
    // And now they take the ordinary MFA path: a challenge, not a session.
    expect(signedIn.value.kind).toBe('mfa_required');
    if (signedIn.value.kind !== 'mfa_required') throw new Error('expected a challenge');

    const completed = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: signedIn.value.challengeToken,
      code: totp(secret, LATER),
      now: LATER,
    });
    if (completed.status !== 'ok') throw new Error(`challenge failed: ${completed.status}`);
    expect(completed.value.kind).toBe('session');
  });

  it('leaves a client who already holds a factor completely unaffected', async () => {
    const email = 'already-has-one@example.com';
    const userId = await enrol(email);
    const secret = await addAuthenticator(userId);

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email,
      password: PASSWORD,
      now: LATER,
    });
    if (signedIn.status !== 'ok') throw new Error('sign in refused');
    expect(signedIn.value.kind).toBe('mfa_required');
    if (signedIn.value.kind !== 'mfa_required') throw new Error('expected a challenge');

    const completed = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: signedIn.value.challengeToken,
      code: totp(secret, LATER),
      now: LATER,
    });
    expect(completed.status).toBe('ok');
  });
});

describe('turning it back off', () => {
  it('takes a rollback and a promotion, and then seats a factorless client again', async () => {
    const email = 'after-rollback@example.com';
    await enrol(email);

    // Turning it back off is a change like any other - and because the parameter is high-risk,
    // that change is staged too and has to be promoted before it moves anything.
    const applied = await effectiveValue(fx.tenant.id, CLIENT_MFA_REQUIRED_KEY);
    if (applied.status !== 'ok') throw new Error('effectiveValue failed');
    expect(applied.value.value).toBe(1);
    expect(applied.value.source).toBe('configured');

    const off = await setParameter({
      tenantId: fx.tenant.id,
      key: CLIENT_MFA_REQUIRED_KEY,
      value: 0,
      reason: 'Pausing the mandate while the enrolment email goes out to everybody.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (off.status !== 'ok') throw new Error('set failed');
    expect(await clientMfaRequired(fx.tenant.id)).toBe(true);

    const promoted = await promoteStagedChange({
      tenantId: fx.tenant.id,
      changeId: off.value.id,
      promotedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (promoted.status !== 'ok') throw new Error('promote failed');

    expect(await clientMfaRequired(fx.tenant.id)).toBe(false);

    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    if (signedIn.status !== 'ok') throw new Error('sign in refused after rollback');
    expect(signedIn.value.kind).toBe('session');
  });
});
