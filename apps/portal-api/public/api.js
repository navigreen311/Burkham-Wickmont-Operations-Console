/**
 * One function per route the portal serves.
 *
 * No logic beyond the shape of the `Outcome` envelope: `{status, data}` on success, `{status,
 * reason}` otherwise. The status name is in the body as well as the code, deliberately - ADR-0002 -
 * so this file reads the name and never infers meaning from a number.
 *
 * `credentials: 'same-origin'` is the default for a same-origin request and is written out anyway,
 * because the session cookie is the whole of the authentication and a reader should not have to
 * remember a default to know that.
 */

const call = async (path, body) => {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));

  return payload.status === 'ok'
    ? { ok: true, data: payload.data }
    : // `not_built` is a 501 and says which capability is missing; it is shown to the client as
      // written, because a seam that says "no email provider is gated in" is more use than "sorry".
      { ok: false, reason: payload.reason ?? 'Something went wrong.', status: payload.status };
};

export const signIn = (email, password) => call('/portal/sign-in', { email, password });
export const signInMfa = (code) => call('/portal/sign-in/mfa', { code });
export const signInKeyOptions = () => call('/portal/sign-in/key/options', {});
export const signInKey = (response) => call('/portal/sign-in/key', { response });
export const passkeyOptions = () => call('/portal/sign-in/passkey/options', {});
export const passkeySignIn = (response) => call('/portal/sign-in/passkey', { response });
export const signOut = () => call('/portal/sign-out', {});

export const requestReset = (email) => call('/portal/password-reset', { email });
export const completeReset = (token, password) =>
  call('/portal/password-reset/complete', { token, password });

export const room = () => call('/portal/room');
export const sendMessage = (subject, body) => call('/portal/messages', { subject, body });

export const mfa = () => call('/portal/mfa');
export const keys = () => call('/portal/mfa/keys');
export const keyRegistrationOptions = (discoverable) =>
  call('/portal/mfa/keys/register', { discoverable });
export const registerKey = (confirmation, label, response, discoverable) =>
  call('/portal/mfa/keys', { ...confirmation, label, response, discoverable });

export const passwordSignIn = () => call('/portal/password-sign-in');
export const disablePasswordSignIn = (password, response) =>
  call('/portal/password-sign-in/disable', { password, response });
export const removePassword = (response) =>
  call('/portal/password-sign-in/remove-password', { response });

export const changePassword = (currentPassword, newPassword, code) =>
  call('/portal/password', { currentPassword, newPassword, ...(code ? { code } : {}) });
export const changeEmail = (newEmail, confirmation, code) =>
  call('/portal/email', { newEmail, ...confirmation, ...(code ? { code } : {}) });
export const confirmEmail = (token) => call('/portal/email/confirm', { token });
export const recoveryCodes = (confirmation) => call('/portal/mfa/recovery-codes', confirmation);
