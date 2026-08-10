/**
 * 1.4 Pricing, Billing & Offer Management, against a real database.
 *
 * Two properties carry this file.
 *
 * **A refund the record entitles a client to is computed, not requested.** Granting one needs
 * nobody's approval; declining one needs a Level 3 human and a recorded reason. A system where
 * refunds are discretionary is a system where refunds do not happen.
 *
 * **The same payment cannot be credited twice.** Credit draws on a specific billing record, so
 * double-crediting is arithmetically impossible rather than procedurally discouraged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  applyCredit,
  availableCredit,
  balanceOf,
  cancelEngagement,
  declineRefund,
  exhibitInputFor,
  formatMoney,
  fromDollars,
  markFunded,
  payRefund,
  publishOffer,
  quoteUpgrade,
  recordBilling,
  recordFundingOutcome,
  refundsDue,
  startEngagement,
  totalAvailableCredit,
  unresolvedRefunds,
} from '@bwc/billing';
import { buildFeeExhibit } from '@bwc/contracts';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const STARTED = new Date('2026-01-15T00:00:00.000Z');

beforeAll(async () => {
  fx = await makeFixture('billing');
  const client = await createClient(fx.tenant.id, 'Billed Co', human());
  clientId = client.id;

  // A two-rung ladder. The commercial figures here are the test's, not the company's - what to
  // charge is a business decision and this slice seeds no real offers.
  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    minimumCents: fromDollars(2_495),
    publishedBy: 'concierge-desk',
    actor: human(),
  });

  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'growth',
    name: 'Growth',
    rung: 2,
    description: 'Second rung.',
    retainerCents: fromDollars(7_500),
    monthlyCents: fromDollars(1_250),
    successFeeBasisPoints: 850,
    committedMonths: 12,
    publishedBy: 'concierge-desk',
    actor: human(),
  });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}
const agent = () => ({ id: fx.agent.id, kind: 'village_agent' as const });

const newEngagement = async (offerKey: string, annualPrepay = false) => {
  const result = await startEngagement({
    tenantId: fx.tenant.id,
    clientId,
    offerKey,
    startedOn: STARTED,
    annualPrepay,
    actor: human(),
  });
  if (result.status !== 'ok') throw new Error('fixture engagement failed');
  return result.value;
};

const charge = (engagementId: string, cents: number, description: string, approved?: number) =>
  recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'charge',
    amountCents: cents,
    description,
    ...(approved !== undefined ? { approvedCreditLimitCents: approved } : {}),
    occurredOn: STARTED,
    recordedBy: 'concierge-desk',
    actor: human(),
  });

const pay = (engagementId: string, cents: number, description = 'Payment received') =>
  recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'payment',
    amountCents: cents,
    description,
    occurredOn: STARTED,
    recordedBy: 'concierge-desk',
    actor: human(),
  });

describe('the 60-day approved-but-unfunded trigger', () => {
  it('does not fire on day 60, and does on day 61', async () => {
    // "Within 60 days" includes the sixtieth. An off-by-one here either pays refunds a day early
    // or leaves a client waiting a day past their entitlement, and both are visible to them.
    const engagement = await newEngagement('growth');
    const approvedLimit = fromDollars(85_000);

    await charge(engagement.id, fromDollars(7_225), 'Success fee on approved limit', approvedLimit);
    await recordFundingOutcome({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      clientId,
      provider: 'Meridian National Bank',
      approvedCreditLimitCents: approvedLimit,
      approvedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });

    const day60 = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-04-30T00:00:00.000Z'),
    );
    expect(day60).toHaveLength(0);

    const day61 = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-05-01T00:00:00.000Z'),
    );
    expect(day61).toHaveLength(1);
    expect(day61[0]?.trigger).toBe('approved_not_funded_60_days');
    expect(day61[0]?.amountCents).toBe(fromDollars(7_225));
    expect(day61[0]?.basis).toMatch(/has not funded in 61 days/);
  });

  it('retires the entitlement once the capital funds', async () => {
    const engagement = await newEngagement('growth');
    const approvedLimit = fromDollars(50_000);

    await charge(engagement.id, fromDollars(4_250), 'Success fee', approvedLimit);
    const outcome = await recordFundingOutcome({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      clientId,
      provider: 'Swiftline Capital',
      approvedCreditLimitCents: approvedLimit,
      approvedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });
    if (outcome.status !== 'ok') throw new Error('fixture failed');

    const before = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-05-10T00:00:00.000Z'),
    );
    expect(before).toHaveLength(1);

    await markFunded({
      tenantId: fx.tenant.id,
      outcomeId: outcome.value.id,
      fundedOn: new Date('2026-05-05T00:00:00.000Z'),
      fundedCents: fromDollars(50_000),
      actor: human(),
    });

    const after = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-05-10T00:00:00.000Z'),
    );
    expect(after).toHaveLength(0);
  });

  it('matches the fee to the approval by the approved limit, not by amount or date', async () => {
    // Two approvals in one engagement is the ordinary case that breaks a looser match.
    const engagement = await newEngagement('growth');

    await charge(engagement.id, fromDollars(1_700), 'Success fee A', fromDollars(20_000));
    await charge(engagement.id, fromDollars(2_550), 'Success fee B', fromDollars(30_000));

    for (const [limit, provider] of [
      [fromDollars(20_000), 'Provider A'],
      [fromDollars(30_000), 'Provider B'],
    ] as const) {
      await recordFundingOutcome({
        tenantId: fx.tenant.id,
        engagementId: engagement.id,
        clientId,
        provider,
        approvedCreditLimitCents: limit,
        approvedOn: new Date('2026-03-01T00:00:00.000Z'),
        actor: human(),
      });
    }

    const due = await refundsDue(fx.tenant.id, engagement.id, new Date('2026-05-10T00:00:00.000Z'));
    expect(due).toHaveLength(2);
    expect(due.map((entry) => entry.amountCents).sort((a, b) => a - b)).toEqual([
      fromDollars(1_700),
      fromDollars(2_550),
    ]);
  });
});

describe('unearned prepay on cancellation', () => {
  it('prorates by elapsed days, to the cent, in the client’s favour', async () => {
    // A client who cancels on the second of the month has not consumed that month. Rounding a
    // part-month up to a whole one would take a month's fee for a day's service.
    const engagement = await newEngagement('growth', true);
    await pay(engagement.id, fromDollars(15_000), 'Annual prepay');

    await cancelEngagement({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      reason: 'Client sold the business.',
      cancelledOn: new Date('2026-04-15T00:00:00.000Z'),
      actor: human(),
    });

    const due = await refundsDue(fx.tenant.id, engagement.id, new Date('2026-04-20T00:00:00.000Z'));
    const prepay = due.find((entry) => entry.trigger === 'unearned_prepay_on_cancellation');

    // Term 2026-01-15 to 2027-01-15 is 365 days; 90 elapsed, 275 unused.
    // 1,500,000 cents x 275 / 365 = 1,130,136.98..., floored toward the client.
    expect(prepay?.amountCents).toBe(1_130_136);
    expect(formatMoney(prepay?.amountCents ?? 0)).toBe('$11,301.36');
    expect(prepay?.basis).toMatch(/275 days were paid for and not delivered/);
  });

  it('owes nothing when the full term elapsed', async () => {
    const engagement = await newEngagement('growth', true);
    await pay(engagement.id, fromDollars(15_000), 'Annual prepay');
    await cancelEngagement({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      reason: 'Term completed; client chose not to renew.',
      cancelledOn: new Date('2027-02-01T00:00:00.000Z'),
      actor: human(),
    });

    const due = await refundsDue(fx.tenant.id, engagement.id, new Date('2027-02-02T00:00:00.000Z'));
    expect(due.some((entry) => entry.trigger === 'unearned_prepay_on_cancellation')).toBe(false);
  });

  it('requires a reason to cancel, because the reason drives the entitlement', async () => {
    const engagement = await newEngagement('foundation');
    const result = await cancelEngagement({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      reason: '   ',
      cancelledOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('engagement quality failure', () => {
  it('fires when the committed window ended with no approval obtained', async () => {
    // The blueprint's phrase is not objective as written. This is the measurable definition the
    // module supplies, and it is flagged for review rather than dressed up as a fact.
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');

    const before = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(before).toHaveLength(0);

    const after = await refundsDue(
      fx.tenant.id,
      engagement.id,
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const failure = after.find((entry) => entry.trigger === 'engagement_quality_failure');
    expect(failure?.amountCents).toBe(fromDollars(2_495));
    expect(failure?.basis).toMatch(/no funding approval obtained/);
  });

  it('does not fire when an approval was obtained', async () => {
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');
    await recordFundingOutcome({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      clientId,
      provider: 'Meridian National Bank',
      approvedCreditLimitCents: fromDollars(40_000),
      approvedOn: new Date('2026-03-01T00:00:00.000Z'),
      fundedOn: new Date('2026-03-20T00:00:00.000Z'),
      fundedCents: fromDollars(40_000),
      actor: human(),
    });

    const due = await refundsDue(fx.tenant.id, engagement.id, new Date('2026-08-01T00:00:00.000Z'));
    expect(due.some((entry) => entry.trigger === 'engagement_quality_failure')).toBe(false);
  });
});

describe('granting is easy and declining is not', () => {
  it('pays an entitled refund without needing approval, and records the basis', async () => {
    const engagement = await newEngagement('growth');
    const approvedLimit = fromDollars(60_000);
    await charge(engagement.id, fromDollars(5_100), 'Success fee', approvedLimit);
    await recordFundingOutcome({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      clientId,
      provider: 'Dormant Trust Bank',
      approvedCreditLimitCents: approvedLimit,
      approvedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });

    const paidOn = new Date('2026-05-10T00:00:00.000Z');
    const result = await payRefund({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      trigger: 'approved_not_funded_60_days',
      amountCents: fromDollars(5_100),
      paidBy: 'concierge-desk-agent',
      paidOn,
      actor: agent(),
    });

    // An agent can pay it. The money was already owed, and a sign-off to hand back something the
    // record says is not ours is the friction that stops it happening.
    expect(result.status).toBe('ok');

    const balance = await balanceOf(fx.tenant.id, engagement.id);
    if (balance.status !== 'ok') throw new Error('expected a balance');
    expect(balance.value.refunded).toBe(fromDollars(5_100));

    const events = await read({ tenantId: fx.tenant.id, type: 'billing.refund.paid' });
    expect(events.some((event) => String(event.payload['basis']).includes('not earned'))).toBe(
      true,
    );
  });

  it('refuses to record a refund the record cannot explain', async () => {
    // Not a refusal to be generous. An ex-gratia payment is a legitimate business decision and
    // belongs in a path that says so, rather than appearing in the ledger as an objective refund.
    const engagement = await newEngagement('growth');
    const result = await payRefund({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      trigger: 'approved_not_funded_60_days',
      amountCents: fromDollars(1_000),
      paidBy: 'concierge-desk-agent',
      paidOn: new Date('2026-05-10T00:00:00.000Z'),
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/does not show a/);
  });

  it('refuses a decline by an agent, and a decline with no reason', async () => {
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');
    const decidedAt = new Date('2026-08-01T00:00:00.000Z');

    const byAgent = await declineRefund({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      trigger: 'engagement_quality_failure',
      amountCents: fromDollars(2_495),
      reason: 'An agent trying to decline a refund.',
      actor: agent(),
      decidedBy: 'some-agent',
      decidedAt,
    });
    expect(byAgent.status).toBe('refused');
    if (byAgent.status === 'refused') expect(byAgent.reason).toMatch(/Authority Level 3/);

    const noReason = await declineRefund({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      trigger: 'engagement_quality_failure',
      amountCents: fromDollars(2_495),
      reason: '  ',
      actor: human(),
      decidedBy: 'compliance@burkhamwickmont.test',
      decidedAt,
    });
    expect(noReason.status).toBe('refused');
  });

  it('records a decline with its reason, and keeps the entitlement visible', async () => {
    // A list that silently dropped a declined entitlement would make the decline invisible to
    // everyone except whoever made it.
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');
    const decidedAt = new Date('2026-08-01T00:00:00.000Z');

    const declined = await declineRefund({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      trigger: 'engagement_quality_failure',
      amountCents: fromDollars(2_495),
      reason: 'Client withdrew from three scheduled underwriting calls; engagement was delivered.',
      actor: human(),
      decidedBy: 'compliance@burkhamwickmont.test',
      decidedAt,
    });
    expect(declined.status).toBe('ok');

    const due = await refundsDue(fx.tenant.id, engagement.id, decidedAt);
    expect(due.find((entry) => entry.trigger === 'engagement_quality_failure')?.resolved).toBe(
      'declined',
    );
    expect(await unresolvedRefunds(fx.tenant.id, engagement.id, decidedAt)).toHaveLength(0);

    const events = await read({ tenantId: fx.tenant.id, type: 'billing.refund.declined' });
    expect(
      events.some((event) => String(event.payload['reason']).includes('three scheduled')),
    ).toBe(true);
  });
});

describe('the credit chain', () => {
  /**
   * Its own client.
   *
   * The first version of this block reused the shared client and asserted that a second credit
   * would be refused - which failed, correctly, because earlier tests in this file had left other
   * payments on that client and the second credit drew from those instead. The fixture was wrong,
   * not the code. An isolated client makes "there is nothing left to draw" a fact rather than a
   * hope about test ordering.
   */
  let creditClientId: string;

  beforeAll(async () => {
    const isolated = await createClient(fx.tenant.id, 'Credit Chain Co', human());
    creditClientId = isolated.id;
  });

  const engagementFor = async (offerKey: string) => {
    const result = await startEngagement({
      tenantId: fx.tenant.id,
      clientId: creditClientId,
      offerKey,
      startedOn: STARTED,
      actor: human(),
    });
    if (result.status !== 'ok') throw new Error('fixture engagement failed');
    return result.value;
  };

  it('cannot credit the same payment twice', async () => {
    // The failure the whole design is arranged around. Credit draws on a specific billing record,
    // so a second draw sees only what the first left.
    const first = await engagementFor('foundation');
    await pay(first.id, fromDollars(2_495), 'Foundation retainer paid');

    expect(await totalAvailableCredit(fx.tenant.id, creditClientId)).toBe(fromDollars(2_495));

    const upgraded = await engagementFor('growth');
    const applied = await applyCredit({
      tenantId: fx.tenant.id,
      clientId: creditClientId,
      toEngagementId: upgraded.id,
      amountCents: fromDollars(2_495),
      rationale: 'Foundation retainer credited against the Growth upgrade.',
      appliedBy: 'concierge-desk',
      appliedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });
    expect(applied.status).toBe('ok');

    // The source payment is fully consumed, so nothing offers it again.
    const sources = await availableCredit(fx.tenant.id, creditClientId);
    expect(sources.find((source) => source.engagementId === first.id)).toBeUndefined();
    expect(await totalAvailableCredit(fx.tenant.id, creditClientId)).toBe(0);

    const second = await engagementFor('growth');
    const again = await applyCredit({
      tenantId: fx.tenant.id,
      clientId: creditClientId,
      toEngagementId: second.id,
      amountCents: fromDollars(2_495),
      rationale: 'Trying to spend the same payment twice.',
      appliedBy: 'concierge-desk',
      appliedOn: new Date('2026-03-02T00:00:00.000Z'),
      actor: human(),
    });
    expect(again.status).toBe('refused');
    if (again.status === 'refused') expect(again.reason).toMatch(/only \$0\.00 is available/);
  });

  it('draws partially and leaves the remainder available', async () => {
    const engagement = await engagementFor('foundation');
    await pay(engagement.id, fromDollars(1_000), 'Payment to be drawn in parts');

    const target = await engagementFor('growth');
    const first = await applyCredit({
      tenantId: fx.tenant.id,
      clientId: creditClientId,
      toEngagementId: target.id,
      amountCents: fromDollars(400),
      rationale: 'First draw.',
      appliedBy: 'concierge-desk',
      appliedOn: new Date('2026-03-03T00:00:00.000Z'),
      actor: human(),
    });
    expect(first.status).toBe('ok');
    expect(await totalAvailableCredit(fx.tenant.id, creditClientId)).toBe(fromDollars(600));

    // And the total drawn from that one payment can never exceed the payment itself.
    const sources = await availableCredit(fx.tenant.id, creditClientId);
    for (const source of sources) {
      expect(source.alreadyDrawnCents + source.availableCents).toBeLessThanOrEqual(
        source.paidCents,
      );
    }
  });

  it('refuses rather than clamping when credit is short', async () => {
    // Applying a smaller credit and reporting success leaves an unexplained difference on an
    // invoice a client is reading.
    const engagement = await newEngagement('growth');
    const result = await applyCredit({
      tenantId: fx.tenant.id,
      clientId,
      toEngagementId: engagement.id,
      amountCents: fromDollars(999_999),
      rationale: 'More than exists.',
      appliedBy: 'concierge-desk',
      appliedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/is available across/);
  });

  it('requires a rationale', async () => {
    const engagement = await newEngagement('growth');
    const result = await applyCredit({
      tenantId: fx.tenant.id,
      clientId,
      toEngagementId: engagement.id,
      amountCents: fromDollars(1),
      rationale: '  ',
      appliedBy: 'concierge-desk',
      appliedOn: new Date('2026-03-01T00:00:00.000Z'),
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });

  it('does not offer refunded money as credit', async () => {
    // Money handed back is not available to carry forward.
    const engagement = await newEngagement('foundation');
    await pay(engagement.id, fromDollars(1_000), 'Partial payment');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');

    const beforeRefund = await availableCredit(fx.tenant.id, clientId);
    const thisEngagement = beforeRefund.filter((s) => s.engagementId === engagement.id);
    expect(thisEngagement[0]?.availableCents).toBe(fromDollars(1_000));

    await recordBilling({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      kind: 'refund',
      amountCents: fromDollars(1_000),
      description: 'Refund of the partial payment',
      occurredOn: new Date('2026-03-01T00:00:00.000Z'),
      recordedBy: 'concierge-desk',
      actor: human(),
    });

    const afterRefund = await availableCredit(fx.tenant.id, clientId);
    expect(afterRefund.some((source) => source.engagementId === engagement.id)).toBe(false);
  });

  it('quotes an upgrade and refuses a downgrade', async () => {
    const up = await quoteUpgrade({
      tenantId: fx.tenant.id,
      clientId,
      fromOfferKey: 'foundation',
      toOfferKey: 'growth',
    });
    expect(up.status).toBe('ok');
    if (up.status === 'ok') {
      expect(up.value.toRung).toBe(2);
      expect(up.value.netToPayCents).toBeGreaterThanOrEqual(0);
    }

    const down = await quoteUpgrade({
      tenantId: fx.tenant.id,
      clientId,
      fromOfferKey: 'growth',
      toOfferKey: 'foundation',
    });
    expect(down.status).toBe('refused');
    if (down.status === 'refused') expect(down.reason).toMatch(/not an upgrade/);
  });
});

describe('the fee exhibit is built from the engagement', () => {
  it('takes its figures from the offer rather than from a caller', async () => {
    // The gap 7.3 recorded in its own Fact Check List: until now nothing checked that the tier
    // and figures passed to the exhibit matched the engagement actually sold.
    const engagement = await newEngagement('growth');

    const input = await exhibitInputFor({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      approvedCreditLimitCents: fromDollars(85_000),
    });
    expect(input.status).toBe('ok');
    if (input.status !== 'ok') return;

    expect(input.value.offerTier).toBe('Growth');
    expect(input.value.retainer?.amount).toBe(7_500);
    expect(input.value.monthly).toEqual({ amount: 1_250, months: 12 });
    expect(input.value.successFee?.ratePercent).toBe(8.5);

    const exhibit = buildFeeExhibit(input.value);
    if (exhibit.status !== 'ok') throw new Error('expected an exhibit');

    // 7,500 + (1,250 x 12) + 8.5% of 85,000 = 7,500 + 15,000 + 7,225.
    expect(exhibit.value.knownTotal).toBe(29_725);
    expect(exhibit.value.contingentLines).toHaveLength(0);
  });

  it('presents the success fee as contingent when no approval exists', async () => {
    const engagement = await newEngagement('growth');
    const input = await exhibitInputFor({ tenantId: fx.tenant.id, engagementId: engagement.id });
    if (input.status !== 'ok') throw new Error('expected an exhibit input');

    expect(input.value.successFee?.approvedCreditLimit).toBeUndefined();

    const exhibit = buildFeeExhibit(input.value);
    if (exhibit.status !== 'ok') throw new Error('expected an exhibit');
    expect(exhibit.value.contingentLines).toHaveLength(1);
  });
});

describe('the balance names its components', () => {
  it('reports charged, paid, refunded and credited separately', async () => {
    // "You owe $4,200" answers less than the four numbers that produced it, and a client
    // disputing an invoice is asking about one of the four.
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(2_495), 'Engagement retainer');
    await pay(engagement.id, fromDollars(1_000), 'Deposit');

    const balance = await balanceOf(fx.tenant.id, engagement.id);
    if (balance.status !== 'ok') throw new Error('expected a balance');

    expect(balance.value.charged).toBe(fromDollars(2_495));
    expect(balance.value.paid).toBe(fromDollars(1_000));
    expect(balance.value.outstanding).toBe(fromDollars(1_495));
    expect(balance.value.meetsMinimum).toBe(false);
    expect(balance.value.minimumCents).toBe(fromDollars(2_495));
  });

  it('never reports a negative outstanding balance', async () => {
    // An overpayment is a credit, not a debt owed to the client on this engagement.
    const engagement = await newEngagement('foundation');
    await charge(engagement.id, fromDollars(100), 'Small charge');
    await pay(engagement.id, fromDollars(500), 'Overpayment');

    const balance = await balanceOf(fx.tenant.id, engagement.id);
    if (balance.status !== 'ok') throw new Error('expected a balance');
    expect(balance.value.outstanding).toBe(0);
  });

  it('refuses a negative billing line rather than netting it', async () => {
    const engagement = await newEngagement('foundation');
    const result = await recordBilling({
      tenantId: fx.tenant.id,
      engagementId: engagement.id,
      kind: 'charge',
      amountCents: -100,
      description: 'A negative charge',
      occurredOn: STARTED,
      recordedBy: 'concierge-desk',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});
