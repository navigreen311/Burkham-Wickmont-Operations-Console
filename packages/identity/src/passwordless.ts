/**
 * Switching password sign-in off - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * **This file is what makes a passkey a security property rather than a convenience.**
 *
 * A passkey beside a live password does not make an account phishing-resistant. An account is as
 * strong as the weakest method it will accept, and a proxy that takes the password and a code is
 * unaffected by a credential it never asked for. Adding a resistant path does not remove a phishable
 * one - so the feature is not "sign in with a passkey", it is "sign in with a passkey **and turn the
 * other way off**".
 *
 * @see docs/adr/0029-a-passkey-beside-a-password-is-a-convenience.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findActor } from './index.js';
import { verifyPassword } from './credentials.js';
import { issuePasswordReset } from './passwordReset.js';
import { completePasskeySignIn, discoverableKeyCount, type RelyingParty } from './webauthn.js';

/**
 * How many passkeys an account needs before it may switch the password off.
 *
 * Two. **Switching it off with one is one lost object away from having no way in at all**, and the
 * remedy for that is a phone call to the firm - the path this codebase keeps narrowing.
 */
export const PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD = 2;

/** Re-enabling on a client's behalf is a Level 3 human decision. */
export const PASSWORD_SIGN_IN_AUTHORITY_LEVEL = 3;

const MINIMUM_VERIFICATION_BASIS = 10;

export interface PasswordSignInState {
  readonly passwordSignInEnabled: boolean;
  /** Whether a password exists at all. False once it has been removed. */
  readonly hasPassword: boolean;
  readonly discoverableKeys: number;
  /** Whether the account could switch the password off today. */
  readonly mayDisablePassword: boolean;
  /** Whether the account could remove the password outright today. */
  readonly mayRemovePassword: boolean;
}

export const passwordSignInState = async (
  tenantId: string,
  clientUserId: string,
): Promise<PasswordSignInState> => {
  const [user, keys] = await Promise.all([
    db().clientUser.findFirst({ where: { tenantId, id: clientUserId } }),
    discoverableKeyCount(tenantId, clientUserId),
  ]);

  const hasPassword = user != null && user.passwordRemovedAt === null;
  const enabled = user?.passwordSignInDisabledAt == null && hasPassword;

  return {
    passwordSignInEnabled: enabled,
    hasPassword,
    discoverableKeys: keys,
    mayDisablePassword: enabled && keys >= PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD,
    // Removing it is the step AFTER switching it off, never instead of it: an account whose
    // password still signs people in has not shown that anything else can.
    mayRemovePassword: hasPassword && !enabled && keys >= PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD,
  };
};

/**
 * Remove the password outright.
 *
 * Switching password sign-in off (ADR-0029) stopped the password authenticating anybody; the hash
 * stayed, because seven gates asked for it. Now that they take a passkey instead, it can go.
 *
 * **Two independent facts are written.** `passwordRemovedAt` is what every gate reads, and the hash
 * is overwritten with a value that cannot verify - so a column somebody edits back to null cannot
 * resurrect a credential. The weaker fact cannot undo the stronger one.
 *
 * Only ever after password sign-in has been switched off, and only with two passkeys and an
 * assertion. Removing it from an account whose password still signs people in would be a way to
 * lock somebody out with one call.
 */
