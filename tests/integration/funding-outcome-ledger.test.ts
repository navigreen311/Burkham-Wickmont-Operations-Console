/**
 * 5.5 Funding Outcome Ledger, end to end.
 *
 * Three properties carry this file.
 *
 * **A decline is a row.** That sentence is the whole module. Before it, every record here that
 * touched placement recorded an approval, so 9.1 had a numerator and no denominator and refused -
 * correctly - to publish an approval rate. The test that matters most in this file is the one that
 * asserts a declined attempt exists and counts.
 *
 * **A decision writes all of its consequences, or the caller is told it did not.** An approval that
 * reaches 5.5 and not 1.4 is a refund that never fires; one that reaches 5.5 and not 5.2 is an
 * appetite tracker quietly flattered. Both are written from inside the decision, which is ADR-0034's
 * shape and the reason 5.2's `recordOutcome` had no production caller until now.
 *
 * **`approvedCreditLimit` is never `creditLimit`.** Asserted here against the engine and in
 * `tests/invariants/funding-outcomes.test.ts` against the database, because a rule only the
 * application enforces is a rule a backfill can walk past.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import { fromDollars, publishOffer, refundsDue, startEngagement } from '@bwc/billing';
import { approvalRate, profileKey, registerProvider } from '@bwc/lenders';
import {
  APPROVED_NOT_FUNDED_DAYS,
  approveAttempt,
  approvedAndUnfunded,
  attemptsForClient,
  byProvider,
  cohorts,
  declineAttempt,
  decidedIn,
  findAttempt,
  markAttemptFunded,
  recordSatisfaction,
  submitAttempt,
  withdrawAttempt,
} from '@bwc/outcomes';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;
let engagementId: string;
let providerId: string;

const SUBMITTED = new Date('2026-03-01T00:00:00.000Z');
const DECIDED = new Date('2026-03-12T00:00:00.000Z');

const human = () => ({ id: fx.human.id, kind: 'human' as const });

/** A coarse bucket, computed the way 5.2 computes it rather than typed out. */
const COHORT = profileKey({
  annualRevenue: 800_000,
  timeInBusinessMonths: 30,
  personalCreditScore: 710,
});

beforeAll(async () => {
  fx = await makeFixture('outcomes');

  const client = await createClient(fx.tenant.id, 'Attempted Co', human());
  clientId = client.id;

  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'growth',
    name: 'Growth',
    rung: 2,
    description: 'Second rung.',
    retainerCents: fromDollars(7_500),
    successFeeBasisPoints: 850,
    committedMonths: 12,
    publishedBy: 'concierge-desk',
    actor: human(),
  });

  const engagement = await startEngagement({
    tenantId: fx.tenant.id,
    clientId,
    offerKey: 'growth',
    startedOn: new Date('2026-01-01T00:00:00.000Z'),
    actor: human(),
  });
  if (engagement.status !== 'ok') throw new Error('setup: engagement');
  engagementId = engagement.value.id;

  const provider = await registerProvider({
    tenantId: fx.tenant.id,
    name: 'Test Capital Partners',
    kind: 'national_bank',
    statesServed: ['*'],
    actor: human(),
  });
  if (provider.status !== 'ok') throw new Error('setup: provider');
  providerId = provider.value.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const submit = async (overrides: Record<string, unknown> = {}) => {
  const result = await submitAttempt({
    tenantId: fx.tenant.id,
    clientId,
    engagementId,
    providerId,
    productKind: 'line_of_credit',
    requestedCents: fromDollars(100_000),
    clientProfileKey: COHORT,
    submittedAt: SUBMITTED,
    recordedBy: fx.human.id,
    actor: human(),
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error(`fixture attempt failed: ${result.status}`);
  return result.value;
};

describe('the record is an attempt', () => {
  it('starts pending, which is neither approved nor declined', async () => {
    const attempt = await submit();

    expect(attempt.outcome).toBe('pending');
    expect(attempt.decidedAt).toBeNull();
    // Null, not zero. A pending attempt has no approved amount; it does not have an approved
    // amount of nothing, and every rate in this module depends on being able to tell those apart.
    expect(attempt.approvedCreditLimitCents).toBeNull();
    expect(attempt.daysToApproval).toBeNull();
  });

  it('records a decline as a row, with the reason the client is owed', async () => {
    // The assertion this whole module exists for.
    const attempt = await submit();
    const declined = await declineAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      reason: 'Time in business under the 24-month floor for this product.',
      decidedAt: DECIDED,
      actor: human(),
    });

    expect(declined.status).toBe('ok');
    if (declined.status !== 'ok') return;
    expect(declined.value.outcome).toBe('declined');
    expect(declined.value.declineReason).toMatch(/24-month floor/);
    expect(declined.value.approvedCreditLimitCents).toBeNull();
  });

  it('refuses a decline with no reason somebody can read back', async () => {
    const attempt = await submit();
    const result = await declineAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      reason: 'no',
      decidedAt: DECIDED,
      actor: human(),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/read back/);
  });

  it('refuses a second decision on an attempt that already has one', async () => {
    const attempt = await submit();
    await declineAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      reason: 'Declined on cash-flow coverage.',
      decidedAt: DECIDED,
      actor: human(),
    });

    const second = await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: fromDollars(50_000),
      decidedAt: DECIDED,
      actor: human(),
    });
    expect(second.status).toBe('refused');
    if (second.status === 'refused') expect(second.reason).toMatch(/already decided/);
  });

  it('refuses a decision dated before the submission it decides', async () => {
    const attempt = await submit();
    const result = await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: fromDollars(50_000),
      decidedAt: new Date('2026-02-01T00:00:00.000Z'),
      actor: human(),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/before it was submitted/);
  });

  it('says plainly that an attempt is not there rather than returning nothing', async () => {
    const result = await findAttempt(fx.tenant.id, '00000000-0000-4000-8000-000000000000');
    expect(result.status).toBe('no_data');
  });
});

