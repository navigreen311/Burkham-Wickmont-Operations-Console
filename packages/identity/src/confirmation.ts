/**
 * What counts as confirming who you are, for a credential change - 11.1 Identity & Access.
 *
 * ADR-0024 established the rule: **a session is not a credential**, so enrolling a factor, removing
 * one, changing a password and moving an address all take the password as well as the cookie.
 *
 * That rule assumed a password exists. Once an account can have none (ADR-0030), each of those gates
 * needs a second answer - and seven gates each deciding for themselves what a good answer looks like
 * is how one of them ends up accepting less than the others.
 *
 * So there is one type and one function. **A gate asks whether the caller confirmed themselves; it
 * does not decide what confirmation is.**
 *
 * @see docs/adr/0030-a-passwordless-account-has-no-password.md
 */

import { db } from '@bwc/db';
import { ok, refused, type Outcome } from '@bwc/core';
import { verifyPassword } from './credentials.js';
import { verifyReauthentication, type RelyingParty } from './webauthn.js';

/**
 * A credential presented to authorise a change.
 *
 * A union rather than two optional fields, so **a call site cannot supply neither** and cannot
 * quietly supply both and leave the module to choose which it prefers.
 */
export type Confirmation =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'passkey'; readonly response: Record<string, unknown> };

export const byPassword = (password: string): Confirmation => ({ kind: 'password', password });

export const byPasskey = (response: Record<string, unknown>): Confirmation => ({
  kind: 'passkey',
  response,
});

/**
 * Check a confirmation against an account.
 *
 * **A passkey is accepted on any account, a password only where one exists.** The asymmetry is the
 * point: an account that has removed its password has nothing to check a password against, and
 * accepting one would mean accepting the sentinel value the removal left behind.
 *
 * A passkey confirmation is verified with **user verification required**, exactly as a passwordless
 * sign-in is. A gate that accepted a touch without a PIN would be accepting less than the password
 * it replaces.
 */
export const confirmIdentity = async (input: {
  tenantId: string;
  clientUserId: string;
  confirmation: Confirmation;
  /** Required to check a passkey. A gate that cannot supply it cannot accept one. */
  rp?: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ confirmedWith: 'password' | 'passkey' }>> => {
  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) {
    return refused('That account cannot be changed.', 'Blueprint 11.1 - identity and access');
  }

  if (input.confirmation.kind === 'password') {
    if (user.passwordRemovedAt !== null) {
      return refused(
        'This account has no password. Confirm with a passkey.',
        'Blueprint 11.1 - a credential change needs a credential',
      );
    }
    if (!(await verifyPassword(input.confirmation.password, user.passwordHash))) {
      return refused(
        'That password is not correct.',
        'Blueprint 11.1 - a credential change needs a credential',
      );
    }
    return ok({ confirmedWith: 'password' });
  }

  if (input.rp === undefined) {
    // Not a refusal the caller can fix by trying again: the gate was wired without a relying party,
    // and saying so is more useful than "that passkey could not be used".
    return refused('This action cannot accept a passkey.', 'Blueprint 11.1 - identity and access');
  }

  const asserted = await verifyReauthentication({
    tenantId: input.tenantId,
    clientUserId: input.clientUserId,
    response: input.confirmation.response,
    rp: input.rp,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (asserted.status !== 'ok') return asserted as Outcome<never>;

  return ok({ confirmedWith: 'passkey' });
};
