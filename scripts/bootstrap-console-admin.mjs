#!/usr/bin/env node
/**
 * Create the first Console credential - the one that cannot come from inside the system.
 *
 * `inviteStaff` requires a Level 3 human who is already an Actor, because granting Console access
 * grants sight of every client file in the tenant. That is the right rule and it has no base case:
 * on an empty database there is no Level 3 human to do the inviting, so the first one has to be
 * created by something standing outside the authority model. This script is that something, and
 * being outside the authority model is exactly why it is dangerous.
 *
 * Three properties make it safe enough to exist.
 *
 * **It refuses once anybody is enrolled.** The moment a single Console credential has been
 * enrolled in the tenant, the base case is over and the in-system path applies. Running this again
 * would be a second door into a system that already has a front one, and a second door is how an
 * account gets taken over by whoever can reach the shell.
 *
 * **It is idempotent up to that point.** Re-running before anybody has enrolled re-issues the
 * invitation rather than creating a second tenant, a second actor, or a second credential - a
 * half-finished first run is the normal case, not an error.
 *
 * **It prints the invitation token exactly once and stores only its hash**, which is `inviteStaff`'s
 * behaviour, not something re-implemented here. The token is a credential in transit (ADR-0023);
 * it is not written to a file and it does not go in the Ledger.
 *
 * Usage:
 *   node scripts/bootstrap-console-admin.mjs --email founder@example.com --name "A Founder"
 *   node scripts/bootstrap-console-admin.mjs --email founder@example.com --name "A Founder" \
 *     --tenant-slug burkham-wickmont --tenant-name "Burkham Wickmont"
 *
 * Exit codes: 0 created or re-issued, 1 refused or failed.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith('--')) {
    const next = process.argv[i + 1];
    args.set(token.slice(2), next && !next.startsWith('--') ? next : 'true');
  }
}

const EMAIL = (args.get('email') ?? '').trim().toLowerCase();
const NAME = (args.get('name') ?? '').trim();
const TENANT_SLUG = (args.get('tenant-slug') ?? 'burkham-wickmont').trim();
const TENANT_NAME = (args.get('tenant-name') ?? 'Burkham Wickmont').trim();
const DEPARTMENT = (args.get('department') ?? 'compliance_and_evidence').trim();

const fail = (message) => {
  console.error(`\nREFUSED: ${message}\n`);
  process.exitCode = 1;
};

if (EMAIL === '' || !EMAIL.includes('@')) {
  fail('--email is required and must be an address the person can receive mail at.');
  process.exit(1);
}
if (NAME.length < 2) {
  fail('--name is required. The actor record carries it and an audit reads it.');
  process.exit(1);
}

const prisma = new PrismaClient();

const main = async () => {
  const tenant =
    (await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } })) ??
    (await prisma.tenant.create({ data: { slug: TENANT_SLUG, name: TENANT_NAME } }));

  console.log(`tenant        ${tenant.slug} (${tenant.id})`);

  // THE REFUSAL. Once one credential is enrolled the in-system path exists, and this script must
  // not be a way around it.
  const enrolled = await prisma.actorCredential.findFirst({
    where: { tenantId: tenant.id, enrolledAt: { not: null } },
    select: { id: true, email: true, enrolledAt: true },
  });

  if (enrolled) {
    fail(
      `tenant '${tenant.slug}' already has an enrolled Console credential (${enrolled.email}, ` +
        `enrolled ${enrolled.enrolledAt.toISOString()}).\n` +
        '        The bootstrap path is closed. Adding another operator is `inviteStaff`, performed by a\n' +
        '        Level 3 human who is already enrolled - which is the control this script exists to\n' +
        '        create and must not become a way around.\n' +
        '        If that person has lost access, the path is a credential reset, not a second bootstrap.',
    );
    return;
  }

  // Idempotent: reuse the actor if a previous run got this far.
  const existingActor = await prisma.actor.findFirst({
    where: { tenantId: tenant.id, kind: 'human', authorityLevel: 3, label: NAME },
  });

  const actor =
    existingActor ??
    (await prisma.actor.create({
      data: {
        tenantId: tenant.id,
        kind: 'human',
        label: NAME,
        authorityLevel: 3,
        department: DEPARTMENT,
      },
    }));

  console.log(`actor         ${actor.label} (${actor.id}) level ${actor.authorityLevel}`);
  if (existingActor) console.log('              reused - a previous run had already created it');

  // The invitation itself goes through @bwc/identity rather than being re-implemented, so the
  // token generation, hashing and expiry are the same code the Console uses. Imported from source
  // because this script runs before any build.
  const { inviteStaff } = await import('../packages/identity/dist/index.js').catch(() => ({}));

  if (typeof inviteStaff !== 'function') {
    fail(
      'could not load `inviteStaff` from packages/identity/dist. Run `pnpm build` first - this\n' +
        '        script deliberately does not re-implement token issue, because a second\n' +
        '        implementation of a credential path is a second thing to get wrong.',
    );
    return;
  }

  const invitation = await inviteStaff({
    tenantId: tenant.id,
    actorId: actor.id,
    email: EMAIL,
    // Self-invited, and this is the whole irregularity of the bootstrap: the inviter and the
    // invitee are the same person because there is nobody else yet. Recorded as such rather than
    // disguised with a fabricated "system" actor, which would put an actor in the identity table
    // that nobody can hold to account.
    invitedBy: actor.id,
  });

  if (invitation.status !== 'ok') {
    fail(`inviteStaff returned '${invitation.status}': ${invitation.reason ?? 'no reason given'}`);
    return;
  }

  console.log(`credential    ${EMAIL}`);
  console.log(`expires       ${invitation.value.expiresAt}`);
  console.log('\n--- invitation token, shown once, not stored in the clear ---');
  console.log(invitation.value.token);
  console.log('--- end ---\n');
  console.log('Next: open the Console, accept the invitation, set a password and enrol a second');
  console.log('factor. After that this script refuses, which is the intended end state.');
};

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