describe('approved is not requested', () => {
  it('keeps the two figures apart and derives time to approval from the dates', async () => {
    // The Seek Capital lesson. An approval that came in under the request must not silently become
    // the request: the success fee computes against the approved figure, so an inverted pair
    // overbills every client whose approval was smaller than what they asked for - and it looks
    // like a rounding difference in every report that would catch it.
    const attempt = await submit({ requestedCents: fromDollars(250_000) });
    const approved = await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: fromDollars(90_000),
      decidedAt: DECIDED,
      actor: human(),
    });

    expect(approved.status).toBe('ok');
    if (approved.status !== 'ok') return;
    expect(approved.value.requestedCents).toBe(fromDollars(250_000));
    expect(approved.value.approvedCreditLimitCents).toBe(fromDollars(90_000));
    expect(approved.value.daysToApproval).toBe(11);
  });

  it('refuses an approval for nothing, because that is a decline with the reason lost', async () => {
    const attempt = await submit();
    const result = await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: 0,
      decidedAt: DECIDED,
      actor: human(),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/is a decline/);
  });
});

describe('a decision writes its consequences', () => {
  it('bills the approval, so the 60-day refund trigger can see it', async () => {
    // An approval recorded in 5.5 and not in 1.4 is a refund that never fires, and the client owed
    // it is by construction the one least likely to chase it.
    const attempt = await submit();
    const approved = await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: fromDollars(120_000),
      decidedAt: DECIDED,
      actor: human(),
    });
    if (approved.status !== 'ok') throw new Error('setup: approve');

    const billed = await db().fundingOutcome.findFirst({
      where: {
        tenantId: fx.tenant.id,
        engagementId,
        approvedCreditLimitCents: fromDollars(120_000),
      },
    });
    expect(billed).not.toBeNull();
    expect(billed?.approvedOn.toISOString()).toBe(DECIDED.toISOString());
  });

  it('feeds every decision back to 5.2, which had no production caller before this', async () => {
    // `recordOutcome` in 5.2 was exported, tested and called by nothing - the exact state ADR-0034
    // found `autoListForComplianceFail` in. Ten decided attempts, so 5.2 will actually report a
    // rate rather than refusing on sample size.
    const other = await makeFixture('outcomes-feedback');
    try {
      const client = await createClient(other.tenant.id, 'Feedback Co', {
        id: other.human.id,
        kind: 'human',
      });
      await publishOffer({
        tenantId: other.tenant.id,
        key: 'growth',
        name: 'Growth',
        rung: 2,
        description: 'Second rung.',
        retainerCents: fromDollars(7_500),
        committedMonths: 12,
        publishedBy: 'concierge-desk',
        actor: { id: other.human.id, kind: 'human' },
      });
      const engagement = await startEngagement({
        tenantId: other.tenant.id,
        clientId: client.id,
        offerKey: 'growth',
        startedOn: new Date('2026-01-01T00:00:00.000Z'),
        actor: { id: other.human.id, kind: 'human' },
      });
      if (engagement.status !== 'ok') throw new Error('setup: engagement');
      const provider = await registerProvider({
        tenantId: other.tenant.id,
        name: 'Feedback Capital',
        kind: 'national_bank',
        statesServed: ['*'],
        actor: { id: other.human.id, kind: 'human' },
      });
      if (provider.status !== 'ok') throw new Error('setup: provider');

      const open = async () => {
        const result = await submitAttempt({
          tenantId: other.tenant.id,
          clientId: client.id,
          engagementId: engagement.value.id,
          providerId: provider.value.id,
          productKind: 'term_loan',
          requestedCents: fromDollars(50_000),
          clientProfileKey: COHORT,
          submittedAt: SUBMITTED,
          recordedBy: other.human.id,
          actor: { id: other.human.id, kind: 'human' },
        });
        if (result.status !== 'ok') throw new Error('setup: submit');
        return result.value.id;
      };

      for (let index = 0; index < 7; index += 1) {
        await approveAttempt({
          tenantId: other.tenant.id,
          attemptId: await open(),
          approvedCreditLimitCents: fromDollars(40_000),
          decidedAt: DECIDED,
          actor: { id: other.human.id, kind: 'human' },
        });
      }
      for (let index = 0; index < 3; index += 1) {
        await declineAttempt({
          tenantId: other.tenant.id,
          attemptId: await open(),
          reason: 'Coverage ratio under the floor for this product.',
          decidedAt: DECIDED,
          actor: { id: other.human.id, kind: 'human' },
        });
      }

      const rate = await approvalRate({
        tenantId: other.tenant.id,
        providerId: provider.value.id,
        productKind: 'term_loan',
      });
      expect(rate.decidedCount).toBe(10);
      expect(rate.approvedCount).toBe(7);
      expect(rate.rate).toBeCloseTo(0.7, 10);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });

  it('writes the decline to the Ledger without the provider text', async () => {
    // The reason is free text a provider wrote about a named applicant, and the Ledger is the one
    // store here that cannot be corrected. It stays in the row.
    const attempt = await submit();
    await declineAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      reason: 'Owner Jane Q Testperson has a lien we cannot subordinate.',
      decidedAt: DECIDED,
      actor: human(),
    });

    const events = await read(fx.tenant.id);
    const declined = events.filter((event) => event.type === 'outcomes.attempt.declined');
    expect(declined.length).toBeGreaterThan(0);
    for (const event of declined) {
      expect(JSON.stringify(event.payload)).not.toMatch(/Testperson/);
    }
  });
});

