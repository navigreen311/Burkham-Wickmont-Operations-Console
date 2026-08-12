/**
 * The first of the seventeen blocked writes to get a control, and the ones that cannot be undone.
 *
 * Every capability here had a working module function and no declared action, so the Console could
 * read it and not offer it. Declaring the action is what puts the middleware chain in front of it -
 * before this, the module's own gate was the only check, which is ADR-0033's defect one layer in.
 *
 * Three properties carry this file.
 *
 * **A hold can be placed on the client step 4 refuses.** Litigation is anticipated because
 * something went wrong, so the client is very often in `fail`. A gate that blocked the hold would
 * mean the firm could not preserve records exactly when it most needs to - and would keep
 * destroying them on schedule while somebody worked out why the button did nothing.
 *
 * **Releasing is a separate action from placing.** Both are Level 3 today, but they are different
 * acts with different consequences, and the Ledger has to be able to tell them apart.
 *
 * **Deletion is refused while anything holds the record**, and the refusal names the hold.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import { requestDeletion } from '@bwc/retention';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
} from '@bwc/identity';
import { db } from '@bwc/db';
import { createApp } from '../../apps/api/src/app.js';
import type { ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let cookie: string;
let clientId: string;

const PASSWORD = 'a-long-enough-retention-writes-password';
const EMAIL = 'retention-writes-operator@example.com';

let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

const post = async (
  path: string,
  body: unknown,
  withCookie = true,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const get = async (path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}${path}`, { headers: { cookie } })).json()) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('retention-writes');

  clientId = (
    await createClient(fx.tenant.id, 'Held Records LLC', { id: fx.human.id, kind: 'human' })
  ).id;

  const invitation = await inviteStaff({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    email: EMAIL,
    invitedBy: fx.human.id,
  });
  if (invitation.status !== 'ok') throw new Error('setup: invite');
  const offer = await enrolStaffFromInvitation({
    tenantId: fx.tenant.id,
    token: invitation.value.token,
    password: PASSWORD,
  });
  if (offer.status !== 'ok') throw new Error('setup: enrol');
  const secret = base32Decode(offer.value.secret);
  if (!secret) throw new Error('setup: secret');
  await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: totp(secret, at()),
  });

  const config: ConsoleConfig = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_console_session',
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 10_000,
    rateLimitStore: 'memory',
    devActorHeader: false,
    rpId: 'localhost',
    rpName: 'Burkham Wickmont',
    origin: 'http://localhost',
  };

  server = createServer(
    createApp({
      config,
      limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 }),
      now: at,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;

  offsetMs += 31_000;
  const signedIn = await fetch(`${base}/api/console/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, code: totp(secret, at()) }),
  });
  cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(cookie.length).toBeGreaterThan(10);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

describe('the surface stopped saying it cannot do this', () => {
  it('offers the writes it used to list as blocked', async () => {
    const data = (await get('/api/console/retention/holds'))['data'] as Record<string, unknown>;
    const writes = data['writes'] as { available: unknown[]; blocked: unknown[] };

    // The whole point of the batch. Every entry moved from one list to the other.
    expect(writes.blocked).toEqual([]);
    expect(writes.available.length).toBe(3);
  });

  it('says on the panel which of them cannot be undone', async () => {
    const data = (await get('/api/console/retention/requests'))['data'] as Record<string, unknown>;
    const available = (data['writes'] as { available: { note: string }[] }).available;

    // A control that is irreversible and does not say so is a control somebody presses to find out.
    expect(available.some((entry) => /IRREVERSIBLE/.test(entry.note))).toBe(true);
    expect(available.some((entry) => /DANGEROUS HALF/.test(entry.note))).toBe(true);
  });
});

describe('a write needs a session and an Authority Level', () => {
  it('refuses without a session, before it says what the body should contain', async () => {
    const reply = await post('/api/console/retention/holds', {}, false);
    expect(reply.body['status']).toBe('refused');
    expect(reply.body['reason']).toBe('Sign in to continue.');

    // Nothing about the shape of the request. A caller with no session should not learn what this
    // route wants, only that it is not for them.
    expect(JSON.stringify(reply.body)).not.toMatch(/matterReference/);
  });

  it('runs the chain and returns the trace', async () => {
    const reply = await post('/api/console/retention/holds', {
      clientId,
      kind: 'litigation',
      scope: 'client',
      matterReference: 'MATTER-2026-09',
      reason: 'Anticipated litigation over a declined application.',
    });

    expect(reply.body['status']).toBe('ok');
    // "Which step let this through" is the same question as "which step blocked it", and the page
    // shows both.
    const trace = reply.body['trace'] as { step: string }[];
    expect(trace.some((step) => step.step === 'authority_level')).toBe(true);
  });
});

describe('a hold can be placed on the client the gate refuses', () => {
  it('places one on a client in fail, because that is when litigation happens', async () => {
    const failing = await createClient(fx.tenant.id, 'Failing Subject LLC', {
      id: fx.human.id,
      kind: 'human',
    });
    const moved = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: failing.id,
      to: 'fail',
      reason: 'Assessment failed on documentation.',
      actor: { id: fx.human.id, kind: 'human' },
    });
    expect(moved.status).toBe('ok');

    const reply = await post('/api/console/retention/holds', {
      clientId: failing.id,
      kind: 'litigation',
      scope: 'client',
      matterReference: 'MATTER-2026-10',
      reason: 'Complaint received from this client after the assessment failed.',
    });

    // THE ASSERTION THIS CLASSIFICATION EXISTS FOR. Step 4 refuses a client in `fail` - correctly,
    // for acting FOR them. Placing a hold is a determination ABOUT them, and the client whose
    // records most need preserving is the one whose file went wrong.
    expect(reply.body['status'], JSON.stringify(reply.body)).toBe('ok');

    const trace = reply.body['trace'] as { step: string; outcome: string }[];
    const firewall = trace.find((step) => step.step === 'firewall');
    expect(firewall?.outcome).toBe('skipped');
  });
});

describe('deletion is refused while anything holds the record', () => {
  it('refuses the decision and names what holds it', async () => {
    const requested = await requestDeletion({
      tenantId: fx.tenant.id,
      clientId,
      // An actor id: the person who took the request, not the words they took it in. Those go in
      // `requestDetail`, which is where the client's own phrasing belongs.
      requestedBy: fx.human.id,
      requestDetail: 'Asked by email for their file to be deleted.',
      requestedAt: at(),
      actor: { id: fx.human.id, kind: 'human' },
    });
    if (requested.status !== 'ok') throw new Error('setup: request');

    const eligibility = (
      (await get(`/api/console/retention/clients/${clientId}`))['data'] as Record<string, unknown>
    )['eligibility'] as Record<string, unknown>;

    // The hold placed above is in force, so the answer is no - and it says which hold.
    expect(eligibility['deletable']).toBe(false);
    expect(String(eligibility['heldBy'] ?? eligibility['note'])).toMatch(/MATTER-2026-09/);
  });

  it('records a completion only as its own act, separate from the decision', async () => {
    // Approving is a decision somebody can revisit. Recording completion is a statement that the
    // records are gone, and it is a different route for that reason.
    const reply = await post(
      `/api/console/retention/requests/${'00000000-0000-0000-0000-0000000000ff'}/completion`,
      { documentsDeleted: 3 },
    );

    // No such request - but the route authorised first, so this is the module answering, not the
    // chain refusing.
    expect(reply.body['status']).toBe('no_data');
  });
});

describe('releasing is a different act from placing', () => {
  it('releases with a reason, and the Ledger records the two separately', async () => {
    const holds = ((await get('/api/console/retention/holds'))['data'] as Record<string, unknown>)[
      'holds'
    ] as { id: string; matterReference: string }[];
    const hold = holds.find((entry) => entry.matterReference === 'MATTER-2026-09');
    expect(hold, 'the hold placed above should be in force').toBeDefined();

    const reply = await post(`/api/console/retention/holds/${hold?.id}/release`, {
      reason: 'The matter closed without proceedings being issued.',
    });
    expect(reply.body['status'], JSON.stringify(reply.body)).toBe('ok');

    // Two actions, not one with a flag. The authorisation events name which was taken, so "who
    // released the hold" is answerable without inferring it from a payload.
    const events = await db().ledgerEvent.findMany({
      where: { tenantId: fx.tenant.id, type: 'authority.action_authorised' },
    });
    const actions = events.map((event) => (event.payload as { action?: string }).action);
    expect(actions).toContain('place_legal_hold');
    expect(actions).toContain('release_legal_hold');
  });
});
