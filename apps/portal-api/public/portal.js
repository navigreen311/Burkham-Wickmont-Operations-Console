/**
 * The DOM layer.
 *
 * **Deliberately thin.** Everything worth testing is in `encoding.js`; everything worth deciding is
 * on the server. What is here is: read a field, call a route, put text on the page.
 *
 * **Every value that reaches the page goes through `textContent`**, so a document name or a message
 * body cannot become markup. A test asserts that the markup-assigning properties appear nowhere in
 * this directory - including in a comment, which is why this one describes the rule without naming
 * them. That is the kind of rule which survives a rewrite only if something is watching it.
 */

import * as api from './api.js';
import {
  authenticationOptions,
  authenticationResponse,
  registrationOptions,
  registrationResponse,
} from './encoding.js';

const $ = (id) => document.getElementById(id);

const show = (view) => {
  for (const name of ['view-sign-in', 'view-room', 'view-settings']) {
    $(name).hidden = name !== view;
  }
  $('sign-out').hidden = view === 'view-sign-in';
};

const notice = (text) => {
  const element = $('notice');
  element.textContent = text;
  element.hidden = text === '';
};

/** Put a list of strings on the page. `textContent`, never markup. */
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

const supportsWebauthn = () =>
  typeof window.PublicKeyCredential === 'function' && navigator.credentials !== undefined;

// --- sign in ----------------------------------------------------------------

$('form-password').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.signIn($('email').value, $('password').value);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  if (result.data.mfaRequired) {
    // The challenge cookie is set; nothing about it is readable here, which is the point of it being
    // httpOnly.
    $('form-mfa').hidden = false;
    $('code').focus();
    return;
  }

  await enterRoom();
});

$('form-mfa').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.signInMfa($('code').value);
  if (!result.ok) {
    notice(result.reason);
    return;
  }
  await enterRoom();
});

$('use-key').addEventListener('click', async () => {
  if (!supportsWebauthn()) {
    notice('This browser cannot use a security key.');
    return;
  }

  const options = await api.signInKeyOptions();
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(options.data.options),
  });

  const result = await api.signInKey(authenticationResponse(credential));
  if (!result.ok) {
    notice(result.reason);
    return;
  }
  await enterRoom();
});

$('use-passkey').addEventListener('click', async () => {
  if (!supportsWebauthn()) {
    notice('This browser cannot use a passkey.');
    return;
  }

  const options = await api.passkeyOptions();
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  // No email typed and none asked for: a discoverable credential names the account itself.
  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(options.data.options),
  });

  const result = await api.passkeySignIn(authenticationResponse(credential));
  if (!result.ok) {
    notice(result.reason);
    return;
  }
  await enterRoom();
});

$('form-reset').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.requestReset($('reset-email').value);
  // The server answers identically for every address, and so does this: showing anything else here
  // would undo the property on the way to the screen.
  notice(result.ok ? result.reason ?? 'Check your email.' : result.reason);
});

$('sign-out').addEventListener('click', async () => {
  await api.signOut();
  show('view-sign-in');
  notice('Signed out.');
});

// --- the room ---------------------------------------------------------------

const enterRoom = async () => {
  const result = await api.room();
  if (!result.ok) {
    notice(result.reason);
    show('view-sign-in');
    return;
  }

  const data = result.data;
  $('room-client').textContent = data.clientLegalName;

  list(
    'room-documents',
    (data.documents ?? []).map((document_) => `${document_.filename} — ${document_.kind}`),
    'Nothing yet.',
  );
  list(
    'room-deliverables',
    (data.deliverables ?? []).map((deliverable) => deliverable.title),
    'Nothing delivered yet.',
  );
  list('room-withheld', data.withheld ?? [], 'Nothing is being withheld.');

  notice('');
  show('view-room');
};

$('form-message').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.sendMessage($('message-subject').value, $('message-body').value);
  notice(result.ok ? 'Sent.' : result.reason);
  if (result.ok) $('message-body').value = '';
});

$('go-settings').addEventListener('click', () => void enterSettings());
$('go-room').addEventListener('click', () => void enterRoom());

// --- security settings -------------------------------------------------------

const enterSettings = async () => {
  const [state, registered] = await Promise.all([api.passwordSignIn(), api.keys()]);

  if (!state.ok) {
    notice(state.reason);
    return;
  }

  const status = state.data;
  $('settings-summary').textContent = status.hasPassword
    ? status.passwordSignInEnabled
      ? `Password sign-in is on. ${status.discoverableKeys} passkey(s) registered.`
      : `Password sign-in is off. ${status.discoverableKeys} passkey(s) registered.`
    : 'This account has no password. Passkeys only.';

  list(
    'settings-keys',
    (registered.ok ? registered.data : []).map((key) => key.label),
    'No security keys registered.',
  );

  notice('');
  show('view-settings');
};

$('form-register-key').addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!supportsWebauthn()) {
    notice('This browser cannot register a security key.');
    return;
  }

  const discoverable = $('key-discoverable').checked;

  const options = await api.keyRegistrationOptions(discoverable);
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  const credential = await navigator.credentials.create({
    publicKey: registrationOptions(options.data.options),
  });

  // The password where the account still has one; a passkey where it does not. The server decides
  // which it will accept - this only passes on what the client gave.
  const password = $('key-confirm').value;
  const confirmation = password === '' ? await confirmWithPasskey() : { password };
  if (confirmation === null) return;

  const result = await api.registerKey(
    confirmation,
    $('key-label').value,
    registrationResponse(credential),
    discoverable,
  );

  notice(result.ok ? 'Key registered.' : result.reason);
  if (result.ok) await enterSettings();
});

/** A passkey used to confirm a change rather than to sign in. */
const confirmWithPasskey = async () => {
  const options = await api.signInKeyOptions();
  if (!options.ok) {
    notice(options.reason);
    return null;
  }

  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(options.data.options),
  });

  return { passkey: authenticationResponse(credential) };
};

$('form-disable-password').addEventListener('submit', async (event) => {
  event.preventDefault();

  const options = await api.passkeyOptions();
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(options.data.options),
  });

  const result = await api.disablePasswordSignIn(
    $('disable-password').value,
    authenticationResponse(credential),
  );

  notice(result.ok ? 'Password sign-in is off.' : result.reason);
  if (result.ok) await enterSettings();
});

$('form-remove-password').addEventListener('submit', async (event) => {
  event.preventDefault();

  const options = await api.passkeyOptions();
  if (!options.ok) {
    notice(options.reason);
    return;
  }

  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(options.data.options),
  });

  const result = await api.removePassword(authenticationResponse(credential));
  notice(result.ok ? 'The password has been removed.' : result.reason);
  if (result.ok) await enterSettings();
});

// --- start -------------------------------------------------------------------

// A live session means the room; anything else means the sign-in view. Asking the server rather than
// reading a cookie, because the cookie is httpOnly and unreadable here by design.
void api.room().then((result) => {
  if (result.ok) void enterRoom();
  else show('view-sign-in');
});
