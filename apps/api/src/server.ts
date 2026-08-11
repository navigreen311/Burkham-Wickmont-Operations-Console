import 'dotenv/config';
import { createApp } from './app.js';
import { readConsoleConfig } from './config.js';

/**
 * The internal Console process.
 *
 * Separate from the Client Portal (ADR-0022), and now with a credential of its own: staff sign in
 * with a password and a TOTP code, and `CONSOLE_DEV_ACTOR_HEADER` - the `x-actor-id` seam this
 * surface used to run on - is off unless a deployment turns it on, which `readConsoleConfig`
 * refuses to allow in production.
 *
 * TLS is terminated upstream, as for the portal, which is what `CONSOLE_TRUST_PROXY` exists for.
 *
 * Secrets come from the environment or a secret manager and are read by the packages that own
 * them - `DATABASE_URL`, `LEDGER_SIGNING_KEY`, `VAULT_KEK`, `MFA_SECRET_KEY`. None is read here and
 * none is printed.
 */
const config = readConsoleConfig();

createApp({ config }).listen(config.port, () => {
  // Startup line only. Request logging belongs to System Health & Observability (11.8), which must
  // scrub PII before anything reaches a log sink.
  console.log(`bwc-console-api listening on http://127.0.0.1:${config.port}`);
});
