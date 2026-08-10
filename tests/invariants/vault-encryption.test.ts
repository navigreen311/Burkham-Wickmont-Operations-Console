/**
 * Invariants for 3.2 Secure Document Vault encryption — Specification v2 §6.2, §10.5
 * ("zero data breaches").
 *
 * The encryption-at-rest test writes to a **real temporary directory and reads the actual file
 * back**. Asserting against an in-memory double would prove the double stores ciphertext, which
 * is not the claim. The claim is about disk.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  decrypt,
  decryptField,
  encrypt,
  encryptField,
  generateKek,
  newBlobKey,
  sha256,
  type KekProvider,
} from '@bwc/vault';

let root: string;
let kek: KekProvider;

/** A distinctive plaintext, so a grep for it on disk is unambiguous. */
const SECRET = Buffer.from(
  'ACME OPERATING LLC — 2025 FORM 1120S — ordinary business income 412,880.00 — CANARY-STRING-9F3A',
  'utf8',
);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bwc-vault-'));
  process.env['VAULT_TEST_KEK'] = generateKek();
  kek = new EnvKekProvider('VAULT_TEST_KEK');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('nothing readable reaches disk', () => {
  it('writes ciphertext containing no fragment of the plaintext', async () => {
    const store = new LocalEncryptedStore(root);
    const key = newBlobKey('tenant-a');

    const payload = await encrypt(SECRET, kek);
    await store.put(key, payload.ciphertext);

    // Read the actual file, not the store's idea of it.
    const onDisk = await readFile(join(root, key));

    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.equals(SECRET)).toBe(false);
    expect(onDisk.toString('latin1')).not.toContain('CANARY-STRING-9F3A');
    expect(onDisk.toString('latin1')).not.toContain('ACME OPERATING');
    expect(onDisk.toString('latin1')).not.toContain('412,880');
  });

  it('produces different ciphertext for identical plaintext', async () => {
    // A fresh DEK and IV per document: identical files must not be identifiable as identical
    // from the ciphertext alone.
    const a = await encrypt(SECRET, kek);
    const b = await encrypt(SECRET, kek);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.sha256).toBe(b.sha256);
  });

  it('stores no filename or client identifier in the blob key', () => {
    const key = newBlobKey('tenant-a');
    // A directory listing of the blob store should reveal nothing about whose documents these
    // are - it may live on infrastructure with a broader access list than the database.
    expect(key).not.toMatch(/tenant-a/);
    expect(key).toMatch(/^[0-9a-f]{4}\/[0-9a-f-]{36}$/);
  });
});

describe('tampering fails loudly', () => {
  it('refuses to decrypt a ciphertext with one bit flipped', async () => {
    const payload = await encrypt(SECRET, kek);
    const tampered = Buffer.from(payload.ciphertext);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;

    // AES-GCM, not CBC: this is a failure, not plausible garbage. For a bank statement,
    // silently decrypting altered bytes into something that parses is the worse outcome.
    await expect(decrypt(tampered, payload, payload.sha256, kek)).rejects.toThrow();
  });

  it('refuses a truncated ciphertext', async () => {
    const payload = await encrypt(SECRET, kek);
    const truncated = payload.ciphertext.subarray(0, payload.ciphertext.length - 4);
    await expect(decrypt(truncated, payload, payload.sha256, kek)).rejects.toThrow();
  });

  it('refuses when the auth tag has been altered', async () => {
    const payload = await encrypt(SECRET, kek);
    const badTag = { ...payload, authTag: payload.authTag.replace(/^../, '00') };
    await expect(decrypt(payload.ciphertext, badTag, payload.sha256, kek)).rejects.toThrow();
  });

  it('refuses a blob that decrypts cleanly but is the wrong document', async () => {
    // The digest check catches what the auth tag cannot: a metadata row pointed at another
    // document's blob, where the ciphertext is intact and simply belongs to something else.
    const payload = await encrypt(SECRET, kek);
    const otherDigest = sha256(Buffer.from('a completely different document', 'utf8'));

    await expect(decrypt(payload.ciphertext, payload, otherDigest, kek)).rejects.toThrow(
      /does not match its recorded digest/i,
    );
  });
});

describe('keys', () => {
  it('cannot decrypt with a different KEK', async () => {
    const payload = await encrypt(SECRET, kek);

    process.env['VAULT_OTHER_KEK'] = generateKek();
    const other = new EnvKekProvider('VAULT_OTHER_KEK');

    await expect(decrypt(payload.ciphertext, payload, payload.sha256, other)).rejects.toThrow();
  });

  it('refuses to start without a KEK', async () => {
    delete process.env['VAULT_MISSING_KEK'];
    await expect(new EnvKekProvider('VAULT_MISSING_KEK').kek()).rejects.toThrow(/not set/i);
  });

  it('refuses a KEK of the wrong length', async () => {
    process.env['VAULT_SHORT_KEK'] = 'abcd';
    await expect(new EnvKekProvider('VAULT_SHORT_KEK').kek()).rejects.toThrow(/32 bytes/i);
  });

  it('round-trips through encrypt and decrypt', async () => {
    const payload = await encrypt(SECRET, kek);
    const recovered = await decrypt(payload.ciphertext, payload, payload.sha256, kek);
    expect(recovered.equals(SECRET)).toBe(true);
  });
});

describe('field-level encryption for the highest-sensitivity values', () => {
  it('round-trips and leaks nothing in the encoded form', async () => {
    // §6.2 names SSN, EIN, bank account numbers and tax IDs. Synthetic values only.
    const value = '00-0000000';
    const encoded = await encryptField(value, kek);

    expect(encoded).not.toContain(value);
    expect(encoded.startsWith('v1|')).toBe(true);
    expect(await decryptField(encoded, kek)).toBe(value);
  });

  it('produces different ciphertext for the same value', async () => {
    const a = await encryptField('same-value', kek);
    const b = await encryptField('same-value', kek);
    // Deterministic encryption would let an attacker with read access build an equality oracle:
    // "these two clients share a bank account" without decrypting anything.
    expect(a).not.toBe(b);
  });

  it('refuses a malformed or unknown-version encoding', async () => {
    await expect(decryptField('not-an-encoded-field', kek)).rejects.toThrow(/malformed|version/i);
    await expect(decryptField('v99|a|b|c|d', kek)).rejects.toThrow(/version/i);
  });
});

describe('the store refuses to be escaped', () => {
  it('rejects a blob key that would climb out of the root', async () => {
    const store = new LocalEncryptedStore(root);
    // Keys are generated internally today, but this store will eventually be handed a key read
    // from a database row - a place an attacker may reach.
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/escapes the store root/i);
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow(
      /escapes the store root/i,
    );
  });
});
