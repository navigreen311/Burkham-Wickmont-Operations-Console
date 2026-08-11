/**
 * The conversions a WebAuthn ceremony needs in a browser.
 *
 * **This is where a browser integration is actually wrong or right.** The server sends and expects
 * base64url strings; `navigator.credentials` sends and expects `ArrayBuffer`s, and it does not
 * complain about a string - it produces a credential for the wrong challenge, or a signature over
 * bytes nobody asked for.
 *
 * It needs no DOM, so it does not have one: this file is imported by the page and by a test, and the
 * test is the only reason to trust it.
 */

/** base64url -> ArrayBuffer. */
export const fromBase64Url = (value) => {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes.buffer;
};

/** ArrayBuffer -> base64url, unpadded, which is what the server stores and compares. */
export const toBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

/**
 * Turn registration options from the server into what `navigator.credentials.create()` takes.
 *
 * `challenge`, `user.id` and every id in `excludeCredentials` are buffers to the browser and strings
 * on the wire. Missing one of them is the failure this function exists to prevent, and it is the
 * kind that produces a working-looking ceremony against the wrong value.
 */
export const registrationOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  user: { ...options.user, id: fromBase64Url(options.user.id) },
  excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
    ...credential,
    id: fromBase64Url(credential.id),
  })),
});

/** The same, for `navigator.credentials.get()`. */
export const authenticationOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
    ...credential,
    id: fromBase64Url(credential.id),
  })),
});

/**
 * Turn what the browser produced into what the server verifies.
 *
 * `id` is already a base64url string on the credential; `rawId` and everything in `response` are
 * buffers. `transports` comes from a method rather than a property, and an authenticator that does
 * not implement it is not an error - it is a credential the browser will simply prompt for less
 * cleverly next time.
 */
export const registrationResponse = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  response: {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    attestationObject: toBase64Url(credential.response.attestationObject),
    transports: credential.response.getTransports?.() ?? [],
  },
});

export const authenticationResponse = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  response: {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    authenticatorData: toBase64Url(credential.response.authenticatorData),
    signature: toBase64Url(credential.response.signature),
    // Present only for a discoverable credential, and it is what tells the server whose account this
    // is with nothing typed. Omitted rather than sent as null: the server reads a string or nothing.
    ...(credential.response.userHandle
      ? { userHandle: toBase64Url(credential.response.userHandle) }
      : {}),
  },
});
