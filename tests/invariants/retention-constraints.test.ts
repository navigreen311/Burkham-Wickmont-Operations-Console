/**
 * 7.5's invariants, asserted against the DATABASE.
 *
 * Same discipline as `funding-outcomes.test.ts` and the same reason, with a higher price attached:
 * a rule only the application enforces is a rule a script, a backfill or a psql session walks past,
 * and what sits on the other side of these rules is destroyed records.
 *
 * The two that matter most are the scope constraint and the provenance one.
 *
 * A `client`-scoped hold with no client falls through to the tenant-wide branch of `holdsCovering`
 * and holds **every** client - which looks like caution and is actually a hold nobody can release
 * without releasing all the others. A `tenant` hold carrying a client id reads as narrower in a
 * listing than it is, which is how somebody concludes a matter is contained when it is not. Both
 * are silent and they fail in opposite directions.
 *
 * An `issuer_rule` schedule with no citation is an assumption wearing the confidence of a statute -
 * Decision D's failure with shredded records at the end of it rather than a disappointed client.
 *
 * Timestamps are written as text and cast, never bound as JS `Date`s. See
 * `tests/invariants/raw-sql-timestamps.test.ts` and the note in CLAUDE.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@bwc/db';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const CLIENT_ID = randomUUID();
const AT = `'2026-08-11T00:00:00.000'::timestamp`;

beforeAll(async () => {
  fx = await makeFixture('retention-checks');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

/** Run raw SQL and return the error message, or null when it was accepted. */
const rejection = async (sql: string): Promise<string | null> => {
  try {
    await db().$executeRawUnsafe(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const insertHold = (columns: string, values: string): string =>
  `INSERT INTO "retention"."legal_holds"
     ("id", "tenantId", "kind", "matterReference", "reason", "placedBy", "placedAt"${columns})
   VALUES
     ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, 'litigation', 'LIT-CHK-1',
      'A reason long enough to be a reason.', '${fx.human.id}'::uuid, ${AT}${values})`;

const insertSchedule = (columns: string, values: string): string =>
  `INSERT INTO "retention"."retention_schedules"
     ("id", "tenantId", "documentKind", "retainMonths", "recordedBy"${columns})
   VALUES
     ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, 'bank_statement', 24,
      '${fx.human.id}'::uuid${values})`;

describe('a hold scope agrees with its arguments', () => {
  it('refuses a client-scoped hold with no client', async () => {
    // Without this, `holdsCovering` matches it on the tenant-wide branch and it holds everyone.
    expect(await rejection(insertHold(`, "scope"`, `, 'client'`))).toMatch(
      /legal_holds_scope_arguments_agree/,
    );
  });

  it('refuses a tenant-scoped hold that names a client', async () => {
    expect(
      await rejection(insertHold(`, "scope", "clientId"`, `, 'tenant', '${CLIENT_ID}'::uuid`)),
    ).toMatch(/legal_holds_scope_arguments_agree/);
  });

  it('refuses a kind-scoped hold with no kind', async () => {
    expect(await rejection(insertHold(`, "scope"`, `, 'document_kind'`))).toMatch(
      /legal_holds_scope_arguments_agree/,
    );
  });

  it('refuses a hold that claims both a client and a kind', async () => {
    // Two scopes in one row: `holdsCovering` would match it twice and a reader could not say which
    // clause put it there.
    expect(
      await rejection(
        insertHold(
          `, "scope", "clientId", "documentKind"`,
          `, 'client', '${CLIENT_ID}'::uuid, 'tax_return'`,
        ),
      ),
    ).toMatch(/legal_holds_scope_arguments_agree/);
  });
});

describe('a hold names its matter, and a release is complete', () => {
  it('refuses a blank matter reference', async () => {
    expect(
      await rejection(
        `INSERT INTO "retention"."legal_holds"
           ("id", "tenantId", "kind", "scope", "matterReference", "reason", "placedBy", "placedAt")
         VALUES ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, 'litigation', 'tenant', '  ',
                 'A reason long enough to be a reason.', '${fx.human.id}'::uuid, ${AT})`,
      ),
    ).toMatch(/legal_holds_matter_and_reason_present/);
  });

  it('refuses a half-released hold', async () => {
    // The worst shape available: `releasedAt` set means `holdsCovering` stops returning it, so
    // preservation has stopped - and the record of who decided that is missing.
    expect(await rejection(insertHold(`, "scope", "releasedAt"`, `, 'tenant', ${AT}`))).toMatch(
      /legal_holds_release_is_complete/,
    );
  });

  it('refuses a review cadence of zero', async () => {
    expect(await rejection(insertHold(`, "scope", "reviewCadenceDays"`, `, 'tenant', 0`))).toMatch(
      /legal_holds_cadence_positive/,
    );
  });

  it('accepts the shapes that are legal', async () => {
    // A set of CHECKs that rejects everything passes every negative test and none of the ones that
    // matter.
    expect(await rejection(insertHold(`, "scope"`, `, 'tenant'`))).toBeNull();
    expect(
      await rejection(insertHold(`, "scope", "clientId"`, `, 'client', '${CLIENT_ID}'::uuid`)),
    ).toBeNull();
    expect(
      await rejection(insertHold(`, "scope", "documentKind"`, `, 'document_kind', 'tax_return'`)),
    ).toBeNull();
    expect(
      await rejection(
        insertHold(
          `, "scope", "releasedAt", "releasedBy", "releaseReason"`,
          `, 'tenant', ${AT}, '${fx.human.id}'::uuid, 'Matter concluded and counsel released it.'`,
        ),
      ),
    ).toBeNull();
  });
});

describe('a retention period carries provenance a lawyer would accept', () => {
  it('refuses a statutory period with no citation', async () => {
    expect(await rejection(insertSchedule(`, "provenanceTag"`, `, 'issuer_rule'`))).toMatch(
      /retention_schedules_provenance_complete/,
    );
  });

  it('refuses a statutory period whose citation is whitespace', async () => {
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "sourceUrl", "lastVerified", "verifiedBy"`,
          `, 'issuer_rule', '   ', ${AT}, 'Counsel'`,
        ),
      ),
    ).toMatch(/retention_schedules_provenance_complete/);
  });

  it('refuses an assumption with no rationale', async () => {
    expect(
      await rejection(insertSchedule(`, "provenanceTag"`, `, 'unresearched_default'`)),
    ).toMatch(/retention_schedules_provenance_complete/);
  });

  it('refuses an assumption that also claims a citation', async () => {
    // Both populated means the row renders one way and was arrived at another.
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "rationale", "sourceUrl"`,
          `, 'unresearched_default', 'Assumed from the general period.', 'https://example.gov/rule'`,
        ),
      ),
    ).toMatch(/retention_schedules_provenance_complete/);
  });

  it('refuses a vendor feed as a source of law', async () => {
    // The enum is shared with 5.2, where `vendor_feed` is legitimate. A bureau does not set
    // retention periods, and the shared vocabulary must not imply that every tag applies everywhere.
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "sourceUrl", "lastVerified", "verifiedBy"`,
          `, 'vendor_feed', 'https://example.com', ${AT}, 'A vendor'`,
        ),
      ),
    ).toMatch(/retention_schedules_legal_provenance_only|retention_schedules_provenance_complete/);
  });

  it('refuses a period of zero months', async () => {
    // Zero authorises immediate destruction, and that is a decision somebody should write down as
    // one rather than arrive at by leaving a field empty.
    expect(
      await rejection(
        `INSERT INTO "retention"."retention_schedules"
           ("id", "tenantId", "documentKind", "retainMonths", "recordedBy", "provenanceTag", "rationale")
         VALUES ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, 'bank_statement', 0,
                 '${fx.human.id}'::uuid, 'unresearched_default', 'Assumed from the general period.')`,
      ),
    ).toMatch(/retention_schedules_period_positive/);
  });

  it('refuses a malformed state code, which would match nothing and say nothing', async () => {
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "rationale", "stateCode"`,
          `, 'unresearched_default', 'Assumed from the general period.', 'Texas'`,
        ),
      ),
    ).toMatch(/retention_schedules_state_code_shape/);
  });

  it('accepts both legal shapes, with and without a state', async () => {
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "sourceUrl", "lastVerified", "verifiedBy"`,
          `, 'issuer_rule', 'https://example.gov/rule', ${AT}, 'Compliance counsel'`,
        ),
      ),
    ).toBeNull();
    expect(
      await rejection(
        insertSchedule(
          `, "provenanceTag", "rationale", "stateCode"`,
          `, 'unresearched_default', 'Assumed from the general business-records period.', 'TX'`,
        ),
      ),
    ).toBeNull();
  });
});

describe('a deletion decision is complete, and a completion is counted', () => {
  const insertRequest = (columns: string, values: string): string =>
    `INSERT INTO "retention"."deletion_requests"
       ("id", "tenantId", "clientId", "requestedBy", "requestedAt", "requestDetail"${columns})
     VALUES
       ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, '${CLIENT_ID}'::uuid,
        '${fx.human.id}'::uuid, ${AT}, 'Client asked for deletion.'${values})`;

  it('refuses a decided request with no decider', async () => {
    expect(await rejection(insertRequest(`, "status", "decidedAt"`, `, 'refused', ${AT}`))).toMatch(
      /deletion_requests_decision_is_complete/,
    );
  });

  it('refuses a refusal with no stated reason', async () => {
    // On a refusal this string is what the client is told. Empty means they were told nothing.
    expect(
      await rejection(
        insertRequest(
          `, "status", "decidedAt", "decidedBy"`,
          `, 'refused', ${AT}, '${fx.human.id}'::uuid`,
        ),
      ),
    ).toMatch(/deletion_requests_decision_is_complete/);
  });

  it('refuses a completion with no count', async () => {
    expect(
      await rejection(
        insertRequest(
          `, "status", "decidedAt", "decidedBy", "decisionReason", "completedAt"`,
          `, 'completed', ${AT}, '${fx.human.id}'::uuid, 'No hold applies.', ${AT}`,
        ),
      ),
    ).toMatch(/deletion_requests_completion_is_counted/);
  });

  it('accepts a completion that destroyed nothing, because zero is a real answer', async () => {
    expect(
      await rejection(
        insertRequest(
          `, "status", "decidedAt", "decidedBy", "decisionReason", "completedAt", "documentsDeleted"`,
          `, 'completed', ${AT}, '${fx.human.id}'::uuid, 'No hold applies.', ${AT}, 0`,
        ),
      ),
    ).toBeNull();
  });
});
