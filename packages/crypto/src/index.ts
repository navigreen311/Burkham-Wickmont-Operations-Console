/**
 * @bwc/crypto - the one implementation of envelope and field-level encryption.
 *
 * Moved out of `@bwc/vault` when 11.1 needed to encrypt a TOTP secret. `@bwc/vault` depends on
 * `@bwc/identity`, so identity could not import it, and the alternative was a second AES-GCM
 * routine in a second package - which is how two implementations of one construction stop agreeing
 * about what they produce.
 *
 * `@bwc/vault` re-exports everything here, so nothing that already imported `KekProvider` or
 * `encryptField` from the Vault had to move.
 */

export * from './envelope.js';
