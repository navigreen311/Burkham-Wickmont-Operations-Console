import 'dotenv/config';
import { EnvKekProvider, LocalEncryptedStore } from '@bwc/vault';
import { createPortalApp } from './app.js';
import { readConfig } from './config.js';

/**
 * The Client Portal process.
 *
 * Separate from `apps/api` on purpose - see the header of `app.ts`. Run them on different ports,
 * and put only this one in front of a public load balancer.
 *
 * TLS is terminated upstream. An app that also terminated TLS would be one more thing to get wrong
 * on a box that already has a proxy in front of it, and `PORTAL_TRUST_PROXY` exists precisely
 * because there is one.
 *
 * Secrets come from the environment or a secret manager and are read by the packages that own
 * them - `DATABASE_URL`, `LEDGER_SIGNING_KEY`, `VAULT_KEK`, `VAULT_BLOB_ROOT`. None is read here
 * and none is printed. In development they live in `.env`; in production they should come from a
 * managed secret store, and `VAULT_KEK` in particular is what section 6.2 wants moved to an HSM.
 */
const config = readConfig();

const app = createPortalApp({
  config,
  vault: {
    store: new LocalEncryptedStore(process.env['VAULT_BLOB_ROOT'] ?? './.vault'),
    kek: new EnvKekProvider('VAULT_KEK'),
  },
});

app.listen(config.port, () => {
  // Startup line only. Request logging belongs to 11.8, which must scrub PII before anything
  // reaches a sink - and this surface carries client identifiers on every request.
  console.log(`bwc-client-portal listening on port ${config.port}`);
});
