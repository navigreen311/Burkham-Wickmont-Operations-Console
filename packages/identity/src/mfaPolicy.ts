/**
 * Whether this tenant requires a second factor on every client sign-in - 11.7 policy, 11.1
 * enforcement.
 *
 * Staff MFA is mandatory and always has been (ADR-0032): the internal Console is what makes a
 * missing credential exploitable, so there was never a tenant that should be without it. Client
 * MFA is the other case. A client who cannot get into their own file is a phone call to the firm,
 * and a firm that has not told its clients a mandate is coming turns that into a hundred of them.
 * So the client-side mandate is a POLICY CHOICE a tenant makes, deliberately, once it has told
 * people - which is the definition of a parameter in ADR-0019 rather than an invariant.
 *
 * **It defaults OFF, and that is the whole reason it is admissible as a parameter at all.**
 * ADR-0019's rule is that configuration must not be able to turn a control off. This setting can
 * only turn one ON: with it unset the system behaves exactly as it did before, and there is no
 * value of it that removes a check which exists today. A parameter whose unsafe direction is its
 * default is a different kind of object from one whose unsafe direction is a bound somebody widens.
 *
 * **Why the effective value is read here and not through `@bwc/admin`.** `@bwc/admin` already
 * depends on `@bwc/identity` (it resolves the Level 3 actor making a change), so importing it back
 * would be a package cycle and `turbo run build`'s `dependsOn: ["^build"]` would refuse to order
 * it. The parameter's KEY and DEFAULT are declared here, where the code they govern lives, and
 * `@bwc/admin`'s registry imports them - so the registry entry and the enforcement cannot drift to
 * two different keys, which is the failure this would otherwise invite.
 *
 * `tests/integration/client-mfa-mandate.test.ts` asserts that this reader and `effectiveValue`
 * return the same answer for the same tenant, because two readers of one setting is exactly the
 * shape that goes quietly wrong.
 */

import { db } from '@bwc/db';

/** The registry key. `<package>.<CONSTANT_NAME>`, so a reader can find the code it governs. */
export const CLIENT_MFA_REQUIRED_KEY = 'identity.CLIENT_MFA_REQUIRED';

/**
 * Off.
 *
 * A mandate that arrived with a deployment rather than with a decision is a lockout nobody chose,
 * and the people it locks out are clients who cannot escalate to anyone but us.
 */
export const CLIENT_MFA_REQUIRED_DEFAULT = 0;

/** The value that means "required". The parameter is bounded to 0 or 1 by the registry. */
export const CLIENT_MFA_REQUIRED_ON = 1;

/**
 * Whether client users in this tenant must hold a second factor.
 *
 * Reads applied changes only, so a staged change does not move it - the mandate is high-risk in
 * the registry precisely so that switching it on is a two-step act somebody has to come back to.
 */
export const clientMfaRequired = async (tenantId: string): Promise<boolean> => {
  const latest = await db().configurationChange.findFirst({
    where: { tenantId, key: CLIENT_MFA_REQUIRED_KEY, appliedAt: { not: null } },
    // The same two-key ordering `effectiveValue` uses, for the same reason: `appliedAt` can
    // legitimately collide - a rollback recorded at the same logical instant as the change it
    // undoes is the ordinary case - and with a single sort key the winner is whichever row
    // Postgres happens to return. `createdAt` is the database's own insertion clock.
    orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
  });

  return (latest?.newValue ?? CLIENT_MFA_REQUIRED_DEFAULT) === CLIENT_MFA_REQUIRED_ON;
};
