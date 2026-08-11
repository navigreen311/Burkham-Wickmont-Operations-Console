/**
 * The browser's half of a WebAuthn ceremony.
 *
 * **This is where a browser integration is actually wrong or right.** The server sends and expects
 * base64url strings; `navigator.credentials` sends and expects `ArrayBuffer`s, and it does not
 * complain about a string - it produces a credential for the wrong challenge, or a signature over
 * bytes nobody asked for. The failure looks like a working ceremony.
 *
 * The payloads here are produced by the same software authenticator the WebAuthn suite uses, so the
 * round trip is checked against a real one rather than against a hand-written fixture.
 */

import { describe, expect, it } from 'vitest';
import {
  authenticationOptions,
  authenticationResponse,
  fromBase64Url,
  registrationOptions,
  registrationResponse,
  toBase64Url,
  // A plain ES module, imported by the page and by this test. That it needs no DOM is the reason it
  // is a separate file.
} from '../../apps/portal-api/public/encoding.js';
import { softwareAuthenticator } from '../helpers/authenticator.js';

/** What the browser hands back, rebuilt from what the authenticator produced. */
const asCredential = (payload: Record<string, unknown>): Record<string, unknown> => {
  const response = payload['response'] as Record<string, string>;

  return {
    id: payload['id'],
    rawId: fromBase64Url(payload['rawId'] as string),
    type: payload['type'],
    getClientExtensionResults: () => ({}),
    response: {
      ...Object.fromEntries(
        Object.entries(response)
          .filter(([key]) => key !== 'transports')
          .map(([key, value]) => [key, fromBase64Url(value)]),
      ),
      ...(response['transports'] !== undefined
        ? { getTransports: () => response['transports'] }
        : {}),
    },
  };
};

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    // Every byte value, so a sign-extension or a padding bug has nowhere to hide.
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) bytes[index] = index;

    const encoded = toBase64Url(bytes.buffer);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(new Uint8Array(fromBase64Url(encoded))).toEqual(bytes);
  });

  it('decodes what the server encodes, at every padding length', () => {
    // Lengths 1, 2 and 3 mod 3 are the three padding cases, and the unpadded form is what the
    // server stores - so this is the case a decoder that assumed padding would fail on.
    for (const length of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = Buffer.alloc(length, 7);
      const server = bytes.toString('base64url');
      expect(Buffer.from(new Uint8Array(fromBase64Url(server)))).toEqual(bytes);
    }
  });
});

describe('registration', () => {
  it('turns the server options into buffers the browser will accept', () => {
    const options = registrationOptions({
      challenge: Buffer.from('a-challenge').toString('base64url'),
      rp: { id: 'portal.example.com', name: 'Burkham Wickmont' },
      user: {
        id: Buffer.from('a-user-id').toString('base64url'),
        name: 'owner@example.com',
        displayName: 'A Client Person',
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      excludeCredentials: [{ id: Buffer.from('an-existing-key').toString('base64url') }],
    });

    // THE THREE THAT MATTER. A string left in any of them is a ceremony against the wrong value.
    expect(options.challenge).toBeInstanceOf(ArrayBuffer);
    expect(options.user.id).toBeInstanceOf(ArrayBuffer);
    expect(options.excludeCredentials[0].id).toBeInstanceOf(ArrayBuffer);

    expect(Buffer.from(new Uint8Array(options.challenge)).toString()).toBe('a-challenge');
    // Everything else is passed through untouched.
    expect(options.rp.id).toBe('portal.example.com');
    expect(options.pubKeyCredParams).toEqual([{ alg: -7, type: 'public-key' }]);
  });

  it('turns a real credential back into exactly what the server verifies', () => {
    const authenticator = softwareAuthenticator();
    const server = authenticator.register({
      challenge: Buffer.from('a-challenge').toString('base64url'),
      origin: 'https://portal.example.com',
      rpId: 'portal.example.com',
    });

    // Round trip: what the server would have received, taken apart into the buffers a browser hands
    // over, and put back together by the page.
    const rebuilt = registrationResponse(asCredential(server) as never);

    expect(rebuilt).toEqual(server);
  });

  it('tolerates an authenticator that reports no transports', () => {
    const authenticator = softwareAuthenticator();
    const server = authenticator.register({
      challenge: Buffer.from('a-challenge').toString('base64url'),
      origin: 'https://portal.example.com',
      rpId: 'portal.example.com',
    });

    const credential = asCredential(server) as { response: Record<string, unknown> };
    delete credential.response['getTransports'];

    // Not an error: a credential the browser will simply prompt for less cleverly next time.
    expect(registrationResponse(credential as never).response.transports).toEqual([]);
  });
});

describe('authentication', () => {
  it('turns the server options into buffers, including allowed credentials', () => {
    const options = authenticationOptions({
      challenge: Buffer.from('another-challenge').toString('base64url'),
      rpId: 'portal.example.com',
      allowCredentials: [{ id: Buffer.from('a-key').toString('base64url'), transports: ['usb'] }],
    });

    expect(options.challenge).toBeInstanceOf(ArrayBuffer);
    expect(options.allowCredentials[0].id).toBeInstanceOf(ArrayBuffer);
    expect(options.allowCredentials[0].transports).toEqual(['usb']);
  });

  it('handles the account-less case, where nothing is allowed and everything is offered', () => {
    // A passwordless sign-in sends no `allowCredentials` at all: the authenticator picks. A
    // transform that assumed the array existed would throw on the one flow that needs it most.
    const options = authenticationOptions({
      challenge: Buffer.from('another-challenge').toString('base64url'),
      rpId: 'portal.example.com',
    });

    expect(options.allowCredentials).toEqual([]);
  });

  it('turns a real assertion back into exactly what the server verifies', () => {
    const authenticator = softwareAuthenticator();
    const server = authenticator.assert({
      challenge: Buffer.from('another-challenge').toString('base64url'),
      origin: 'https://portal.example.com',
      rpId: 'portal.example.com',
    });

    expect(authenticationResponse(asCredential(server) as never)).toEqual(server);
  });

  it('carries the user handle when there is one, and omits it when there is not', () => {
    const authenticator = softwareAuthenticator();

    const discoverable = authenticator.assert({
      challenge: Buffer.from('c').toString('base64url'),
      origin: 'https://portal.example.com',
      rpId: 'portal.example.com',
      userHandle: Buffer.from('a-user-id').toString('base64url'),
    });
    const rebuilt = authenticationResponse(asCredential(discoverable) as never);
    // It is what tells the server whose account this is with nothing typed.
    expect(rebuilt.response.userHandle).toBe(Buffer.from('a-user-id').toString('base64url'));

    const second = authenticator.assert({
      challenge: Buffer.from('c').toString('base64url'),
      origin: 'https://portal.example.com',
      rpId: 'portal.example.com',
    });
    // Absent rather than null: the server reads a string or nothing.
    expect('userHandle' in authenticationResponse(asCredential(second) as never).response).toBe(
      false,
    );
  });
});