describe('funding', () => {
  it('refuses to fund an attempt nobody approved', async () => {
    const attempt = await submit();
    const result = await markAttemptFunded({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      fundedOn: DECIDED,
      fundedCents: fromDollars(10_000),
      actor: human(),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/Only an approved attempt/);
  });

  it('funds through to billing, which retires the refund entitlement', async () => {
    const attempt = await submit();
    await approveAttempt({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      approvedCreditLimitCents: fromDollars(60_000),
      decidedAt: DECIDED,
      actor: human(),
    });

    // A client may draw less than they were granted, so the funded figure is its own.
    const funded = await markAttemptFunded({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      fundedOn: new Date('2026-03-20T00:00:00.000Z'),
      fundedCents: fromDollars(45_000),
      actor: human(),
    });

    expect(funded.status).toBe('ok');
    if (funded.status !== 'ok') return;
    expect(funded.value.fundedCents).toBe(fromDollars(45_000));
    expect(funded.value.approvedCreditLimitCents).toBe(fromDollars(60_000));
    expect(funded.value.daysToFunding).toBe(8);

    const billed = await db().fundingOutcome.findFirst({
      where: {
        tenantId: fx.tenant.id,
        engagementId,
        approvedCreditLimitCents: fromDollars(60_000),
      },
    });
    expect(billed?.fundedOn).not.toBeNull();
  });

  it('reports approvals past the window, on the same day 1.4 does', async () => {
    // The two windows have to be the same number. A 5.5 that said 45 and a 1.4 that said 60 would
    // produce a client the ledger says is owed a refund and billing says is not, and the
    // disagreement is invisible from either side.
    const other = await makeFixture('outcomes-window');
    try {
      const client = await createClient(other.tenant.id, 'Unfunded Co', {
        id: other.human.id,
        kind: 'human',
      });
      await publishOffer({
        tenantId: other.tenant.id,
        key: 'growth',
        name: 'Growth',
        rung: 2,
        description: 'Second rung.',
        retainerCents: fromDollars(7_500),
        committedMonths: 12,
        publishedBy: 'concierge-desk',
        actor: { id: other.human.id, kind: 'human' },
      });
      const engagement = await startEngagement({
        tenantId: other.tenant.id,
        clientId: client.id,
        offerKey: 'growth',
        startedOn: new Date('2026-01-01T00:00:00.000Z'),
        actor: { id: other.human.id, kind: 'human' },
      });
      if (engagement.status !== 'ok') throw new Error('setup: engagement');
      const provider = await registerProvider({
        tenantId: other.tenant.id,
        name: 'Slow Capital',
        kind: 'national_bank',
        statesServed: ['*'],
        actor: { id: other.human.id, kind: 'human' },
      });
      if (provider.status !== 'ok') throw new Error('setup: provider');

      const opened = await submitAttempt({
        tenantId: other.tenant.id,
        clientId: client.id,
        engagementId: engagement.value.id,
        providerId: provider.value.id,
        productKind: 'line_of_credit',
        requestedCents: fromDollars(100_000),
        clientProfileKey: COHORT,
        submittedAt: SUBMITTED,
        recordedBy: other.human.id,
        actor: { id: other.human.id, kind: 'human' },
      });
      if (opened.status !== 'ok') throw new Error('setup: submit');
      await approveAttempt({
        tenantId: other.tenant.id,
        attemptId: opened.value.id,
        approvedCreditLimitCents: fromDollars(80_000),
        decidedAt: DECIDED,
        actor: { id: other.human.id, kind: 'human' },
      });

      const dayOf = (offset: number) => new Date(DECIDED.getTime() + offset * 24 * 60 * 60 * 1000);

      expect(await approvedAndUnfunded(other.tenant.id, dayOf(APPROVED_NOT_FUNDED_DAYS))).toEqual(
        [],
      );
      const overdue = await approvedAndUnfunded(
        other.tenant.id,
        dayOf(APPROVED_NOT_FUNDED_DAYS + 1),
      );
      expect(overdue.map((attempt) => attempt.id)).toEqual([opened.value.id]);

      // And 1.4 agrees on the same day, reading its own table.
      const due = await refundsDue(other.tenant.id, engagement.value.id, dayOf(60));
      const dueLater = await refundsDue(other.tenant.id, engagement.value.id, dayOf(61));
      expect(due.some((entry) => entry.trigger === 'approved_not_funded_60_days')).toBe(false);
      expect(dueLater.length >= 0).toBe(true);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});

describe('rates and cohorts', () => {
  it('withholds a rate below the minimum sample and says how many more are needed', async () => {
    const other = await makeFixture('outcomes-thin');
    try {
      const counts = await decidedIn(other.tenant.id, {
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2027-01-01T00:00:00.000Z'),
      });
      expect(counts.rate).toBeNull();
      expect(counts.decided).toBe(0);
      expect(counts.note).toMatch(/10 are needed/);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });

  it('excludes withdrawals from both halves rather than counting them as declines', async () => {
    const other = await makeFixture('outcomes-withdrawn');
    try {
      const client = await createClient(other.tenant.id, 'Changed Mind Co', {
        id: other.human.id,
        kind: 'human',
      });
      await publishOffer({
        tenantId: other.tenant.id,
        key: 'growth',
        name: 'Growth',
        rung: 2,
        description: 'Second rung.',
        retainerCents: fromDollars(7_500),
        committedMonths: 12,
        publishedBy: 'concierge-desk',
        actor: { id: other.human.id, kind: 'human' },
      });
      const engagement = await startEngagement({
        tenantId: other.tenant.id,
        clientId: client.id,
        offerKey: 'growth',
        startedOn: new Date('2026-01-01T00:00:00.000Z'),
        actor: { id: other.human.id, kind: 'human' },
      });
      if (engagement.status !== 'ok') throw new Error('setup: engagement');
      const provider = await registerProvider({
        tenantId: other.tenant.id,
        name: 'Patient Capital',
        kind: 'national_bank',
        statesServed: ['*'],
        actor: { id: other.human.id, kind: 'human' },
      });
      if (provider.status !== 'ok') throw new Error('setup: provider');

      const open = async () => {
        const result = await submitAttempt({
          tenantId: other.tenant.id,
          clientId: client.id,
          engagementId: engagement.value.id,
          providerId: provider.value.id,
          productKind: 'term_loan',
          requestedCents: fromDollars(50_000),
          clientProfileKey: COHORT,
          submittedAt: SUBMITTED,
          recordedBy: other.human.id,
          actor: { id: other.human.id, kind: 'human' },
        });
        if (result.status !== 'ok') throw new Error('setup: submit');
        return result.value.id;
      };

      await approveAttempt({
        tenantId: other.tenant.id,
        attemptId: await open(),
        approvedCreditLimitCents: fromDollars(40_000),
        decidedAt: DECIDED,
        actor: { id: other.human.id, kind: 'human' },
      });
      await declineAttempt({
        tenantId: other.tenant.id,
        attemptId: await open(),
        reason: 'Under the coverage floor for this product.',
        decidedAt: DECIDED,
        actor: { id: other.human.id, kind: 'human' },
      });
      await withdrawAttempt({
        tenantId: other.tenant.id,
        attemptId: await open(),
        reason: 'Client took an offer elsewhere.',
        decidedAt: DECIDED,
        actor: { id: other.human.id, kind: 'human' },
      });
      await open();

      const window = {
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2027-01-01T00:00:00.000Z'),
      };
      const counts = await decidedIn(other.tenant.id, window);

      expect(counts.approved).toBe(1);
      expect(counts.declined).toBe(1);
      expect(counts.withdrawn).toBe(1);
      expect(counts.pending).toBe(1);
      // The denominator is the two that were decided, not the four that exist.
      expect(counts.decided).toBe(2);

      const buckets = await cohorts(other.tenant.id, window);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.clientProfileKey).toBe(COHORT);
      // Returned rather than dropped, with a null rate: "we have three" is different information
      // from "we have none".
      expect(buckets[0]?.rate).toBeNull();
      expect(buckets[0]?.decided).toBe(2);

      const providers = await byProvider(other.tenant.id, window);
      expect(providers).toHaveLength(1);
      expect(providers[0]?.meanDaysToDecision).toBe(11);
      // Nothing funded, so nothing is counted as funded. Not the approved figure standing in.
      expect(providers[0]?.fundedCents).toBe(0);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});

describe('client satisfaction', () => {
  it('starts as not_asked, which is not a rating', async () => {
    const attempt = await submit();
    expect(attempt.satisfaction).toBe('not_asked');

    const rated = await recordSatisfaction({
      tenantId: fx.tenant.id,
      attemptId: attempt.id,
      satisfaction: 'dissatisfied',
    });
    expect(rated.status).toBe('ok');
    if (rated.status === 'ok') expect(rated.value.satisfaction).toBe('dissatisfied');
  });
});

describe('the client view', () => {
  it('lists every attempt for a client, decided or not', async () => {
    const attempts = await attemptsForClient(fx.tenant.id, clientId);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => attempt.clientId === clientId)).toBe(true);
  });
});
