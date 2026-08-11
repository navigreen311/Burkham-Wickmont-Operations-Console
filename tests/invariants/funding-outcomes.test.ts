/**
 * 5.5's invariants, asserted against the DATABASE rather than against the engine.
 *
 * Blueprint 5.5 asks for the `creditLimit` / `approvedCreditLimit` distinction to be
 * "CHECK-constraint enforced", and the reason to take that literally is ADR-0034's: a rule the
 * application enforces is a rule a script, a backfill, a psql session or the next module can walk
 * past. `tests/integration/funding-outcome-ledger.test.ts` asserts the engine refuses these shapes.
 * This file asserts they cannot be written **at all**, by going around the engine on purpose.
 *
 * Every case here writes raw SQL and expects it to be rejected. A test that only exercised the
 * engine would pass just as happily against a table with no constraints on it.
 *
 * Note the timestamp handling: literals are written as text and cast (`'...'::timestamp`), never
 * bound as JS `Date`s. Prisma maps `DateTime` to a naive `timestamp(3)`, and a `Date` bound into
 * `$queryRaw` is sent as `timestamptz`, which Postgres compares by converting through the session
 * timezone. See `tests/invariants/raw-sql-timestamps.test.ts` and the note in CLAUDE.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@bwc/db';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const CLIENT_ID = randomUUID();
const ENGAGEMENT_ID = randomUUID();
const PROVIDER_ID = randomUUID();

beforeAll(async () => {
  fx = await makeFixture('funding-outcome-checks');
});

afterAll(async () => {
  await db().$executeRawUnsafe(
    `DELETE FROM "outcomes"."funding_attempts" WHERE "tenantId" = '${fx.tenant.id}'::uuid`,
  );
  await cleanupTenant(fx.tenant.id);
});

/**
 * Insert a row with the engine bypassed entirely.
 *
 * `columns` is spliced in as literal SQL. That is safe here and only here: every value is written
 * by this file, none of it comes from outside, and the point of the test is to write shapes the
 * typed client would refuse to express.
 */
const insertRaw = async (columns: string, values: string): Promise<void> => {
  await db().$executeRawUnsafe(
    `INSERT INTO "outcomes"."funding_attempts"
       ("id", "tenantId", "clientId", "engagementId", "providerId", "productKind",
        "requestedCents", "submittedAt", "clientProfileKey", "recordedBy", "updatedAt"${columns})
     VALUES
       ('${randomUUID()}'::uuid, '${fx.tenant.id}'::uuid, '${CLIENT_ID}'::uuid,
        '${ENGAGEMENT_ID}'::uuid, '${PROVIDER_ID}'::uuid, 'line_of_credit',
        1000, '2026-03-01T00:00:00.000'::timestamp, 'revenue:250k-1m|tib:24-59|fico:700-749',
        '${fx.human.id}'::uuid, '2026-03-01T00:00:00.000'::timestamp${values})`,
  );
};

/** The constraint name Postgres reports, or null if the insert was allowed through. */
const rejection = async (columns: string, values: string): Promise<string | null> => {
  try {
    await insertRaw(columns, values);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('an approved amount belongs only to an approval', () => {
  it('refuses an approval with no approved amount', async () => {
    // The shape that would let a success fee compute against nothing, or - worse - fall back to
    // the requested figure somewhere downstream and overbill by the difference.
    const message = await rejection(
      `, "outcome", "decidedAt"`,
      `, 'approved', '2026-03-10T00:00:00.000'::timestamp`,
    );
    expect(message).toMatch(/funding_attempts_approved_amount_iff_approved/);
  });

  it('refuses a decline that carries an approved amount', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt", "declineReason", "approvedCreditLimitCents"`,
      `, 'declined', '2026-03-10T00:00:00.000'::timestamp, 'Under the floor.', 500`,
    );
    expect(message).toMatch(/funding_attempts_approved_amount_iff_approved/);
  });

  it('refuses a pending attempt that carries an approved amount', async () => {
    // "Approved but not yet marked approved" is not a state. It is a row that will be counted by
    // whichever query looks at the amount rather than at the outcome.
    const message = await rejection(`, "approvedCreditLimitCents"`, `, 500`);
    expect(message).toMatch(/funding_attempts_approved_amount_iff_approved/);
  });

  it('refuses an approval for zero, because a zero computes a fee and a null does not', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt", "approvedCreditLimitCents"`,
      `, 'approved', '2026-03-10T00:00:00.000'::timestamp, 0`,
    );
    expect(message).toMatch(/funding_attempts_amounts_positive/);
  });
});

