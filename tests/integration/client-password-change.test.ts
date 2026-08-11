/**
 * Changing a password you still know, end to end.
 *
 * Three properties carry this file.
 *
 * **Every OTHER session ends and this one survives.** Reset revokes everything because the requester
 * might be anybody; here they have proved a session, the current password and a code where one
 * exists. The two paths differ because they know different things about who is asking, and both
 * behaviours are asserted so the difference reads as deliberate.
 *
 * **An outstanding reset dies with the change.** The interaction nothing else would catch: a client
 * who asked for a reset and then changed their password from the portal instead would leave a live
 * token in an inbox that sets a password of the holder's choosing over the one just chosen.
 *
 * **A credential change needs a credential** - the current password, and a code wherever a factor is
 * enrolled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  MFA_SECRET_KEY_VARIABLE,
  byPassword,
  MINIMUM_PASSWORD_LENGTH,
  TOTP_STEP_SECONDS,
  authenticateClientUser,
  base32Decode,
  beginMfaEnrolment,
  changeClientPassword,
  completePasswordReset,
  confirmMfaEnrolment,
  disableClientUser,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  issueSession,
  resolveSession,
  totp,
  type RelyingParty,
} from '@bwc/identity';
import { changePassword, principalFromToken } from '@bwc/portal';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const REPLACEMENT = 'an-entirely-different-password';
const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const VERIFICATION = 'Called back on the number on file and confirmed the EIN last four.';

beforeAll(async () => {
  fx = await makeFixture('password-change');
  clientId = (await createClient(fx.tenant.id, 'Change Test LLC', HUMAN())).id;
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

/** A live session, returning its token and id. */
const openSession = async (
  clientUserId: string,
  at = NOW,
): Promise<{ token: string; sessionId: string }> => {
  const session = await issueSession({ tenantId: fx.tenant.id, clientUserId, now: at });
  if (session.status !== 'ok') throw new Error('setup: session');
  return { token: session.value.token, sessionId: session.value.sessionId };
};

describe('the act itself', () => {
  it('replaces the password and retires the old one', async () => {
    const userId = await enrol('changed@example.com');
    const mine = await openSession(userId);

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });
    expect(changed.status).toBe('ok');

    const withOld = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'changed@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(withOld.status).toBe('refused');

    const withNew = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'changed@example.com',
      password: REPLACEMENT,
      now: NOW,
    });
    expect(withNew.status).toBe('ok');
  });

  it('needs the current password, refuses the same password, and holds the length floor', async () => {
    const userId = await enrol('guards@example.com');
    const mine = await openSession(userId);

    const base = {
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      now: NOW,
    };

    // A session is not a credential (ADR-0024). This is the rule that makes the route safe from a
    // stolen cookie.
    const wrongCurrent = await changeClientPassword({
      ...base,
      currentPassword: 'not-the-current-password',
      newPassword: REPLACEMENT,
    });
    expect(wrongCurrent.status).toBe('refused');

    const same = await changeClientPassword({
      ...base,
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(same.status).toBe('refused');

    const short = await changeClientPassword({
      ...base,
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(short.status).toBe('refused');
    if (short.status !== 'refused') throw new Error('unreachable');
    expect(short.reason).toContain(String(MINIMUM_PASSWORD_LENGTH));

    // None of them changed anything.
    const stillWorks = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'guards@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(stillWorks.status).toBe('ok');
  });

  it('refuses a disabled account', async () => {
    const userId = await enrol('disabled-change@example.com');
    const mine = await openSession(userId);

    await disableClientUser({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      reason: 'Engagement ended.',
      actor: HUMAN(),
      now: NOW,
    });

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });
    expect(changed.status).toBe('refused');
  });
});

describe('sessions', () => {
  it('ends every other session and keeps the one that asked', async () => {
    const userId = await enrol('sessions-change@example.com');
    const mine = await openSession(userId);
    const laptop = await openSession(userId);
    const phone = await openSession(userId);

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });
    if (changed.status !== 'ok') throw new Error('change failed');

    expect(changed.value.otherSessionsRevoked).toBe(2);

    for (const gone of [laptop.token, phone.token]) {
      expect((await resolveSession({ tenantId: fx.tenant.id, token: gone, now: NOW })).status).toBe(
        'refused',
      );
    }

    // THE ASSERTION THIS BLOCK EXISTS FOR. Reset revokes everything because the requester might be
    // anybody; here they proved a session and the current password, and signing them out of the
    // action they just took teaches people to avoid the button.
    const still = await resolveSession({ tenantId: fx.tenant.id, token: mine.token, now: NOW });
    expect(still.status).toBe('ok');
  });

  it('is the opposite of a reset, which revokes the requester too', async () => {
    const userId = await enrol('reset-revokes-all@example.com');
    const mine = await openSession(userId);

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
      password: REPLACEMENT,
      now: NOW,
    });
    if (reset.status !== 'ok') throw new Error('reset failed');

    // Both behaviours asserted in one file, so the difference reads as deliberate rather than as
    // one of them being wrong.
    expect(reset.value.sessionsRevoked).toBe(1);
    expect(
      (await resolveSession({ tenantId: fx.tenant.id, token: mine.token, now: NOW })).status,
    ).toBe('refused');
  });
});

