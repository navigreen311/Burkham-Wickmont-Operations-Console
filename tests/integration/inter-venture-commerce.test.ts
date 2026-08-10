/**
 * 10.1 Inter-Venture Commerce Hooks, end to end.
 *
 * Three properties carry this file.
 *
 * **One acknowledgement is not a disclosure.** The test that matters is the middle state: a
 * disclosure the venture has acknowledged and Gardner has not still refuses. A build where
 * generating the document was enough would pass everything else here.
 *
 * **A premium needs approval as much as a discount.** The direction that flatters our own numbers
 * is the one nobody would report, so it is asserted explicitly.
 *
 * **A Collingswood handoff re-checks consent at transfer.** Revocation is tested by revoking
 * between the consent and the transfer, which is exactly when a person changes their mind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { grant, revoke, forClient as consentsForClient } from '@bwc/consent';
import { publishOffer, startEngagement, fromDollars } from '@bwc/billing';
import { read } from '@bwc/ledger';
import {
  HANDOFF_CONSENT_KIND,
  acknowledgeByGardner,
  acknowledgeByVenture,
  allRelationships,
  awaitingRouting,
  checkAgainstLadder,
  confirmVenture,
  declineHandoff,
  deviationsFor,
  generateDisclosure,
  invoicesFor,
  mayCharge,
  mayProceed,
  proposeHandoff,
  raiseInvoice,
  recordConsent,
  recordDeviation,
  relationshipFor,
  routeToGardnerLedger,
  tagIfVenture,
  transferHandoff,
  withdrawDisclosure,
} from '@bwc/interventure';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let medlink: string;
let stranger: string;
let ambiguous: string;
let medlinkEngagement: string;
let strangerEngagement: string;

const NOW = new Date('2026-08-10T12:00:00.000Z');
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const RETAINER = fromDollars(2_495);

beforeAll(async () => {
  fx = await makeFixture('inter-venture');

  const offer = await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: RETAINER,
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: HUMAN(),
  });
  if (offer.status !== 'ok') throw new Error('setup: offer');

  const [a, b, c] = await Promise.all([
    createClient(fx.tenant.id, 'MedLink Pro LLC', HUMAN()),
    createClient(fx.tenant.id, 'Lone Star Fabrication LLC', HUMAN()),
    createClient(fx.tenant.id, 'Green Valley Landscaping LLC', HUMAN()),
  ]);
  medlink = a.id;
  stranger = b.id;
  ambiguous = c.id;

  for (const [clientId, target] of [
    [medlink, 'medlink'],
    [stranger, 'stranger'],
  ] as const) {
    const engagement = await startEngagement({
      tenantId: fx.tenant.id,
      clientId,
      offerKey: 'foundation',
      startedOn: new Date('2026-08-01T00:00:00.000Z'),
      startedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (engagement.status !== 'ok') throw new Error(`setup: engagement ${engagement.status}`);
    if (target === 'medlink') medlinkEngagement = engagement.value.id;
    else strangerEngagement = engagement.value.id;
  }
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('10.1 automatic tagging', () => {
  it('tags a venture client, deriving Gardner visibility', async () => {
    const tagged = await tagIfVenture({
      tenantId: fx.tenant.id,
      clientId: medlink,
      actor: HUMAN(),
      now: NOW,
    });

    expect(tagged.status).toBe('ok');
    if (tagged.status !== 'ok') return;
    expect(tagged.value.ventureKey).toBe('medlink');
    expect(tagged.value.gardnerVisible).toBe(true);
    expect(tagged.value.detectionBasis).toMatch(/related-party/);
  });

  it('is idempotent, so it can run wherever a client is created', async () => {
    const again = await tagIfVenture({
      tenantId: fx.tenant.id,
      clientId: medlink,
      actor: HUMAN(),
      now: NOW,
    });
    expect(again.status).toBe('ok');
    expect(
      (await allRelationships(fx.tenant.id)).filter((r) => r.clientId === medlink),
    ).toHaveLength(1);
  });

  it('reports an unrelated client as no_data rather than refusing', async () => {
    // Being a normal client is not an error path, and a refusal here would make the caller treat
    // the ordinary case as one.
    const result = await tagIfVenture({
      tenantId: fx.tenant.id,
      clientId: stranger,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('no_data');
    expect(await relationshipFor(fx.tenant.id, stranger)).toBeNull();
  });

  it('refuses an ambiguous name and takes a human confirmation', async () => {
    const result = await tagIfVenture({
      tenantId: fx.tenant.id,
      clientId: ambiguous,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');

    // The route through: a person answers the question the detector could not.
    const confirmed = await confirmVenture({
      tenantId: fx.tenant.id,
      clientId: ambiguous,
      ventureKey: 'greenstone',
      confirmedBy: 'compliance-officer',
      actor: HUMAN(),
      now: NOW,
    });
    expect(confirmed.status).toBe('ok');
    if (confirmed.status === 'ok') {
      expect(confirmed.value.detectionBasis).toMatch(/Confirmed by/);
    }
  });
});

describe('10.1 generating a disclosure is not disclosing', () => {
  let disclosureId: string;
  let contentHash: string;

  it('refuses work on an intercompany engagement with no disclosure at all', async () => {
    const verdict = await mayProceed(fx.tenant.id, medlink, medlinkEngagement);
    expect(verdict.status).toBe('refused');
    if (verdict.status === 'refused') {
      expect(verdict.reason).toMatch(/no conflict-of-interest disclosure has been generated/);
    }
  });

  it('passes an ordinary client straight through', async () => {
    const verdict = await mayProceed(fx.tenant.id, stranger, strangerEngagement);
    expect(verdict.status).toBe('ok');
    if (verdict.status === 'ok') expect(verdict.value.intercompany).toBe(false);
  });

  it('generates the artifact automatically', async () => {
    const generated = await generateDisclosure({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      engagementDescription: 'Foundation capital readiness engagement',
      actor: HUMAN(),
      now: NOW,
    });

    expect(generated.status).toBe('ok');
    if (generated.status !== 'ok') return;
    disclosureId = generated.value.id;
    contentHash = generated.value.contentHash;
    expect(generated.value.state).toBe('drafted');
    expect(generated.value.complete).toBe(false);
  });

  it('still refuses work with the artifact generated and nothing acknowledged', async () => {
    const verdict = await mayProceed(fx.tenant.id, medlink, medlinkEngagement);
    expect(verdict.status).toBe('refused');
    if (verdict.status === 'refused') {
      expect(verdict.reason).toMatch(/MedLink Pro and Gardner/);
      expect(verdict.reason).toMatch(/Generating a disclosure is not disclosing it/);
    }
  });

  it('refuses an acknowledgement of a different text', async () => {
    const wrong = await acknowledgeByVenture({
      tenantId: fx.tenant.id,
      disclosureId,
      representative: 'A. Officer, MedLink Pro',
      acknowledgedContentHash: 'not-the-hash',
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(wrong.status).toBe('refused');
    if (wrong.status === 'refused') expect(wrong.reason).toMatch(/does not match/);
  });

  it('STILL REFUSES after only the venture has acknowledged', async () => {
    const acknowledged = await acknowledgeByVenture({
      tenantId: fx.tenant.id,
      disclosureId,
      representative: 'A. Officer, MedLink Pro',
      acknowledgedContentHash: contentHash,
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(acknowledged.status).toBe('ok');
    if (acknowledged.status === 'ok') expect(acknowledged.value.state).toBe('venture_acknowledged');

    // THE ASSERTION THIS FILE EXISTS FOR. A build where one acknowledgement sufficed - or where
    // generating was enough - passes everything above and fails here.
    const verdict = await mayProceed(fx.tenant.id, medlink, medlinkEngagement);
    expect(verdict.status).toBe('refused');
    if (verdict.status === 'refused') {
      expect(verdict.reason).toMatch(/acknowledged by: Gardner/);
    }
  });

  it('needs a Level 3 human for the Gardner acknowledgement', async () => {
    const byAgent = await acknowledgeByGardner({
      tenantId: fx.tenant.id,
      disclosureId,
      acknowledgedBy: fx.agent.id,
      acknowledgedContentHash: contentHash,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');
  });

  it('proceeds once both parties have acknowledged', async () => {
    const gardner = await acknowledgeByGardner({
      tenantId: fx.tenant.id,
      disclosureId,
      acknowledgedBy: fx.human.id,
      acknowledgedContentHash: contentHash,
      actor: HUMAN(),
      now: NOW,
    });
    expect(gardner.status).toBe('ok');
    if (gardner.status === 'ok') expect(gardner.value.complete).toBe(true);

    const verdict = await mayProceed(fx.tenant.id, medlink, medlinkEngagement);
    expect(verdict.status).toBe('ok');
    if (verdict.status === 'ok') {
      expect(verdict.value.intercompany).toBe(true);
      expect(verdict.value.disclosure?.complete).toBe(true);
    }
  });

  it('records both acknowledgements in the ledger', async () => {
    const events = await read({
      tenantId: fx.tenant.id,
      type: 'interventure.disclosure.acknowledged',
    });
    const by = events.map((event) => event.payload['by']);
    expect(by).toContain('venture');
    expect(by).toContain('gardner');
  });
});

describe("10.1 arm's length is the published price", () => {
  it('passes at the published price with no approval needed', async () => {
    const check = await checkAgainstLadder({
      tenantId: fx.tenant.id,
      offerKey: 'foundation',
      chargedCents: RETAINER,
    });
    expect(check.status).toBe('ok');
    if (check.status === 'ok') {
      expect(check.value.atPublishedPrice).toBe(true);
      expect(check.value.detail).toMatch(/what unrelated clients pay/);
    }

    const allowed = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: RETAINER,
    });
    expect(allowed.status).toBe('ok');
  });

  it('refuses an unapproved discount to a sibling', async () => {
    const result = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(1_000),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/moves profit out of Burkham Wickmont/);
    }
  });

  it('refuses an unapproved PREMIUM too', async () => {
    // The direction that flatters our own numbers is the one nobody would report. A system that
    // questioned only discounts would police one direction of the same thing.
    const result = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(4_000),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/moves profit into Burkham Wickmont/);
    }
  });

  it('leaves an ordinary client alone', async () => {
    // 1.4 owns ordinary pricing; a commercial discount to a stranger is not this module's view.
    const result = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: stranger,
      engagementId: strangerEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(1_000),
    });
    expect(result.status).toBe('ok');
  });

  it('records an approved deviation and then permits that exact amount', async () => {
    const noBasis = await recordDeviation({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(1_000),
      basis: 'sibling',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(noBasis.status).toBe('refused');

    const approved = await recordDeviation({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(1_000),
      basis:
        'Gardner-approved intercompany services agreement, clause 4: shared-services rate applies where the venture supplies its own document preparation.',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(approved.status).toBe('ok');
    if (approved.status === 'ok') expect(approved.value.direction).toBe('discount');

    const allowed = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(1_000),
    });
    expect(allowed.status).toBe('ok');

    // Approving one amount does not permit another. That is the loophole this closes.
    const different = await mayCharge({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: fromDollars(900),
    });
    expect(different.status).toBe('refused');

    expect((await deviationsFor(fx.tenant.id, medlink)).length).toBe(1);
  });

  it('refuses to record a deviation at the published price', async () => {
    const result = await recordDeviation({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      offerKey: 'foundation',
      chargedCents: RETAINER,
      basis: 'Recording the standard price as though it were an exception to itself.',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });
});

describe('10.1 intercompany invoicing', () => {
  it('raises an invoice on a disclosed engagement and never settles it', async () => {
    const invoice = await raiseInvoice({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      amountCents: fromDollars(1_000),
      description: 'Foundation retainer, August 2026',
      periodFrom: new Date('2026-08-01T00:00:00.000Z'),
      periodTo: new Date('2026-09-01T00:00:00.000Z'),
      raisedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(invoice.status).toBe('ok');
    if (invoice.status !== 'ok') return;
    expect(invoice.value.state).toBe('drafted');

    const routed = await routeToGardnerLedger({
      tenantId: fx.tenant.id,
      invoiceId: invoice.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(routed.status).toBe('not_built');
    if (routed.status === 'not_built') {
      expect(routed.module).toMatch(/Gardner/);
      expect(routed.reason).toMatch(/one of which is not ours/);
    }

    // Marked as awaiting rather than settled, so the queue is visible.
    const pending = await awaitingRouting(fx.tenant.id);
    expect(pending.map((entry) => entry.id)).toContain(invoice.value.id);
    expect(pending.every((entry) => entry.state !== 'settled')).toBe(true);
  });

  it('refuses an invoice on an engagement whose disclosure was withdrawn', async () => {
    const disclosure = await mayProceed(fx.tenant.id, medlink, medlinkEngagement);
    expect(disclosure.status).toBe('ok');
    if (disclosure.status !== 'ok' || disclosure.value.disclosure === null) return;

    const withdrawn = await withdrawDisclosure({
      tenantId: fx.tenant.id,
      disclosureId: disclosure.value.disclosure.id,
      reason: 'The engagement scope changed materially; a new disclosure is required.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(withdrawn.status).toBe('ok');

    const invoice = await raiseInvoice({
      tenantId: fx.tenant.id,
      clientId: medlink,
      engagementId: medlinkEngagement,
      amountCents: fromDollars(1_000),
      description: 'Second month',
      periodFrom: new Date('2026-09-01T00:00:00.000Z'),
      periodTo: new Date('2026-10-01T00:00:00.000Z'),
      raisedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(invoice.status).toBe('refused');

    // The earlier invoice survives - the question "what was billed in August" outlives the
    // engagement changing in September.
    expect((await invoicesFor(fx.tenant.id, medlinkEngagement)).length).toBe(1);
  });
});

describe('10.1 Collingswood handoff', () => {
  let handoffId: string;
  const SCOPE =
    'Personal credit summary, household composition, and the personal guarantee exposure identified on the business file.';

  it('refuses a handoff with no stated observation or scope', async () => {
    const thin = await proposeHandoff({
      tenantId: fx.tenant.id,
      clientId: stranger,
      observation: 'personal stuff',
      scope: SCOPE,
      proposedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(thin.status).toBe('refused');
  });

  it('proposes a handoff and shares nothing yet', async () => {
    const proposed = await proposeHandoff({
      tenantId: fx.tenant.id,
      clientId: stranger,
      observation:
        'Two personal guarantees across three facilities, and the founder asked about separating personal and business exposure.',
      scope: SCOPE,
      proposedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(proposed.status).toBe('ok');
    if (proposed.status !== 'ok') return;
    handoffId = proposed.value.id;
    expect(proposed.value.state).toBe('proposed');
  });

  it('refuses a transfer before consent', async () => {
    const result = await transferHandoff({
      tenantId: fx.tenant.id,
      handoffId,
      transferredBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/without the client's own authorization/);
      // The principle cites the locked decision itself, so a reader of the refusal can find it.
      expect(result.principle).toMatch(/no back doors/i);
    }
  });

  it('refuses a consent whose scope differs from the handoff', async () => {
    const mismatched = await grant({
      tenantId: fx.tenant.id,
      clientId: stranger,
      kind: HANDOFF_CONSENT_KIND,
      scope: 'A referral to Collingswood',
      actor: HUMAN(),
    });
    if (mismatched.status !== 'ok') throw new Error('setup');

    const result = await recordConsent({
      tenantId: fx.tenant.id,
      handoffId,
      consentId: mismatched.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    // Consent to "a referral" is not informed consent to a named set of personal information.
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/scope does not match/);
  });

  it('transfers on a matching consent, and re-checks it live', async () => {
    const consent = await grant({
      tenantId: fx.tenant.id,
      clientId: stranger,
      kind: HANDOFF_CONSENT_KIND,
      scope: SCOPE,
      actor: HUMAN(),
    });
    if (consent.status !== 'ok') throw new Error('setup');

    const recorded = await recordConsent({
      tenantId: fx.tenant.id,
      handoffId,
      consentId: consent.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(recorded.status).toBe('ok');

    // The client changes their mind between consenting and transferring - which is exactly when
    // people do. Trusting the state field would let the revocation apply only to future handoffs.
    await revoke(fx.tenant.id, consent.value.id, HUMAN());

    const blocked = await transferHandoff({
      tenantId: fx.tenant.id,
      handoffId,
      transferredBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(blocked.status).toBe('refused');
    if (blocked.status === 'refused') expect(blocked.reason).toMatch(/revoked/);
  });

  it('transfers when the consent is live at the moment of transfer', async () => {
    await declineHandoff({
      tenantId: fx.tenant.id,
      handoffId,
      reason: 'Superseded by a fresh proposal after the client re-consented.',
      actor: HUMAN(),
      now: NOW,
    });

    const proposed = await proposeHandoff({
      tenantId: fx.tenant.id,
      clientId: stranger,
      observation:
        'Client re-confirmed they want the personal-layer conversation after reviewing the scope.',
      scope: SCOPE,
      proposedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (proposed.status !== 'ok') throw new Error('setup');

    const consent = await grant({
      tenantId: fx.tenant.id,
      clientId: stranger,
      kind: HANDOFF_CONSENT_KIND,
      scope: SCOPE,
      actor: HUMAN(),
    });
    if (consent.status !== 'ok') throw new Error('setup');

    await recordConsent({
      tenantId: fx.tenant.id,
      handoffId: proposed.value.id,
      consentId: consent.value.id,
      actor: HUMAN(),
      now: NOW,
    });

    const transferred = await transferHandoff({
      tenantId: fx.tenant.id,
      handoffId: proposed.value.id,
      transferredBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(transferred.status).toBe('ok');
    if (transferred.status === 'ok') expect(transferred.value.state).toBe('transferred');

    // The transfer event carries the scope, so what actually moved is answerable later.
    const events = await read({
      tenantId: fx.tenant.id,
      clientId: stranger,
      type: 'interventure.handoff.transferred',
    });
    expect(events[0]?.payload['scope']).toBe(SCOPE);

    const live = await consentsForClient(fx.tenant.id, stranger);
    expect(live.filter((entry) => entry.kind === HANDOFF_CONSENT_KIND).length).toBeGreaterThan(1);
  });
});