describe('a decline states a reason', () => {
  it('refuses a decline with no reason', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt"`,
      `, 'declined', '2026-03-10T00:00:00.000'::timestamp`,
    );
    expect(message).toMatch(/funding_attempts_reason_iff_declined/);
  });

  it('refuses a decline whose reason is whitespace', async () => {
    // An empty string satisfies NOT NULL and teaches 5.2 exactly as little as a null does.
    const message = await rejection(
      `, "outcome", "decidedAt", "declineReason"`,
      `, 'declined', '2026-03-10T00:00:00.000'::timestamp, '   '`,
    );
    expect(message).toMatch(/funding_attempts_reason_iff_declined/);
  });
});

describe('pending means undecided', () => {
  it('refuses a decided attempt with no decision date', async () => {
    // Time to approval is computed from this date. Without it the approval is silently dropped
    // from every mean rather than reported as missing.
    const message = await rejection(
      `, "outcome", "approvedCreditLimitCents"`,
      `, 'approved', 5000`,
    );
    expect(message).toMatch(/funding_attempts_decided_at_iff_decided/);
  });

  it('refuses a pending attempt that carries a decision date', async () => {
    const message = await rejection(`, "decidedAt"`, `, '2026-03-10T00:00:00.000'::timestamp`);
    expect(message).toMatch(/funding_attempts_decided_at_iff_decided/);
  });
});

describe('funding follows approval, and dates run forwards', () => {
  it('refuses funding on an attempt that was declined', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt", "declineReason", "fundedOn", "fundedCents"`,
      `, 'declined', '2026-03-10T00:00:00.000'::timestamp, 'Under the floor.', '2026-03-20T00:00:00.000'::timestamp, 400`,
    );
    expect(message).toMatch(/funding_attempts_funding_follows_approval/);
  });

  it('refuses a funding date with no amount', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt", "approvedCreditLimitCents", "fundedOn"`,
      `, 'approved', '2026-03-10T00:00:00.000'::timestamp, 5000, '2026-03-20T00:00:00.000'::timestamp`,
    );
    expect(message).toMatch(/funding_attempts_funding_follows_approval/);
  });

  it('refuses a decision dated before the submission', async () => {
    // A negative time-to-approval would be published rather than caught: it is a mean over
    // integers, and nothing downstream inspects the sign.
    const message = await rejection(
      `, "outcome", "decidedAt", "approvedCreditLimitCents"`,
      `, 'approved', '2026-02-01T00:00:00.000'::timestamp, 5000`,
    );
    expect(message).toMatch(/funding_attempts_dates_in_order/);
  });

  it('refuses capital that funded before it was approved', async () => {
    const message = await rejection(
      `, "outcome", "decidedAt", "approvedCreditLimitCents", "fundedOn", "fundedCents"`,
      `, 'approved', '2026-03-10T00:00:00.000'::timestamp, 5000, '2026-03-05T00:00:00.000'::timestamp, 4000`,
    );
    expect(message).toMatch(/funding_attempts_dates_in_order/);
  });
});

describe('the cohort key is present', () => {
  it('refuses a blank one, which would bucket every client together', async () => {
    // Written as an UPDATE rather than through `rejection`, which already supplies a valid
    // `clientProfileKey` in its base column list - naming it again produces a duplicate-column
    // error from the parser, and a test that accepts *any* error would have passed on that
    // instead of on the constraint. The first draft of this case did exactly that.
    await insertRaw('', '');

    let message: string | null = null;
    try {
      await db().$executeRawUnsafe(
        `UPDATE "outcomes"."funding_attempts"
            SET "clientProfileKey" = '   '
          WHERE "tenantId" = '${fx.tenant.id}'::uuid`,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/funding_attempts_cohort_key_present/);
  });
});

describe('the shapes that are legal', () => {
  it('accepts a pending attempt, an approval, a decline and a funding', async () => {
    // The counterpart every constraint suite needs: a set of CHECKs that rejects everything passes
    // all of the tests above and none of the ones that matter.
    expect(await rejection('', '')).toBeNull();
    expect(
      await rejection(
        `, "outcome", "decidedAt", "approvedCreditLimitCents"`,
        `, 'approved', '2026-03-10T00:00:00.000'::timestamp, 5000`,
      ),
    ).toBeNull();
    expect(
      await rejection(
        `, "outcome", "decidedAt", "declineReason"`,
        `, 'declined', '2026-03-10T00:00:00.000'::timestamp, 'Under the coverage floor.'`,
      ),
    ).toBeNull();
    expect(
      await rejection(
        `, "outcome", "decidedAt", "approvedCreditLimitCents", "fundedOn", "fundedCents"`,
        `, 'approved', '2026-03-10T00:00:00.000'::timestamp, 5000, '2026-03-20T00:00:00.000'::timestamp, 4000`,
      ),
    ).toBeNull();
    expect(
      await rejection(
        `, "outcome", "decidedAt"`,
        `, 'withdrawn', '2026-03-10T00:00:00.000'::timestamp`,
      ),
    ).toBeNull();
  });
});
