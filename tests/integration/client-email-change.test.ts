/**
 * Moving the address a client's account lives at, end to end.
 *
 * **The strongest of the three credential operations**, because the address is where a reset link
 * goes: an attacker who moves it keeps the account after the client resets their password, since the
 * reset arrives in the attacker's inbox.
 *
 * Four properties carry this file.
 *
 * **The address moves when the new one answers**, not when the request is made.
 *
 * **Recovering the account cancels a pending move.** The interaction that would otherwise be
 * invisible: an attacker requests a move, the client resets their password, and the attacker
 * presents the token afterwards and takes the recovery channel anyway.
 *
 * **Nothing is revoked.** Sessions and outstanding resets both survive, and both are asserted -
 * because the tempting build, consistent with change-password, kills them and hands the attacker
 * the win.
 *
 * **The record says which kind of proof was obtained** - `email` or `staff_assertion`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  EMAIL_CHANGE_MINUTES,
  byPassword,
  MFA_SECRET_KEY_VARIABLE,
  TOTP_STEP_SECONDS,
  authenticateClientUser,
  base32Decode,
  beginMfaEnrolment,
  changeClientPassword,
  changeEmailForClient,
  completeEmailChange,
  completePasswordReset,
  confirmMfaEnrolment,
  deliverEmailChangeVerification,
  emailHistory,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  issueSession,
  pendingEmailChanges,
  requestEmailChange,
  resolveSession,
  totp,
  type RelyingParty,
} from '@bwc/identity';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-16T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const VERIFICATION = 'Called back on the number on file and confirmed the EIN last four.';

beforeAll(async () => {
  fx = await makeFixture('email-change');
  clientId = (await createClient(fx.tenant.id, 'Address Test LLC', HUMAN())).id;
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

describe('the address moves only when the new one answers', () => {
  it('leaves the account alone until the token is presented', async () => {
    const userId = await enrol('before@example.com');

    const asked = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'after@example.com',
      confirmation: byPassword(PASSWORD),
      rp: RP,
      now: NOW,
    });
    // Nothing delivers it, and the answer says so rather than reporting success.
    expect(asked.status).toBe('not_built');

    // THE ASSERTION. A change to an unreachable address would move recovery to a mailbox nobody
    // reads - a lockout the client discovers on the day they need to get back in.
    const user = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(user.email).toBe('before@example.com');

    const pending = await pendingEmailChanges(fx.tenant.id, userId, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.newEmail).toBe('after@example.com');
  });

  it('moves it, and records that an emailed token proved the address', async () => {
    const userId = await enrol('moves-from@example.com');
    const token = await tokenFor(userId, 'moves-to@example.com');

    const done = await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW });
    if (done.status !== 'ok') throw new Error(`complete failed: ${done.status}`);

    expect(done.value.previousEmail).toBe('moves-from@example.com');
    expect(done.value.newEmail).toBe('moves-to@example.com');
    // The control that matters most here is the one that is missing: the old address cannot be told.
    expect(done.value.oldAddressNotified).toBe(false);

    const signedIn = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'moves-to@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');

    const old = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'moves-from@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(old.status).toBe('refused');

    const history = await emailHistory(fx.tenant.id, userId);
    expect(history[0]?.verifiedBy).toBe('email');
    expect(history[0]?.previousEmail).toBe('moves-from@example.com');
  });

  it('is single use, and expires', async () => {
    const userId = await enrol('single-use-address@example.com');
    const token = await tokenFor(userId, 'single-use-new@example.com');

    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'ok',
    );
    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );

    const other = await enrol('expiring@example.com');
    const stale = await tokenFor(other, 'expired-target@example.com');
    const afterExpiry = new Date(NOW.getTime() + (EMAIL_CHANGE_MINUTES + 1) * 60 * 1000);
    expect(
      (await completeEmailChange({ tenantId: fx.tenant.id, token: stale, now: afterExpiry }))
        .status,
    ).toBe('refused');
  });

  it('refuses an address already in use, without saying why', async () => {
    await enrol('occupied@example.com');
    const userId = await enrol('wants-occupied@example.com');

    const asked = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'occupied@example.com',
      confirmation: byPassword(PASSWORD),
      rp: RP,
      now: NOW,
    });

    expect(asked.status).toBe('refused');
    if (asked.status !== 'refused') throw new Error('unreachable');
    // Confirming that an address belongs to somebody is a fact about a third party this firm holds.
    expect(asked.reason).toBe('That address cannot be used.');
  });

  it('needs the current password, and a code where a factor is enrolled', async () => {
    const userId = await enrol('needs-credentials@example.com');

    const wrongPassword = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'somewhere-else@example.com',
      confirmation: byPassword('not-the-current-password'),
      rp: RP,
      now: NOW,
    });
    expect(wrongPassword.status).toBe('refused');

    const offer = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('setup: begin');
    const secret = base32Decode(offer.value.secret) as Buffer;
    const confirmed = await confirmMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      rp: RP,
      code: totp(secret, NOW),
      now: NOW,
    });
    if (confirmed.status !== 'ok') throw new Error('setup: confirm');

    const at = new Date(NOW.getTime() + 5 * TOTP_STEP_SECONDS * 1000);

    const withoutCode = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'somewhere-else@example.com',
      confirmation: byPassword(PASSWORD),
      rp: RP,
      now: at,
    });
    expect(withoutCode.status).toBe('refused');

    const withCode = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'somewhere-else@example.com',
      confirmation: byPassword(PASSWORD),
      rp: RP,
      code: totp(secret, at),
      now: at,
    });
    expect(withCode.status).toBe('not_built');
  });
});

describe('recovering the account cancels a pending move', () => {
  it('a password reset kills it', async () => {
    const userId = await enrol('hijack-reset@example.com');
    // The attacker, holding a session, asks to move the address to their own.
    const token = await tokenFor(userId, 'attacker-reset@example.com');

    // The client notices something is wrong and resets their password.
    const issued = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (issued.status !== 'ok') throw new Error('setup: issue');
    const reset = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: issued.value.token,
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    if (reset.status !== 'ok') throw new Error('reset failed');

    // THE ASSERTION THIS FILE EXISTS FOR. Without the cancellation the attacker presents the token
    // now and takes the recovery channel anyway - after the client believes they have dealt with it.
    const late = await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW });
    expect(late.status).toBe('refused');

    const user = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(user.email).toBe('hijack-reset@example.com');
  });

  it('a password change kills it too', async () => {
    const userId = await enrol('hijack-change@example.com');
    const token = await tokenFor(userId, 'attacker-change@example.com');

    const session = await issueSession({ tenantId: fx.tenant.id, clientUserId: userId, now: NOW });
    if (session.status !== 'ok') throw new Error('setup: session');

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: session.value.sessionId,
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-portal-password',
      now: NOW,
    });
    if (changed.status !== 'ok') throw new Error('change failed');

    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );
  });

  it('a newer request replaces an older one', async () => {
    const userId = await enrol('two-requests@example.com');
    const first = await tokenFor(userId, 'first-target@example.com');
    const second = await tokenFor(userId, 'second-target@example.com');

    expect(await pendingEmailChanges(fx.tenant.id, userId, NOW)).toHaveLength(1);
    expect(
      (await completeEmailChange({ tenantId: fx.tenant.id, token: first, now: NOW })).status,
    ).toBe('refused');
    expect(
      (await completeEmailChange({ tenantId: fx.tenant.id, token: second, now: NOW })).status,
    ).toBe('ok');
  });
});

describe('nothing is revoked, and that is deliberate', () => {
  it('leaves every session alive', async () => {
    const userId = await enrol('keeps-sessions@example.com');
    const laptop = await issueSession({ tenantId: fx.tenant.id, clientUserId: userId, now: NOW });
    const phone = await issueSession({ tenantId: fx.tenant.id, clientUserId: userId, now: NOW });
    if (laptop.status !== 'ok' || phone.status !== 'ok') throw new Error('setup: sessions');

    const token = await tokenFor(userId, 'keeps-sessions-new@example.com');
    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'ok',
    );

    // THE ASSERTION. Nothing about authentication changed, so revoking sessions would remove the
    // legitimate owner's access and leave an attacker - who holds the session doing the changing -
    // exactly where they were. It is a control that helps the wrong party.
    for (const alive of [laptop.value.token, phone.value.token]) {
      expect(
        (await resolveSession({ tenantId: fx.tenant.id, token: alive, now: NOW })).status,
      ).toBe('ok');
    }
  });

  it('leaves an outstanding password reset alive', async () => {
    const userId = await enrol('keeps-reset@example.com');

    // The reset went to the OLD address, which an attacker does not have. It is the legitimate
    // owner's way back, and killing it would be doing the attacker a favour.
    const issued = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (issued.status !== 'ok') throw new Error('setup: issue');

    const token = await tokenFor(userId, 'keeps-reset-new@example.com');
    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'ok',
    );

    const reset = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: issued.value.token,
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    expect(reset.status).toBe('ok');
  });
});

describe('a staff-assisted move', () => {
  it('needs a Level 3 human and a verification basis', async () => {
    const userId = await enrol('staff-move@example.com');

    const byAgent = await changeEmailForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'staff-moved@example.com',
      changedBy: fx.agent.id,
      verificationBasis: VERIFICATION,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const noBasis = await changeEmailForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'staff-moved@example.com',
      changedBy: fx.human.id,
      verificationBasis: 'phoned',
      actor: HUMAN(),
      now: NOW,
    });
    expect(noBasis.status).toBe('refused');
  });

  it('records staff_assertion, because a phone call proves the person and not the address', async () => {
    const userId = await enrol('assertion-from@example.com');

    const moved = await changeEmailForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'assertion-to@example.com',
      changedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (moved.status !== 'ok') throw new Error('move failed');

    const history = await emailHistory(fx.tenant.id, userId);
    // THE ASSERTION THIS BLOCK EXISTS FOR. When somebody asks later how an account's recovery
    // channel moved, the answer is in a column rather than in an inference.
    expect(history[0]?.verifiedBy).toBe('staff_assertion');
    expect(history[0]?.previousEmail).toBe('assertion-from@example.com');

    const signedIn = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'assertion-to@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');
  });

  it('cancels a pending self-service request', async () => {
    const userId = await enrol('staff-overrides@example.com');
    const token = await tokenFor(userId, 'client-chose@example.com');

    const moved = await changeEmailForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'staff-chose@example.com',
      changedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    expect(moved.status).toBe('ok');

    expect((await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );
  });
});

describe('the record', () => {
  it('names the address in the Ledger and says how it was proved', async () => {
    const userId = await enrol('ledger-address@example.com');
    const token = await tokenFor(userId, 'ledger-address-new@example.com');
    await completeEmailChange({ tenantId: fx.tenant.id, token, now: NOW });

    const events = await read(fx.tenant.id);
    const changed = events.find(
      (event) =>
        event.type === 'identity.client_user.email_changed' &&
        (event.payload as { clientUserId?: string }).clientUserId === userId,
    );

    expect(changed).toBeDefined();
    const payload = changed?.payload as {
      verifiedBy?: string;
      previousEmail?: string;
      oldAddressNotified?: boolean;
    };
    expect(payload.verifiedBy).toBe('email');
    expect(payload.previousEmail).toBe('ledger-address@example.com');
    // Recorded as false rather than omitted: a change logged as done while nobody was told would be
    // the most misleading answer available.
    expect(payload.oldAddressNotified).toBe(false);
  });
});

/**
 * Ask for a move and return the token that would have been emailed.
 *
 * **Through the delivery seam**, which is the one place the token legitimately travels to - the
 * module hands it there and to nobody else, and that is the property being protected. Injecting the
 * seam is how a real provider will be wired in too, so the test exercises the shape production uses
 * rather than a back door written for it.
 */
const tokenFor = async (userId: string, newEmail: string, at = NOW): Promise<string> => {
  let token = '';

  const asked = await requestEmailChange({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    newEmail,
    confirmation: byPassword(PASSWORD),
    rp: RP,
    now: at,
    deliver: async (input) => {
      token = input.token;
      return deliverEmailChangeVerification(input);
    },
  });
  if (asked.status !== 'not_built') throw new Error(`request failed: ${asked.status}`);
  if (token === '') throw new Error('the delivery seam was not reached');

  return token;
};
