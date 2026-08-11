/**
 * The staff security view - registering keys, and turning the phishable path off.
 *
 * **The sentence this page exists to avoid printing is "2 keys registered" in green.** Registering
 * keys changes nothing about phishing while a password and a code still sign the account in: the
 * proxy never asks for the key, so its resistance is never engaged (ADR-0029). So the posture line
 * comes from the server, says which of the two states the account is actually in, and the word
 * "phishing resistant" appears only when it is true.
 *
 * The transforms come from `./signin.js` rather than being copied. Two base64url decoders in one
 * directory is how one of them ends up padding differently, and that failure looks like a working
 * ceremony.
 */

import {
  authenticationOptions,
  authenticationResponse,
  call,
  registrationOptions,
  registrationResponse,
  webauthnAvailable,
} from './signin.js';

const $ = (id) => document.getElementById(id);

const list = (id, items, empty) => {
  const element = $(id);
  element.replaceChildren();

  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = empty;
    element.append(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    element.append(li);
  }
};

const notice = (text) => {
  $('security-notice').textContent = text;
};

/**
 * Ask for an assertion from a key already on the account.
 *
 * Every change here takes one, or a code: a live session is not enough, because a key added from a
 * stolen session is a key the thief holds and the owner never hears about.
 */
const reauthenticate = async () => {
  const options = await call('/api/console/security/reauthentication', {});
  if (!options.ok) return { ok: false, reason: options.reason };

  let credential;
  try {
    credential = await navigator.credentials.get({
      publicKey: authenticationOptions(options.data.options),
    });
  } catch {
    return { ok: false, reason: 'No security key was presented.' };
  }
  if (!credential) return { ok: false, reason: 'No security key was presented.' };

  return { ok: true, passkey: authenticationResponse(credential) };
};

/** The confirmation for a change: the password if given, otherwise a key the operator holds. */
const confirmation = async () => {
  const password = $('security-password').value;
  if (password !== '') return { ok: true, body: { password } };

  const asserted = await reauthenticate();
  return asserted.ok ? { ok: true, body: { passkey: asserted.passkey } } : asserted;
};

const render = (data) => {
  // One sentence, from the server, saying which state this account is in. Never a count on its own.
  $('security-posture').textContent = data.posture;

  $('security-summary').textContent =
    `${data.keyTotal} key(s) registered. Password sign-in is ${
      data.passwordSignInEnabled ? 'ON' : 'OFF'
    }${data.passwordSignInDisabledAt === null ? '' : ` since ${data.passwordSignInDisabledAt}`}.`;

  list(
    'security-keys',
    data.keys.map(
      (key) =>
        `${key.label} — registered ${key.registeredAt} — ${
          key.lastUsedAt === null ? 'never used' : `last used ${key.lastUsedAt}`
        }`,
    ),
    'No security key is registered. This account signs in with a password and a code.',
  );

  // What is still needed before the switch is offered, and what the switch costs. Both from the
  // server, because both are the module's rules.
  $('security-switch-state').textContent = data.passwordSignInEnabled
    ? data.keysNeededToDisablePassword > 0
      ? `${data.keysNeededToDisablePassword} more key(s) needed before password sign-in can be turned off. ${data.keysRequiredToDisablePassword} are required, because one key is one lost object away from no way in at all — and the way back is a colleague at Authority Level 3.`
      : `Ready. Turning password sign-in off takes an assertion from a key you hold right now, not merely one on record.`
    : 'Password sign-in is off. The route back is a colleague at Authority Level 3 with a recorded basis — there is no self-service reset and no email to send one to.';

  // The SECTION, not the form: `console.css` gives forms a `display`, which beats `[hidden]`.
  $('section-disable-password').hidden =
    !data.passwordSignInEnabled || data.keysNeededToDisablePassword > 0;
};

const load = async () => {
  const result = await call('/api/console/security');
  if (!result.ok) {
    notice(result.reason);
    return;
  }
  render(result.data);
};

/* --- registering a key ----------------------------------------------------- */

$('form-register-key').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  if (!webauthnAvailable()) {
    notice('This browser cannot register a security key.');
    return;
  }

  const label = $('key-label').value.trim();
  if (label.length < 2) {
    notice('Give the key a name you will recognise. Two keys are indistinguishable without one.');
    return;
  }

  const confirmed = await confirmation();
  if (!confirmed.ok) {
    notice(confirmed.reason);
    return;
  }

  const options = await call('/api/console/security/keys/registration', {});
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: registrationOptions(options.data.options),
    });
  } catch {
    // The commonest cause is the authenticator declining because it is already registered for this
    // account - which is `excludeCredentials` doing its job, not a fault.
    notice(
      'That authenticator did not register. If it is already registered to this account, use a different one.',
    );
    return;
  }
  if (!credential) {
    notice('No security key was presented.');
    return;
  }

  const result = await call('/api/console/security/keys', {
    ...confirmed.body,
    label,
    response: registrationResponse(credential),
  });

  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('key-label').value = '';
  $('security-password').value = '';
  await load();
  notice(`Registered: ${result.data.label}.`);
});

/* --- the switch ------------------------------------------------------------ */

$('form-disable-password').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  // Deliberately NOT offering the code path here. A code would prove the factor being retired still
  // works, which is not what needs proving — the module refuses it, and the page does not offer
  // something that will certainly be refused.
  const asserted = await reauthenticate();
  if (!asserted.ok) {
    notice(asserted.reason);
    return;
  }

  const result = await call('/api/console/security/password-sign-in/disable', {
    passkey: asserted.passkey,
  });

  if (!result.ok) {
    notice(result.reason);
    return;
  }

  await load();
  notice(
    'Password sign-in is off. This account is now phishing resistant, and the route back if you lose your keys is a colleague at Authority Level 3.',
  );
});

/* --- restoring somebody else ----------------------------------------------- */

$('form-restore-password').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await call('/api/console/security/password-sign-in/restore', {
    actorId: $('restore-actor').value.trim(),
    verificationBasis: $('restore-basis').value.trim(),
  });

  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('restore-actor').value = '';
  $('restore-basis').value = '';
  notice(
    'Password sign-in restored for that colleague. They can sign in with their existing password and code; the basis you gave is in the Event Ledger.',
  );
});

$('security-load').addEventListener('click', () => {
  void load();
});
