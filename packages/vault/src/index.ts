/**
 * @bwc/vault - 3.2 Secure Document Vault.
 *
 * Envelope-encrypted storage (AES-256-GCM, DEK per document) with access control by Authority
 * Level and document class, virus-scan gating, watermarked export, legal hold with export
 * lockout, and an access log that records refusals as carefully as successes.
 */

export * from './crypto.js';
export * from './store.js';
export * from './watermark.js';
export * from './vault.js';
export * from './clientAccess.js';