export const removePassword = async (input: {
  tenantId: string;
  clientUserId: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string }>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.passwordRemovedAt !== null) {
    return refused('This account already has no password.', 'Blueprint 11.1 - identity and access');
  }
  if (user.passwordSignInDisabledAt === null) {
    return refused(
      'Turn password sign-in off first. An account whose password still signs people in has not shown that anything else can.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const keys = await discoverableKeyCount(input.tenantId, user.id);
  if (keys < PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD) {
    return refused(
      `Keep ${PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD} passkeys registered before removing the password.`,
      'Blueprint 11.1 - identity and access',
    );
  }

  const asserted = await completePasskeySignIn({
    tenantId: input.tenantId,
    response: input.response,
    rp: input.rp,
    now,
  });
  if (asserted.status !== 'ok') return asserted as Outcome<never>;
  if (asserted.value.clientUserId !== user.id) {
    return refused(
      'That passkey belongs to a different account.',
      'Blueprint 11.1 - identity and access',
    );
  }

  await db().clientUser.update({
    where: { id: user.id },
    data: {
      passwordRemovedAt: now,
      // Not a hash of anything. `verifyPassword` needs six `$`-separated parts beginning `scrypt`,
      // and this is not that, so nothing verifies against it even if the column above is wrong.
      passwordHash: 'removed',
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_removed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, discoverableKeys: keys },
  });

  return ok({ clientUserId: user.id });
};

/**
 * Give an account a password again, from the Concierge Desk.
 *
 * **The one route back for a client who removed their password and then lost every passkey.** A
 * Level 3 human with a recorded verification basis clears both flags and issues a reset, so the
 * client chooses the password rather than being told one.
 *
 * It is deliberately one act. Re-enabling sign-in, restoring the hash and issuing a reset as three
 * separate calls would leave an account that could be found in two of the three states, and the
 * middle ones are worse than either end.
 */
export const restorePassword = async (input: {
  tenantId: string;
  clientUserId: string;
  restoredBy: string;
  verificationBasis: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string; token: string; expiresAt: string }>> => {
  const now = input.now ?? new Date();

  if (input.verificationBasis.trim().length < MINIMUM_VERIFICATION_BASIS) {
    return refused(
      'Restoring a password needs a record of how you verified who you were speaking to. It undoes the strongest protection this account chose.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const restorer = await findActor(input.restoredBy);
  if (
    !restorer ||
    restorer.kind !== 'human' ||
    restorer.authorityLevel < PASSWORD_SIGN_IN_AUTHORITY_LEVEL
  ) {
    return refused(
      `Restoring a password requires a human at Authority Level ${PASSWORD_SIGN_IN_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 11.1 - identity and access',
    );
  }

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.passwordRemovedAt === null) {
    return refused('This account already has a password.', 'Blueprint 11.1 - identity and access');
  }

  await db().clientUser.update({
    where: { id: user.id },
    data: { passwordRemovedAt: null, passwordSignInDisabledAt: null },
  });

  // The client sets it, not the Concierge Desk. A password read down a telephone is a password two
  // people know.
  const issued = await issuePasswordReset({
    tenantId: input.tenantId,
    clientUserId: user.id,
    issuedBy: input.restoredBy,
    verificationBasis: input.verificationBasis,
    actor: input.actor,
    now,
  });
  if (issued.status !== 'ok') return issued as Outcome<never>;

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_restored',
    actor: input.actor,
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      restoredBy: input.restoredBy,
      verificationBasis: input.verificationBasis.trim(),
    },
  });

  return ok({
    clientUserId: user.id,
    token: issued.value.token,
    expiresAt: issued.value.expiresAt,
  });
};

/**
 * Turn password sign-in off.
 *
 * The password **and** a passkey assertion: it is a credential change (ADR-0024), and the most
 * consequential one an account has. The password proves the client knows what they are giving up;
 * the assertion proves the thing that will replace it works right now, from this browser.
 */
export const disablePasswordSignIn = async (input: {
  tenantId: string;
  clientUserId: string;
  password: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string; discoverableKeys: number }>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.passwordSignInDisabledAt !== null) {
    return refused(
      'Password sign-in is already off for this account.',
      'Blueprint 11.1 - identity and access',
    );
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    return refused(
      'That password is not correct.',
      'Blueprint 11.1 - a credential change needs a credential',
    );
  }

  const keys = await discoverableKeyCount(input.tenantId, user.id);
  if (keys < PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD) {
    return refused(
      `Register ${PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD} passkeys before turning the password off. With one, losing it leaves no way into this account except a call to the Concierge Desk.`,
      'Blueprint 11.1 - identity and access',
    );
  }

  // The assertion is verified as a real passwordless sign-in would be - discoverable, user
  // verified, origin checked. Anything weaker would let a client turn the password off on the
  // strength of a credential that could not then let them back in.
  const asserted = await completePasskeySignIn({
    tenantId: input.tenantId,
    response: input.response,
    rp: input.rp,
    now,
  });
  if (asserted.status !== 'ok') return asserted as Outcome<never>;
  if (asserted.value.clientUserId !== user.id) {
    return refused(
      'That passkey belongs to a different account.',
      'Blueprint 11.1 - identity and access',
    );
  }

  await db().clientUser.update({
    where: { id: user.id },
    data: { passwordSignInDisabledAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_sign_in_disabled',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, discoverableKeys: keys },
  });

  return ok({ clientUserId: user.id, discoverableKeys: keys });
};

/**
 * Turn password sign-in back on.
 *
 * Two routes and no third. A **passkey assertion** - the client still holds one and has changed
 * their mind - or a **Level 3 human** with a recorded verification basis, for the client who holds
 * none and is on the phone.
 *
 * **Deliberately not reachable from a password reset.** A reset arrives through the email channel,
 * and letting it re-enable password sign-in would make that channel a way to undo the client's
 * decision silently - which is exactly the takeover ADR-0027 is about, with the client's own
 * protection as the thing removed.
 */
export const enablePasswordSignIn = async (input: {
  tenantId: string;
  clientUserId: string;
  /** One of the two. */
  response?: Record<string, unknown>;
  rp?: RelyingParty;
  enabledBy?: string;
  verificationBasis?: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string }>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.passwordSignInDisabledAt === null) {
    return refused(
      'Password sign-in is already on for this account.',
      'Blueprint 11.1 - identity and access',
    );
  }

  let byStaff = false;

  if (input.response !== undefined && input.rp !== undefined) {
    const asserted = await completePasskeySignIn({
      tenantId: input.tenantId,
      response: input.response,
      rp: input.rp,
      now,
    });
    if (asserted.status !== 'ok') return asserted as Outcome<never>;
    if (asserted.value.clientUserId !== user.id) {
      return refused(
        'That passkey belongs to a different account.',
        'Blueprint 11.1 - identity and access',
      );
    }
  } else {
    byStaff = true;

    if ((input.verificationBasis ?? '').trim().length < MINIMUM_VERIFICATION_BASIS) {
      return refused(
        'Turning password sign-in back on for a client needs a record of how you verified who you were speaking to. It restores the path that account deliberately closed.',
        'Blueprint 11.1 - identity and access',
      );
    }

    const enabler = input.enabledBy === undefined ? null : await findActor(input.enabledBy);
    if (
      !enabler ||
      enabler.kind !== 'human' ||
      enabler.authorityLevel < PASSWORD_SIGN_IN_AUTHORITY_LEVEL
    ) {
      return refused(
        `Turning password sign-in back on requires a human at Authority Level ${PASSWORD_SIGN_IN_AUTHORITY_LEVEL}. It restores a path the client deliberately closed.`,
        'Blueprint 2.1 with 11.1 - identity and access',
      );
    }
  }

  await db().clientUser.update({
    where: { id: user.id },
    data: { passwordSignInDisabledAt: null },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_sign_in_enabled',
    actor: input.actor,
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      byStaff,
      ...(byStaff
        ? {
            enabledBy: input.enabledBy ?? null,
            verificationBasis: (input.verificationBasis ?? '').trim(),
          }
        : {}),
    },
  });

  return ok({ clientUserId: user.id });
};
