/**
 * Envelope encryption for the Secure Document Vault - blueprint 3.2, Specification v2 §6.2.
 *
 * A random 256-bit **DEK** encrypts each document. The DEK is then encrypted by a **KEK** and
 * stored, wrapped, beside the ciphertext. Two properties follow, and both matter here:
 *
 *   - Rotating the KEK re-wraps DEKs rather than re-encrypting every payload. With one key for
 *     everything, rotation means decrypting and re-encrypting every tax return in the system,
 *     which is the kind of operation that gets deferred indefinitely.
 *   - A DEK compromise is scoped to one document.
 *
 * **AES-256-GCM, not CBC.** GCM authenticates: a flipped ciphertext bit fails decryption instead
 * of producing plausible garbage. For bank statements and credit reports, silently decrypting
 * tampered data into something that parses is worse than an error.
 *
 * The KEK is behind `KekProvider` so §6.2's "key management with hardware security modules" is a
 * provider swap rather than a rewrite. `EnvKekProvider` is what runs today.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for

/**
 * Supplies the key-encryption key.
 *
 * Async because a real HSM or KMS call is async, and discovering that at integration time would
 * mean changing every caller. The interface is shaped for the provider we will have, not only
 * the one we have.
 */
export interface KekProvider {
  readonly id: string;
  kek(): Promise<Buffer>;
}

/**
 * KEK from the environment. Adequate for development, and honest about being so: the key sits in
 * a process env var, which is exactly what §6.2 wants replaced by an HSM before production.
 */
export class EnvKekProvider implements KekProvider {
  readonly id = 'env';

  constructor(private readonly variable = 'VAULT_KEK') {}

  async kek(): Promise<Buffer> {
    const raw = process.env[this.variable];
    if (!raw) {
      throw new Error(
        `${this.variable} is not set. The Secure Document Vault cannot store client documents without a key-encryption key.`,
      );
    }
    const key = Buffer.from(raw, 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${this.variable} must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} characters); received ${key.length} bytes.`,
      );
    }
    return key;
  }
}

/** Everything needed to decrypt a payload, minus the KEK. Safe to store beside the ciphertext. */
export interface EnvelopeMetadata {
  readonly wrappedDek: string;
  readonly iv: string;
  readonly authTag: string;
}

export interface EncryptedPayload extends EnvelopeMetadata {
  readonly ciphertext: Buffer;
  /** Digest of the PLAINTEXT, so a swapped-but-valid blob is still detectable. */
  readonly sha256: string;
}

const wrapDek = async (dek: Buffer, provider: KekProvider): Promise<string> => {
  const kek = await provider.kek();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  // iv:authTag:wrapped - self-describing, so unwrapping needs only the KEK.
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), wrapped.toString('hex')].join(
    ':',
  );
};

const unwrapDek = async (wrapped: string, provider: KekProvider): Promise<Buffer> => {
  const [ivHex, tagHex, dataHex] = wrapped.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Wrapped DEK is malformed.');
  }
  const kek = await provider.kek();
  const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
};

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export const encrypt = async (
  plaintext: Buffer,
  provider: KekProvider,
): Promise<EncryptedPayload> => {
  const dek = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext,
    wrappedDek: await wrapDek(dek, provider),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    sha256: sha256(plaintext),
  };
};

/**
 * Decrypt and verify.
 *
 * Two independent checks. The GCM auth tag catches tampering with *this* ciphertext; the sha256
 * comparison catches a blob that decrypts correctly but is not the document that was stored -
 * a swap, or a metadata row pointed at the wrong key. Only the first is cryptographic, and only
 * the second would catch a mix-up that never touched the ciphertext.
 */
export const decrypt = async (
  ciphertext: Buffer,
  metadata: EnvelopeMetadata,
  expectedSha256: string,
  provider: KekProvider,
): Promise<Buffer> => {
  const dek = await unwrapDek(metadata.wrappedDek, provider);
  const decipher = createDecipheriv(ALGORITHM, dek, Buffer.from(metadata.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(metadata.authTag, 'hex'));

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const actual = Buffer.from(sha256(plaintext), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(
      'Decrypted content does not match its recorded digest; the stored blob is not the document that was uploaded.',
    );
  }

  return plaintext;
};

/**
 * Field-level encryption for the highest-sensitivity values - §6.2 names SSN, EIN, bank account
 * numbers and tax IDs.
 *
 * Separate from document encryption because these live in ordinary columns and are read far more
 * often. Same envelope construction, returned as a single self-describing string so a column can
 * hold it without three extra fields.
 */
export const encryptField = async (value: string, provider: KekProvider): Promise<string> => {
  const payload = await encrypt(Buffer.from(value, 'utf8'), provider);
  return [
    'v1',
    payload.wrappedDek,
    payload.iv,
    payload.authTag,
    payload.ciphertext.toString('hex'),
  ].join('|');
};

export const decryptField = async (encoded: string, provider: KekProvider): Promise<string> => {
  const [version, wrappedDek, iv, authTag, ciphertextHex] = encoded.split('|');
  if (version !== 'v1' || !wrappedDek || !iv || !authTag || !ciphertextHex) {
    throw new Error('Encrypted field is malformed or uses an unknown version.');
  }
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const dek = await unwrapDek(wrappedDek, provider);
  const decipher = createDecipheriv(ALGORITHM, dek, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/** Generate a KEK. Used by setup tooling; never called at runtime. */
export const generateKek = (): string => randomBytes(KEY_BYTES).toString('hex');
