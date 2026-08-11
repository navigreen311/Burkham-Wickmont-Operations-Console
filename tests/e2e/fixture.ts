/**
 * What the browser tests and the server they run against both need to know.
 *
 * A module rather than a file written at boot: the values are fixed, and a handshake through the
 * filesystem would be a second thing to keep in step for no gain.
 */

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
 * A display name carrying markup.
 *
 * The page puts every value on the screen with `textContent`, and this is the value that proves it:
 * if anything ever reaches the DOM as markup, this is the string that becomes an element.
 */
export const E2E_MESSAGE_WITH_MARKUP = '<img src=x onerror="document.title=\'xss\'">';
