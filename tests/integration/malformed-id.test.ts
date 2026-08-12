/**
 * A path id that is not a UUID.
 *
 * Every route passes a path id straight into a Prisma `where` against an `@db.Uuid` column.
 * Postgres raises on a malformed one, the async wrapper catches it, and the caller gets a **500
 * carrying a database error string** — for the entirely ordinary act of typing an id wrong. It was
 * repo-wide, and it predated every route added this month.
 *
 * The guard is one `app.param` registration rather than a check in each of twenty-one route
 * modules, so the assertions below are deliberately spread across modules that never coordinated:
 * if the guard were per-route, one of these would have been missed.
 *
 * **The answer is the same one a well-formed id that belongs to nothing gets.** "No such id" and
 * "that is not an id" are the same fact from outside, and two different answers would invite
 * somebody to probe which.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
} from '@bwc/identity';
import { createApp } from '../../apps/api/src/app.js';
import type { ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let cookie: string;

const PASSWORD = 'a-long-enough-malformed-id-password';
const EMAIL = 'malformed-id-operator@example.com';

let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

/** A syntactically valid UUID that belongs to nothing. The control for every case below. */
const ABSENT = '00000000-0000-0000-0000-0000000000ff';

const call = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
};

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('malformed-id');

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

/**
 * One per id-carrying parameter, across modules that never coordinated.
 *
 * `not-a-uuid` is the shape somebody actually produces: a name, a truncated paste, a slug.
 */
const MALFORMED = [
  ['clientId', '/api/console/clients/not-a-uuid'],
  ['clientId (vault)', '/api/console/vault/clients/not-a-uuid'],
  ['clientId (billing)', '/api/console/billing/clients/not-a-uuid'],
  ['documentId', '/api/console/vault/documents/not-a-uuid/access-log'],
  ['engagementId', '/api/console/contracts/engagements/not-a-uuid/fee-exhibit'],
  ['instanceId', '/api/console/workflow/instances/not-a-uuid'],
  ['clientId (risk)', '/api/console/clients/not-a-uuid/risk'],
] as const;

describe('a malformed path id is not a server error', () => {
  it.each(MALFORMED)('%s returns no_data rather than 500', async (_name, path) => {
    const reply = await call(path);

    // The defect: Postgres raised on the malformed UUID, asyncRoute caught it, and the caller got
    // a 500 with a database error string for typing an id wrong.
    expect(reply.status).toBe(404);
    expect(reply.body['status']).toBe('no_data');
  });

  it('says nothing about the id being malformed', async () => {
    const reply = await call('/api/console/clients/not-a-uuid');

    // No stack, no SQL, no "invalid input syntax for type uuid" - a caller learns that there is no
    // such record, which is true, and nothing about the shape of what was asked for.
    const serialised = JSON.stringify(reply.body).toLowerCase();
    expect(serialised).not.toContain('uuid');
    expect(serialised).not.toContain('syntax');
    expect(serialised).not.toContain('prisma');
  });

  it('answers the same for a malformed id and a well-formed one that belongs to nothing', async () => {
    const malformed = await call('/api/console/clients/not-a-uuid');
    const absent = await call(`/api/console/clients/${ABSENT}`);

    // Two different answers would tell somebody the shape is checked, which is an invitation to
    // probe which ids are real. Both are 404 no_data.
    expect(malformed.status).toBe(absent.status);
    expect(malformed.body['status']).toBe(absent.body['status']);
  });

  it('still lets a well-formed id through to the module that owns it', async () => {
    // The guard must not swallow every request. A real UUID reaches the module, which answers for
    // itself - here, that no such client exists in this tenant.
    const reply = await call(`/api/console/clients/${ABSENT}`);
    expect(reply.body['status']).toBe('no_data');
    expect(String(reply.body['reason'])).toMatch(/client/i);
  });

  it('leaves parameters that are not ids alone', async () => {
    // `state` is a two-letter code and `clauseKey` is a key. Neither is a UUID, and a guard that
    // caught them would break the routes that own them.
    const clauses = await call('/api/console/contracts/clauses/some-clause-key/history');
    expect(clauses.body['status']).toBe('ok');
  });

  it('guards a route the guard was never told about, because it is registered on the parameter', async () => {
    // The property that makes this one registration rather than twenty-one: any future route with
    // :clientId in its path inherits it. This one exercises a module that predates the guard.
    const reply = await call('/api/console/vault/clients/still-not-a-uuid');
    expect(reply.status).toBe(404);
  });
});
