/**
 * Managing a second factor from the portal - 11.10 over 11.1.
 *
 * Thin, as `signIn` is. The portal decides nothing here either: every rule about what a credential
 * change costs lives in 11.1, and these functions exist only to bind the acting principal to the
 * account being changed.
 *
 * **That binding is the one rule the portal does enforce**: `principal.actorId` is the client user
 * resolved from the session cookie, so a caller cannot name somebody else's account. It is the same
 * rule the document routes follow, and the reason none of these take a client user id.
 */

import {
  beginMfaEnrolment,
  changeClientPassword,
  completeEmailChange,
  confirmMfaEnrolment,
  disableMfa,
  mfaStatus,
  regenerateRecoveryCodes,
  requestEmailChange,
  type CompletedEmailChange,
  type ConfirmedEnrolment,
  type EmailChangeAcknowledgement,
  type EnrolmentOffer,
  type MfaStatus,
  type PasswordChanged,
} from '@bwc/identity';
import type { Outcome } from '@bwc/core';
import type { ClientPrincipal } from './views.js';

export const mfaSettings = async (principal: ClientPrincipal): Promise<MfaStatus> =>
  mfaStatus(principal.tenantId, principal.actorId);

/** Start enrolling. Produces a secret that authenticates nothing until a code confirms it. */
export const startAuthenticatorEnrolment = async (
  principal: ClientPrincipal,
): Promise<Outcome<EnrolmentOffer>> =>
  beginMfaEnrolment({ tenantId: principal.tenantId, clientUserId: principal.actorId });

/**
 * Finish enrolling.
 *
 * Takes the password as well as a code, because a session is not a credential and this changes one.
 */
export const confirmAuthenticator = async (input: {
  principal: ClientPrincipal;
  password: string;
  code: string;
}): Promise<Outcome<ConfirmedEnrolment>> =>
  confirmMfaEnrolment({
    tenantId: input.principal.tenantId,
    clientUserId: input.principal.actorId,
    password: input.password,
    code: input.code,
  });

/** Remove your own authenticator: the password AND a current code, or a recovery code. */
export const removeAuthenticator = async (input: {
  principal: ClientPrincipal;
  password: string;
  code: string;
}): Promise<Outcome<{ factorId: string }>> =>
  disableMfa({
    tenantId: input.principal.tenantId,
    clientUserId: input.principal.actorId,
    password: input.password,
    code: input.code,
  });

/**
 * Change a password you still know.
 *
 * Different from a reset and deliberately so: the current password is required, a code is required
 * where a factor exists, and **every other session ends while this one survives** - the caller has
 * proved who they are, and signing them out of the action they just took teaches people to avoid
 * the button.
 */
export const changePassword = async (input: {
  principal: ClientPrincipal;
  currentPassword: string;
  newPassword: string;
  code?: string;
}): Promise<Outcome<PasswordChanged>> =>
  changeClientPassword({
    tenantId: input.principal.tenantId,
    clientUserId: input.principal.actorId,
    // From the resolved session, never from the request body.
    sessionId: input.principal.sessionId,
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    ...(input.code !== undefined ? { code: input.code } : {}),
  });

/**
 * Ask to move the address this account lives at.
 *
 * **The strongest thing a client can do to their own account**, because the address is where a reset
 * link goes. Nothing moves until a token delivered to the new address comes back - a change to an
 * unreachable address would move recovery to a mailbox nobody reads.
 */
export const requestAddressChange = async (input: {
  principal: ClientPrincipal;
  newEmail: string;
  currentPassword: string;
  code?: string;
}): Promise<Outcome<EmailChangeAcknowledgement>> =>
  requestEmailChange({
    tenantId: input.principal.tenantId,
    clientUserId: input.principal.actorId,
    newEmail: input.newEmail,
    currentPassword: input.currentPassword,
    ...(input.code !== undefined ? { code: input.code } : {}),
  });

/**
 * Present the token that arrived at the new address.
 *
 * Unauthenticated by design: it is answered from the new mailbox, which may not be the browser
 * holding the session. The token is the whole of the authorisation, which is why it is short-lived
 * and single use.
 */
export const confirmAddressChange = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<CompletedEmailChange>> => completeEmailChange(input);

/** A fresh set of recovery codes, retiring the old ones. */
export const newRecoveryCodes = async (input: {
  principal: ClientPrincipal;
  password: string;
}): Promise<Outcome<{ recoveryCodes: readonly string[] }>> =>
  regenerateRecoveryCodes({
    tenantId: input.principal.tenantId,
    clientUserId: input.principal.actorId,
    password: input.password,
  });
