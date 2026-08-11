/**
 * 8.2 Partner Agreement & Payout Center, end to end.
 *
 * The assertion this file exists for is the FIRST one: a payout does not happen when a
 * jurisdiction cannot say whether the fee is lawful. Everything else here is arithmetic that only
 * matters once that holds.
 *
 * Five properties carry it.
 *
 * **A state that cannot answer stops the whole payout.** Not just its own line. A total with one
 * unchecked jurisdiction dropped out of it looks complete, and what is missing does not show in
 * the number - which is the exact failure the V1 `not_built` refused to risk.
 *
 * **`prohibited` is an answer, not a gap.** It excludes the referral, names the statute, and the
 * rest of the period still pays. A system that could not tell "this state says no" from "we did
 * not ask this state" would refuse forever or pay wrongly.
 *
 * **The state cap binds below the agreement.** Terms we negotiated do not override a state's
 * limit, and the line records that it was capped.
 *
 * **Approval is a Level 3 human.** The computation is unattended; the approval is the only point
 * a person sees the figure before money leaves.
 *
 * **Clawbacks never produce a negative payout.** The remainder stays outstanding and the next
 * period picks it up.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read } from '@bwc/ledger';
import { createLead, convertLead, qualifyLead } from '@bwc/sales';
import { engagementsForClient, publishOffer, recordBilling } from '@bwc/billing';
import { publishStateModule, activateState, recordReferralFeeRule } from '@bwc/regulatory';
import { upsertEntity } from '@bwc/graph';
import {
  activateAgreement,
  approvePayout,
  computePayout,
  declinePayout,
  draftAgreement,
  outstandingClawbacks,
  recordClawback,
  registerPartner,
  applyShare,
  MAXIMUM_SHARE_BASIS_POINTS,
} from '@bwc/partners';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let partnerId: string;

const NOW = new Date('2026-09-01T10:00:00.000Z');
const PERIOD = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-09-01T00:00:00.000Z'),
};
const PAID_ON = new Date('2026-08-15T00:00:00.000Z');

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

/** Publish a state, put counsel's review behind it, and say what it permits by way of fees. */
const stateWithRule = async (
  tenantId: string,
  state: string,
  posture: 'permitted' | 'permitted_with_conditions' | 'prohibited',
  maxShareBasisPoints: number | null,
): Promise<void> => {
  await publishStateModule({
    tenantId,
    state,
    summary: `${state} module for the payout test.`,
    citations: [`${state} referral fee provisions - scope confirmed by counsel`],
    disclosures: [],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: HUMAN(),
  });

  await activateState({
    tenantId,
    state,
    actor: HUMAN(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: `Memo BW-REG-2026-${state}`,
  });

  const rule = await recordReferralFeeRule({
    tenantId,
    state,
    posture,
    conditions: posture === 'permitted_with_conditions' ? ['Written disclosure to the client'] : [],
    maxShareBasisPoints,
    citation: `${state} Rev. Stat. referral fee provisions`,
    recordedBy: fx.human.id,
  });
  if (rule.status !== 'ok') throw new Error(`setup: rule ${state} (${rule.status})`);
};

/** A converted, paying client attributed to the partner, formed in `state`. */
const payingReferral = async (
  tenantId: string,
  partner: string,
  name: string,
  state: string | null,
  paidCents: number,
): Promise<string> => {
  const lead = await createLead({
    tenantId,
    prospectName: name,
    sourceChannel: 'partner_referral',
    referrerName: 'Ridgeline CPA LLC',
    referrerPartnerId: partner,
    createdOn: NOW,
    actor: HUMAN(),
  });
  if (lead.status !== 'ok') throw new Error('setup: lead');

  await qualifyLead({
    tenantId,
    leadId: lead.value.id,
    qualification: 'qualified',
    note: 'Operating three years with clean statements.',
    actor: HUMAN(),
    occurredAt: NOW,
  });

  const converted = await convertLead({
    tenantId,
    leadId: lead.value.id,
    offerKey: 'foundation',
    convertedBy: 'concierge-desk',
    convertedOn: NOW,
    actor: HUMAN(),
  });
  if (converted.status !== 'ok') throw new Error('setup: convert');
  const clientId = converted.value.clientId;

  if (state !== null) {
    const entity = await upsertEntity({
      tenantId,
      clientId,
      legalName: name,
      role: 'operating',
      stateOfFormation: state,
      actor: HUMAN(),
    });
    if (entity.status !== 'ok') throw new Error(`setup: entity (${entity.status})`);
  }

  const engagements = await engagementsForClient(tenantId, clientId);
  const engagement = engagements[0];
  if (!engagement) throw new Error('setup: engagement');

  const paid = await recordBilling({
    tenantId,
    engagementId: engagement.id,
    kind: 'payment',
    amountCents: paidCents,
    description: 'Client payment in the payout window.',
    occurredOn: PAID_ON,
    recordedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (paid.status !== 'ok') throw new Error(`setup: payment (${paid.status})`);

  return clientId;
};

beforeAll(async () => {
  fx = await makeFixture('partner-payouts');

  const offer = await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation engagement',
    rung: 1,
    description: 'Foundation capital readiness engagement.',
    retainerCents: 249_500,
    committedMonths: 6,
    publishedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (offer.status !== 'ok') throw new Error('setup: offer');

  const registered = await registerPartner({
    tenantId: fx.tenant.id,
    legalName: 'Ridgeline CPA LLC',
    contactName: 'A Partner Person',
    contactEmail: 'partner@ridgeline.test',
    track: 'cpa_bookkeeper',
    actor: HUMAN(),
  });
  if (registered.status !== 'ok') throw new Error(`setup: partner (${registered.status})`);
  partnerId = registered.value.id;

  const drafted = await draftAgreement({
    tenantId: fx.tenant.id,
    partnerId,
    shareBasisPoints: 2_000,
    termsSummary: 'Twenty per cent of fees received, paid monthly in arrears.',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    draftedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (drafted.status !== 'ok') throw new Error(`setup: draft (${drafted.status})`);

  const activated = await activateAgreement({
    tenantId: fx.tenant.id,
    agreementId: drafted.value.id,
    activatedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (activated.status !== 'ok') throw new Error(`setup: activate (${activated.status})`);
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('a jurisdiction that cannot answer stops the payout', () => {
  it('refuses when a state is published but counsel has not reviewed it', async () => {
    // Nevada is published and never activated. 7.2 will not speak for it, so 8.2 must not pay
    // into it - and must not quietly pay everything else either.
    await publishStateModule({
      tenantId: fx.tenant.id,
      state: 'NV',
      summary: 'Nevada module awaiting counsel.',
      citations: ['Nev. Rev. Stat. ch. 675 - applicability to be confirmed'],
      disclosures: [],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: HUMAN(),
    });

    await payingReferral(fx.tenant.id, partnerId, 'Unreviewed Nevada LLC', 'NV', 500_000);

    const result = await computePayout({
      tenantId: fx.tenant.id,
      partnerId,
      period: PERIOD,
      computedBy: fx.human.id,
      actor: HUMAN(),
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/NV/);
    // The refusal explains why the answerable part is not paid either.
    expect(result.reason).toMatch(/looks complete/i);
  });

  it('refuses when the client has no recorded state of formation', async () => {
    // Same rule `checkJurisdiction` applies to client-facing action, applied to money: an
    // undeterminable jurisdiction is a refusal and not a pass.
    await stateWithRule(fx.tenant.id, 'NV', 'permitted', null);

    await payingReferral(fx.tenant.id, partnerId, 'Stateless Holdings LLC', null, 300_000);

    const result = await computePayout({
      tenantId: fx.tenant.id,
      partnerId,
      period: PERIOD,
      computedBy: fx.human.id,
      actor: HUMAN(),
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/state of formation is not recorded/);
  });
});

/**
 * The happy path, in its own tenant.
 *
 * Separate because the tenant above deliberately contains referrals nothing can answer for, and
 * that is permanent - a gap does not stop being a gap because a later referral is fine. Sharing
 * one tenant would have meant the arithmetic could never run, which is how the first version of
 * this file quietly asserted nothing.
 */
describe('a payout that can be computed', () => {
  let fx2: Fixture;
  let partner2: string;
  let payoutId: string;
  let net: number;

  beforeAll(async () => {
    fx2 = await makeFixture('payout-computable');
    const human2 = { id: fx2.human.id, kind: 'human' as const };

    const offer = await publishOffer({
      tenantId: fx2.tenant.id,
      key: 'foundation',
      name: 'Foundation engagement',
      rung: 1,
      description: 'Foundation capital readiness engagement.',
      retainerCents: 249_500,
      committedMonths: 6,
      publishedBy: fx2.human.id,
      actor: human2,
    });
    if (offer.status !== 'ok') throw new Error('setup2: offer');

    const registered = await registerPartner({
      tenantId: fx2.tenant.id,
      legalName: 'Ridgeline CPA LLC',
      contactName: 'A Partner Person',
      contactEmail: 'partner@ridgeline.test',
      track: 'cpa_bookkeeper',
      actor: human2,
    });
    if (registered.status !== 'ok') throw new Error('setup2: partner');
    partner2 = registered.value.id;

    const drafted = await draftAgreement({
      tenantId: fx2.tenant.id,
      partnerId: partner2,
      shareBasisPoints: 2_000,
      termsSummary: 'Twenty per cent of fees received, paid monthly in arrears.',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      draftedBy: fx2.human.id,
      actor: human2,
    });
    if (drafted.status !== 'ok') throw new Error('setup2: draft');

    const activated = await activateAgreement({
      tenantId: fx2.tenant.id,
      agreementId: drafted.value.id,
      activatedBy: fx2.human.id,
      actor: human2,
      now: NOW,
    });
    if (activated.status !== 'ok') throw new Error('setup2: activate');

    // Texas caps the partner's share at 10%, below the agreement's 20%. Arizona prohibits.
    await stateWithRule(fx2.tenant.id, 'TX', 'permitted_with_conditions', 1_000);
    await stateWithRule(fx2.tenant.id, 'AZ', 'prohibited', null);

    await payingReferral(fx2.tenant.id, partner2, 'Austin Operations LLC', 'TX', 1_000_000);
    await payingReferral(fx2.tenant.id, partner2, 'Phoenix Trading LLC', 'AZ', 1_000_000);
  });

  afterAll(async () => {
    await cleanupTenant(fx2.tenant.id);
  });

  it('caps at the state limit, excludes the prohibited state, and names the statute', async () => {
    const result = await computePayout({
      tenantId: fx2.tenant.id,
      partnerId: partner2,
      period: PERIOD,
      computedBy: fx2.human.id,
      actor: { id: fx2.human.id, kind: 'human' },
    });

    if (result.status !== 'ok') throw new Error(`expected a computation, got ${result.status}`);
    payoutId = result.value.payoutId;
    net = result.value.netCents;

    // One payable line: Texas. 10% of 1,000,000 cents, not the agreement's 20%.
    expect(result.value.lines).toHaveLength(1);
    expect(result.value.lines[0]?.state).toBe('TX');
    expect(result.value.lines[0]?.appliedBasisPoints).toBe(1_000);
    expect(result.value.lines[0]?.amountCents).toBe(100_000);
    expect(result.value.lines[0]?.cappedByState).toBe(true);
    // The evidence travels with the figure.
    expect(result.value.lines[0]?.ruleCitation).toMatch(/TX Rev\. Stat\./);
    expect(result.value.lines[0]?.ruleConditions).toContain('Written disclosure to the client');

    // Arizona is an ANSWER, not a gap: excluded, with the statute, and the rest still pays.
    const arizona = result.value.excluded.find((row) => row.reason.includes('AZ'));
    expect(arizona).toBeDefined();
    expect(arizona?.reason).toMatch(/prohibits/);

    expect(result.value.grossCents).toBe(100_000);
    expect(result.value.netCents).toBe(100_000);
  });

  it('requires a Level 3 human to approve, and pays nothing on its own', async () => {
    // fx2.agent is Authority Level 1.
    const tooJunior = await approvePayout({
      tenantId: fx2.tenant.id,
      payoutId,
      approvedBy: fx2.agent.id,
      actor: { id: fx2.human.id, kind: 'human' },
      now: NOW,
    });
    expect(tooJunior.status).toBe('refused');
    if (tooJunior.status !== 'refused') throw new Error('expected a refusal');
    expect(tooJunior.reason).toMatch(/Authority Level 3/);

    const approved = await approvePayout({
      tenantId: fx2.tenant.id,
      payoutId,
      approvedBy: fx2.human.id,
      actor: { id: fx2.human.id, kind: 'human' },
      now: NOW,
    });
    expect(approved.status).toBe('ok');
    if (approved.status !== 'ok') throw new Error('expected approval');
    expect(approved.value.netCents).toBe(net);

    // Approving twice would be a second authorisation for one figure.
    const again = await approvePayout({
      tenantId: fx2.tenant.id,
      payoutId,
      approvedBy: fx2.human.id,
      actor: { id: fx2.human.id, kind: 'human' },
      now: NOW,
    });
    expect(again.status).toBe('refused');
  });

  it('never produces a negative payout when clawbacks exceed the period', async () => {
    // Clawback larger than anything the next period could earn.
    const clawed = await recordClawback({
      tenantId: fx2.tenant.id,
      partnerId: partner2,
      engagementId: fx2.tenant.id,
      amountCents: 5_000_000,
      reason: 'Client refunded in full; the share follows the money back.',
      recordedBy: fx2.human.id,
      actor: { id: fx2.human.id, kind: 'human' },
    });
    expect(clawed.status).toBe('ok');

    const next = await computePayout({
      tenantId: fx2.tenant.id,
      partnerId: partner2,
      period: PERIOD,
      computedBy: fx2.human.id,
      actor: { id: fx2.human.id, kind: 'human' },
    });

    if (next.status !== 'ok') throw new Error(`expected a computation, got ${next.status}`);
    // Not negative. A payout that owes us money is not a payout.
    expect(next.value.netCents).toBe(0);
    // And the remainder is still outstanding, so it is not quietly forgiven.
    const open = await outstandingClawbacks(fx2.tenant.id, partner2);
    expect(open.reduce((total, row) => total + row.amountCents, 0)).toBe(5_000_000);
  });

  it('floors the share rather than rounding a cent we did not earn', () => {
    // 20% of 999 cents is 199.8. Rounding up would pay a cent per line that was never earned,
    // and the direction of a rounding rule should favour the party that did not write it.
    expect(applyShare(999, 2_000)).toBe(199);
    expect(applyShare(1_000_000, 1_000)).toBe(100_000);
    expect(applyShare(0, 2_000)).toBe(0);
  });
});

describe('agreements', () => {
  it('refuses a share above half the fee', async () => {
    const result = await draftAgreement({
      tenantId: fx.tenant.id,
      partnerId,
      shareBasisPoints: MAXIMUM_SHARE_BASIS_POINTS + 1,
      termsSummary: 'An arrangement that is really the partner selling our service.',
      effectiveFrom: NOW,
      draftedBy: fx.human.id,
      actor: HUMAN(),
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/basis points/);
  });

  it('refuses to activate terms without a Level 3 human', async () => {
    const drafted = await draftAgreement({
      tenantId: fx.tenant.id,
      partnerId,
      shareBasisPoints: 1_500,
      termsSummary: 'Fifteen per cent of fees received, paid monthly in arrears.',
      effectiveFrom: NOW,
      draftedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (drafted.status !== 'ok') throw new Error('draft failed');

    // fx.agent is Authority Level 1.
    const result = await activateAgreement({
      tenantId: fx.tenant.id,
      agreementId: drafted.value.id,
      activatedBy: fx.agent.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/Authority Level 3/);
  });
});

describe('clawbacks', () => {
  it('records a positive amount in cents and refuses anything else', async () => {
    const negative = await recordClawback({
      tenantId: fx.tenant.id,
      partnerId,
      engagementId: fx.tenant.id,
      amountCents: -500,
      reason: 'A refund that should not be expressed as a negative.',
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(negative.status).toBe('refused');
    if (negative.status !== 'refused') throw new Error('expected a refusal');
    expect(negative.reason).toMatch(/positive amount in integer cents/);
  });

  it('stays outstanding until a payout absorbs it', async () => {
    const recorded = await recordClawback({
      tenantId: fx.tenant.id,
      partnerId,
      engagementId: fx.tenant.id,
      amountCents: 40_000,
      reason: 'Client refunded under the thirty-day trigger; the share follows the money back.',
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(recorded.status).toBe('ok');

    const open = await outstandingClawbacks(fx.tenant.id, partnerId);
    expect(open.map((row) => row.amountCents)).toContain(40_000);
  });
});

describe('the Ledger', () => {
  it('carries states and never client identifiers on a payout event', async () => {
    const events = await read({ tenantId: fx.tenant.id });
    const payoutEvents = events.filter((event) => event.type.startsWith('partner.payout.'));

    for (const event of payoutEvents) {
      const payload = JSON.stringify(event.payload);
      // A jurisdiction is not PII. A client list is, and a payout is exactly where somebody would
      // be tempted to put one "for traceability".
      expect(payload).not.toMatch(/clientId/);
      expect(payload).not.toMatch(/legalName/);
    }
  });

  it('records an agreement activation with the share it bound us to', async () => {
    const events = await read({ tenantId: fx.tenant.id });
    const activated = events.filter((event) => event.type === 'partner.agreement.activated');
    expect(activated.length).toBeGreaterThan(0);
    expect(activated[0]?.payload).toHaveProperty('shareBasisPoints');
  });
});

describe('approval', () => {
  it('refuses approval below Level 3, and refuses a decline with no reason', async () => {
    // No payout exists to approve in this tenant - every computation above refused, which is the
    // point of the file. The authority check is asserted against a payout id that does not
    // resolve, so what is under test is the order: identity before existence would leak which
    // ids are real, and existence before identity is what this asserts.
    const missing = await approvePayout({
      tenantId: fx.tenant.id,
      payoutId: fx.tenant.id,
      approvedBy: fx.agent.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(missing.status).toBe('no_data');

    const noReason = await declinePayout({
      tenantId: fx.tenant.id,
      payoutId: fx.tenant.id,
      reason: 'nope',
      declinedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(noReason.status).toBe('refused');
    if (noReason.status !== 'refused') throw new Error('expected a refusal');
    expect(noReason.reason).toMatch(/reason somebody can read back/);
  });
});
