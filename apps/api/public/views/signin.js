/**
 * Signing in to the Console with a security key - ADR-0059.
 *
 * ## Why this file also holds the encoding
 *
 * **This is where a WebAuthn integration is actually wrong or right.** The server sends and expects
 * base64url strings; `navigator.credentials` sends and expects `ArrayBuffer`s, and it does not
 * complain about a string - it produces a credential for the wrong challenge, or a signature over
 * bytes nobody asked for. The failure looks like a working ceremony.
 *
 * The portal keeps these transforms in `encoding.js` and unit-tests them against payloads a real
 * software authenticator produced. This Console has no such file and this slice does not own one, so
 * the transforms live here and `views/security.js` imports them rather than keeping a second copy -
 * two copies of a base64url decoder is how one of them ends up padding differently.
 *
 * ## Everything on the page goes on with textContent
 *
 * Nothing is ever assigned to a markup-writing property. A structural test asserts the alternatives
 * appear nowhere in this directory, which is why this comment describes the rule without naming
 * them.
 */

const $ = (id) => document.getElementById(id);

/* --- encoding, exported for views/security.js ------------------------------ */

export const toBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export const fromBase64Url = (value) => {
  // Padding restored before decoding: the server stores the unpadded form, and `atob` needs the
  // length to be a multiple of four.
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

/** Turn the server's registration options into what the browser will accept. */
export const registrationOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  user: { ...options.user, id: fromBase64Url(options.user.id) },
  excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
    ...credential,
    id: fromBase64Url(credential.id),
  })),
});

/** Turn what the browser hands back into what the server verifies. */
export const registrationResponse = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    attestationObject: toBase64Url(credential.response.attestationObject),
    transports:
      typeof credential.response.getTransports === 'function'
        ? credential.response.getTransports()
        : [],
  },
});

export const authenticationOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
    ...credential,
    id: fromBase64Url(credential.id),
  })),
});

export const authenticationResponse = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    authenticatorData: toBase64Url(credential.response.authenticatorData),
    signature: toBase64Url(credential.response.signature),
    // Present on a discoverable assertion and absent otherwise. It is what says whose account this
    // is with nothing typed, so it is omitted rather than sent as null.
    ...(credential.response.userHandle === null || credential.response.userHandle === undefined
      ? {}
      : { userHandle: toBase64Url(credential.response.userHandle) }),
  },
});

export const call = async (path, body) => {
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
    : { ok: false, reason: payload.reason ?? 'Something went wrong.' };
};

/** Whether this browser can do WebAuthn at all. Said out loud rather than failing on the click. */
export const webauthnAvailable = () =>
  typeof window.PublicKeyCredential === 'function' &&
  typeof navigator.credentials?.get === 'function';

/* --- the sign-in button ---------------------------------------------------- */

const button = $('sign-in-passkey');
const notice = $('passkey-notice');

/**
 * Guarded, because `views/security.js` imports this module for the transforms above and a page that
 * did not carry the button would throw on load.
 */
if (button !== null && notice !== null) {
  if (!webauthnAvailable()) {
    // A browser with no WebAuthn is told so, rather than being given a button that fails when
    // pressed. The password path is still there for exactly this case - until the account turns it
    // off, which is the trade ADR-0059 states.
    button.hidden = true;
    notice.textContent =
      'This browser cannot use a security key. Sign in with your password and a code.';
  }

  button.addEventListener('click', async () => {
    notice.textContent = '';

    const options = await call('/api/console/sign-in/passkey/options', {});
    if (!options.ok) {
      notice.textContent = options.reason;
      return;
    }

    let credential;
    try {
      credential = await navigator.credentials.get({
        publicKey: authenticationOptions(options.data.options),
      });
    } catch {
      // A cancelled prompt and a refused key look the same here and are the same to the operator:
      // nothing happened. The server is what decides whether an assertion is good.
      notice.textContent = 'No security key was presented.';
      return;
    }
    if (!credential) {
      notice.textContent = 'No security key was presented.';
      return;
    }

    const result = await call('/api/console/sign-in/passkey', {
      response: authenticationResponse(credential),
    });

    if (!result.ok) {
      notice.textContent = result.reason;
      return;
    }

    // The session cookie is already set. Reloading is what hands the page to `console.js`, which
    // reads `me` on start and opens the overview - rather than this module reaching into another
    // module's view switcher, which it does not own.
    window.location.reload();
  });
}
