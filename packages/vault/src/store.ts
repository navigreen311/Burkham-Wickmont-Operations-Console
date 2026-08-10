/**
 * Blob storage for the Secure Document Vault - Specification v2 §5.7, "a separate encrypted
 * object store".
 *
 * The interface takes and returns **ciphertext only**. Encryption happens above this layer, so
 * the store cannot leak plaintext for the simple reason that it never receives any. That is a
 * stronger guarantee than "the store encrypts things", which depends on the store being correct.
 *
 * One implementation ships: a local filesystem store. S3 is the obvious production choice, but
 * there are no credentials and no Argus vendor review, and shipping an untested adapter would be
 * the fake-completeness this codebase keeps refusing. The interface is the seam; when the vendor
 * gate clears, an S3 store implements it without touching a call site.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface BlobStore {
  readonly kind: string;
  put(key: string, ciphertext: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * Build an opaque storage key.
 *
 * Deliberately contains no filename, client name, or document kind. A directory listing of the
 * blob store should reveal nothing about whose documents these are or what they contain - the
 * store may end up on infrastructure with a broader access list than the database.
 */
export const newBlobKey = (tenantId: string): string => {
  const shard = createHash('sha256').update(tenantId).digest('hex').slice(0, 4);
  return `${shard}/${randomUUID()}`;
};

export class LocalEncryptedStore implements BlobStore {
  readonly kind = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve a key to a path, refusing anything that escapes the root.
   *
   * Keys are generated internally today, but this store will eventually be handed a key read
   * from a database row, and a row is a place an attacker may reach. `../../etc/passwd` as a key
   * must fail here rather than be trusted because of where it came from.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('Blob key escapes the store root.');
    }
    return path;
  }

  async put(key: string, ciphertext: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, ciphertext);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory store, for tests that are about vault behaviour rather than durability.
 *
 * The encryption-at-rest tests deliberately use `LocalEncryptedStore` instead, because "no
 * plaintext on disk" is a claim about disk and can only be checked by reading the file.
 */
export class InMemoryStore implements BlobStore {
  readonly kind = 'memory';
  private readonly blobs = new Map<string, Buffer>();

  async put(key: string, ciphertext: Buffer): Promise<void> {
    this.blobs.set(key, Buffer.from(ciphertext));
  }

  async get(key: string): Promise<Buffer> {
    const blob = this.blobs.get(key);
    if (!blob) throw new Error(`No blob for key ${key}.`);
    return Buffer.from(blob);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
}