describe('an outstanding reset dies with the change', () => {
  it('refuses a reset token issued before the change', async () => {
    const userId = await enrol('reset-then-change@example.com');
    const mine = await openSession(userId);

    // The client asks for a reset, then remembers their password and changes it instead.
    const issued = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (issued.status !== 'ok') throw new Error('setup: issue');

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });
    if (changed.status !== 'ok') throw new Error('change failed');
    expect(changed.value.outstandingResetSpent).toBe(true);

    // THE ASSERTION THIS FILE EXISTS FOR. Without it the token in the inbox sets a password of the
    // holder's choosing over the one the client just chose.
    const late = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: issued.value.token,
      password: 'a-third-password-entirely',
      now: NOW,
    });
    expect(late.status).toBe('refused');

    const stillMine = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'reset-then-change@example.com',
      password: REPLACEMENT,
      now: NOW,
    });
    expect(stillMine.status).toBe('ok');
  });

  it('reports honestly when there was nothing outstanding', async () => {
    const userId = await enrol('no-reset@example.com');
    const mine = await openSession(userId);

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });
    if (changed.status !== 'ok') throw new Error('change failed');
    expect(changed.value.outstandingResetSpent).toBe(false);
  });
});

describe('where a second factor is enrolled', () => {
  const AT = new Date(NOW.getTime() + 5 * TOTP_STEP_SECONDS * 1000);

  /** Enrol a user and an authenticator. */
  const withAuthenticator = async (
    email: string,
  ): Promise<{ userId: string; secret: Buffer; recoveryCodes: readonly string[] }> => {
    const userId = await enrol(email);
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
    return { userId, secret, recoveryCodes: confirmed.value.recoveryCodes };
  };

  it('requires a code, and the password alone is not enough', async () => {
    const { userId, secret } = await withAuthenticator('mfa-change@example.com');
    const mine = await openSession(userId);

    // An attacker holding a session and a shoulder-surfed password is exactly the case the second
    // factor exists for.
    const withoutCode = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: AT,
    });
    expect(withoutCode.status).toBe('refused');

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      code: totp(secret, AT),
      now: AT,
    });
    expect(changed.status).toBe('ok');
  });

  it('spends the code, so it cannot then open a session', async () => {
    const { userId, secret } = await withAuthenticator('mfa-spent@example.com');
    const mine = await openSession(userId);
    const code = totp(secret, AT);

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      code,
      now: AT,
    });
    expect(changed.status).toBe('ok');

    // A code that authorised a credential change and could still open a session would be a code
    // used twice, which is what `lastUsedStep` exists to prevent.
    const reuse = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: REPLACEMENT,
      newPassword: 'a-third-password-entirely',
      code,
      now: AT,
    });
    expect(reuse.status).toBe('refused');
  });

  it('accepts a recovery code in place of an authenticator code', async () => {
    const { userId, recoveryCodes } = await withAuthenticator('mfa-recovery-change@example.com');
    const mine = await openSession(userId);

    const changed = await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      code: recoveryCodes[0] as string,
      now: AT,
    });
    expect(changed.status).toBe('ok');
  });
});

describe('through the portal', () => {
  it('acts on the caller and keeps their own session, resolved rather than supplied', async () => {
    const userId = await enrol('portal-change@example.com');
    const mine = await openSession(userId);
    const other = await openSession(userId);

    const principal = await principalFromToken({
      tenantId: fx.tenant.id,
      token: mine.token,
      now: NOW,
    });
    if (principal.status !== 'ok') throw new Error('resolve failed');
    // The session id comes from `resolveSession`, so a caller cannot name somebody else's and keep
    // it alive.
    expect(principal.value.sessionId).toBe(mine.sessionId);

    const changed = await changePassword({
      principal: principal.value,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
    });
    if (changed.status !== 'ok') throw new Error('change failed');
    expect(changed.value.otherSessionsRevoked).toBe(1);

    expect((await resolveSession({ tenantId: fx.tenant.id, token: mine.token })).status).toBe('ok');
    expect((await resolveSession({ tenantId: fx.tenant.id, token: other.token })).status).toBe(
      'refused',
    );
  });

  it('records the change, with no credential material in the payload', async () => {
    const userId = await enrol('ledger-change@example.com');
    const mine = await openSession(userId);

    await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });

    const events = await read(fx.tenant.id);
    const event = events.find(
      (candidate) =>
        candidate.type === 'identity.client_user.password_changed' &&
        (candidate.payload as { clientUserId?: string }).clientUserId === userId,
    );

    expect(event).toBeDefined();
    // A change and a reset are different acts, and one event type for both would hide which
    // happened.
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(REPLACEMENT);
  });

  it('clears a lockout, because the password being guessed no longer exists', async () => {
    const userId = await enrol('locked-change@example.com');
    const mine = await openSession(userId);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await authenticateClientUser({
        tenantId: fx.tenant.id,
        email: 'locked-change@example.com',
        password: 'wrong-but-long-enough',
        now: NOW,
      });
    }
    expect(
      (await db().clientUser.findFirstOrThrow({ where: { id: userId } })).lockedUntil,
    ).not.toBeNull();

    await changeClientPassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      sessionId: mine.sessionId,
      currentPassword: PASSWORD,
      newPassword: REPLACEMENT,
      now: NOW,
    });

    const after = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(after.lockedUntil).toBeNull();
    expect(after.failedAttempts).toBe(0);
  });
});
