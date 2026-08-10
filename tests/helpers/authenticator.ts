/**
 * A software authenticator, for testing WebAuthn.
 *
 * It builds the same bytes a security key does: a real `clientDataJSON`, real `authenticatorData`,
 * a real COSE public key and a real ECDSA P-256 signature over `authData || sha256(clientData)`.
 *
 * **The library is the reference, not this file.** `@simplewebauthn/server` is what decides whether
 * what this produces is a valid ceremony - which is the property `totp.ts` gets from RFC 6238 and
 * a hand-rolled WebAuthn verifier could not get from anywhere. A verifier and a signer written by
 * the same hand agree with each other and prove nothing.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const b64url = (data: Buffer): string => data.toString('base64url');

/** CBOR encoder, for the subset an attestation object and a COSE key need. */
const cbor = {
  uint(value: number): Buffer {
    if (value < 24) return Buffer.from([value]);
    if (value < 256) return Buffer.from([0x18, value]);
    if (value < 65536) return Buffer.from([0x19, value >> 8, value & 0xff]);
    throw new Error('unsupported');
  },
  negative(value: number): Buffer {
    // Major type 1 encodes -1-n.
    const n = -1 - value;
    if (n < 24) return Buffer.from([0x20 | n]);
    return Buffer.from([0x38, n]);
  },
  bytes(data: Buffer): Buffer {
    const header =
      data.length < 24
        ? Buffer.from([0x40 | data.length])
        : data.length < 256
          ? Buffer.from([0x58, data.length])
          : Buffer.from([0x59, data.length >> 8, data.length & 0xff]);
    return Buffer.concat([header, data]);
  },
  text(value: string): Buffer {
    const data = Buffer.from(value, 'utf8');
    if (data.length >= 24) throw new Error('unsupported');
    return Buffer.concat([Buffer.from([0x60 | data.length]), data]);
  },
  map(entries: readonly [Buffer, Buffer][]): Buffer {
    if (entries.length >= 24) throw new Error('unsupported');
    return Buffer.concat([
      Buffer.from([0xa0 | entries.length]),
      ...entries.map(([key, value]) => Buffer.concat([key, value])),
    ]);
  },
};

/** The COSE_Key form of an ES256 public key: kty EC2, alg ES256, curve P-256, x and y. */
const coseKey = (publicKey: KeyObject): Buffer => {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return cbor.map([
    [cbor.uint(1), cbor.uint(2)], // kty: EC2
    [cbor.uint(3), cbor.negative(-7)], // alg: ES256
    [cbor.negative(-1), cbor.uint(1)], // crv: P-256
    [cbor.negative(-2), cbor.bytes(Buffer.from(jwk.x, 'base64url'))],
    [cbor.negative(-3), cbor.bytes(Buffer.from(jwk.y, 'base64url'))],
  ]);
};

const authenticatorData = (input: {
  rpId: string;
  flags: number;
  counter: number;
  attested?: { credentialId: Buffer; publicKey: KeyObject };
}): Buffer => {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(input.counter);

  const head = Buffer.concat([
    createHash('sha256').update(input.rpId, 'utf8').digest(),
    Buffer.from([input.flags]),
    counter,
  ]);

  if (input.attested === undefined) return head;

  const length = Buffer.alloc(2);
  length.writeUInt16BE(input.attested.credentialId.length);

  return Buffer.concat([
    head,
    Buffer.alloc(16), // AAGUID, all zeroes for a software authenticator
    length,
    input.attested.credentialId,
    coseKey(input.attested.publicKey),
  ]);
};

/** Flags. UP = user present, UV = user verified, AT = attested credential data included. */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface SoftwareAuthenticator {
  readonly credentialId: string;
  /** What the browser would post to finish registration. */
  register: (input: { challenge: string; origin: string; rpId: string }) => Record<string, unknown>;
  /** What the browser would post to answer an assertion. */
  assert: (input: {
    challenge: string;
    origin: string;
    rpId: string;
    /** Overridden by the clone test. */
    counter?: number;
  }) => Record<string, unknown>;
  /** The counter this authenticator will report next. */
  counter: () => number;
}

/**
 * Make one.
 *
 * `counterStep` is how much the counter advances per assertion. Zero models the many authenticators
 * - every passkey, Touch ID - that do not implement a counter at all and always report zero.
 */
export const softwareAuthenticator = (counterStep = 1): SoftwareAuthenticator => {
  const { privateKey, publicKey } = keyPair();
  const credentialId = randomBytes(32);
  let counter = 0;

  const clientData = (type: string, challenge: string, origin: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credentialId: b64url(credentialId),

    register: ({ challenge, origin, rpId }) => {
      const authData = authenticatorData({
        rpId,
        flags: UP | UV | AT,
        counter,
        attested: { credentialId, publicKey },
      });

      const attestationObject = cbor.map([
        [cbor.text('fmt'), cbor.text('none')],
        [cbor.text('attStmt'), cbor.map([])],
        [cbor.text('authData'), cbor.bytes(authData)],
      ]);

      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', challenge, origin)),
          attestationObject: b64url(attestationObject),
          transports: ['usb'],
        },
      };
    },

    assert: ({ challenge, origin, rpId, counter: override }) => {
      counter += counterStep;
      const reported = override ?? counter;

      const authData = authenticatorData({ rpId, flags: UP | UV, counter: reported });
      const client = clientData('webauthn.get', challenge, origin);

      const signature = createSign('sha256')
        .update(Buffer.concat([authData, createHash('sha256').update(client).digest()]))
        .sign(privateKey);

      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(client),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
        },
      };
    },

    counter: () => counter,
  };
};

const keyPair = (): { privateKey: KeyObject; publicKey: KeyObject } => {
  // Generated per authenticator, as a real one generates a credential key pair per registration.
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey: createPrivateKey(pair.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    publicKey: createPublicKey(pair.publicKey.export({ format: 'pem', type: 'spki' })),
  };
};
