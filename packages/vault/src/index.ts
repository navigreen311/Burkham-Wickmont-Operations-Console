/**
 * @bwc/vault - 3.2 Secure Document Vault.
 *
 * Envelope-encrypted storage (AES-256-GCM, DEK per document) with access control by Authority
 * Level and document class, virus-scan gating, watermarked export, legal hold with export
 * lockout, and an access log that records refusals as carefully as successes.
 */

// Moved to `@bwc/crypto` so 11.1 can encrypt a TOTP secret with the same construction rather
// than a second copy of it. Re-exported here because the Vault is where every existing caller
// imports it from, and a move that breaks call sites invites a copy instead.
export * from '@bwc/crypto';
export * from './store.js';
export * from './watermark.js';
export * from './vault.js';
export * from './clientAccess.js';
