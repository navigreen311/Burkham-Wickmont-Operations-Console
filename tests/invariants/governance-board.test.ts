/**
 * Invariants for the Capital Product Governance Board - 5.4.
 *
 * The module that decides which providers an agent may recommend. Everything here is about
 * one property: **a provider is not recommendable unless a named human decided it is, said
 * why, and did so recently.** Each test removes one of those three and checks the answer
 * flips.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPLAINT_FLAG_THRESHOLD,
  COMPLAINT_WEIGHTS,
  MAXIMUM_REVIEW_CADENCE_DAYS,
  approve,
  blacklist,
  complaintHistory,
  decisionHistory,
  disclosuresRequiredFor,
  governanceOf,
  nextReviewDue,
  providersPermittedIn,
  recordComplaint,
  recordReview,
  reinstate,
  reviewQueue,
  standing,
  standingOf,
  submitForReview,
  suspend,
  type GovernanceSnapshot,
} from '@bwc/governance';
import { registerProvider } from '@bwc/lenders';
import { read } from '@bwc/ledger';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('governance');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const TODAY = new Date('2026-08-10T00:00:00.000Z');

const newProvider = async (name: string, kind = 'national_bank' as const) => {
  const result = await registerProvider({
    tenantId: fx.tenant.id,
    name,
    kind,
    statesServed: ['*'],
    actor: actor(),
  });
  if (result.status !== 'ok') throw new Error('fixture provider failed');
  return result.value;
};

const snapshot = (overrides: Partial<GovernanceSnapshot> = {}): GovernanceSnapshot => ({
  providerId: 'provider-1',
  status: 'approved',
  lastReviewedAt: new Date('2026-08-01T00:00:00.000Z'),
  reviewCadenceDays: 90,
  approvedStates: [],
  restrictedStates: [],
  blacklistReason: null,
  requiredDisclosures: [],
  ...overrides,
});

describe('standing is derived, not stored', () => {
  it('treats a provider the board has never seen as not recommendable', () => {
    // The most common reason, and the one a stored status column would get wrong by
    // defaulting to something. Absence is the answer.
    const result = standing('provider-1', null, TODAY);
    expect(result.verdict).toBe('not_recommendable');
    expect(result.blockers).toEqual(['never_governed']);
    expect(result.explanation).toMatch(/never reviewed this provider/i);
  });

  it('goes overdue from the clock alone, with no job to run', () => {
    // A nightly job that flips stale approvals is a single point of silent failure: when it
    // stops, every stale provider keeps reading as approved and nobody notices, because
    // nothing changed. Deriving it means a provider reviewed 91 days ago is overdue on every
    // machine, including one switched off for a month.
    const fresh = standing('p', snapshot({ lastReviewedAt: new Date('2026-07-01') }), TODAY);
    expect(fresh.verdict).toBe('recommendable');

    const stale = standing('p', snapshot({ lastReviewedAt: new Date('2026-04-01') }), TODAY);
    expect(stale.verdict).toBe('not_recommendable');
    expect(stale.blockers).toContain('review_overdue');
    expect(stale.explanation).toMatch(/past the 90-day cadence/);
  });

  it('treats an approval with no review date as overdue rather than as current', () => {
    const result = standing('p', snapshot({ lastReviewedAt: null }), TODAY);
    expect(result.blockers).toContain('review_overdue');
  });

  it('clamps a too-long cadence at read time as well as at write time', () => {
    // Belt and braces: `approve` refuses a cadence over 90 days, and a row that acquired one
    // by any other route still cannot buy itself extra time.
    const result = standing(
      'p',
      snapshot({ reviewCadenceDays: 365, lastReviewedAt: new Date('2026-04-01') }),
      TODAY,
    );
    expect(result.blockers).toContain('review_overdue');
  });

  it.each(['pending_review', 'under_review', 'suspended', 'blacklisted'] as const)(
    'refuses a provider in %s',
    (status) => {
      const result = standing('p', snapshot({ status }), TODAY);
      expect(result.verdict).toBe('not_recommendable');
      expect(result.blockers).toContain(status);
    },
  );

  it('reports every blocker, not only the first', () => {
    // A blacklist that is also five months unreviewed is a different governance failure from
    // a fresh one, and a reader deserves the whole picture.
    const result = standing(
      'p',
      snapshot({
        status: 'blacklisted',
        blacklistReason: 'undisclosed fees',
        restrictedStates: ['TX'],
      }),
      TODAY,
      'TX',
    );
    expect(result.blockers).toContain('blacklisted');
    expect(result.blockers).toContain('state_restricted');
    expect(result.explanation).toMatch(/undisclosed fees/);
  });

  it('honours a state-limited approval', () => {
    const limited = snapshot({ approvedStates: ['TX', 'OK'] });
    expect(standing('p', limited, TODAY, 'TX').verdict).toBe('recommendable');
    expect(standing('p', limited, TODAY, 'CA').verdict).toBe('not_recommendable');
    // Empty approvedStates means unrestricted, which is different from restricted to nothing.
    expect(standing('p', snapshot({ approvedStates: [] }), TODAY, 'CA').verdict).toBe(
      'recommendable',
    );
  });

  it('computes when the next review falls due', () => {
    const due = nextReviewDue(snapshot({ lastReviewedAt: new Date('2026-08-01T00:00:00.000Z') }));
    expect(due?.toISOString().slice(0, 10)).toBe('2026-10-30');
  });
});

describe('approval workflow', () => {
  it('refuses an approval with no rationale', async () => {
    const provider = await newProvider('No Rationale Bank');
    const result = await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: '   ',
      actor: actor(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.principle).toMatch(/5\.4/);
  });

  it('refuses a review cadence longer than quarterly', async () => {
    // Silently clamping would hide that a caller tried to weaken the guarantee.
    const provider = await newProvider('Slow Review Bank');
    const result = await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Established issuer with published terms.',
      reviewCadenceDays: MAXIMUM_REVIEW_CADENCE_DAYS + 1,
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });

  it('approves a provider and makes it recommendable', async () => {
    const provider = await newProvider('Good Standing Bank');
    await submitForReview({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      submittedBy: 'funding-strategy',
      rationale: 'Published business card terms and an existing broker agreement.',
      actor: actor(),
    });

    const before = await standingOf(fx.tenant.id, provider.id, TODAY);
    expect(before.blockers).toContain('pending_review');

    const approved = await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Terms verified against published materials; no open complaints.',
      requiredDisclosures: ['Burkham Wickmont is not a lender and does not make credit decisions.'],
      actor: actor(),
      now: TODAY,
    });

    expect(approved.status).toBe('ok');
    const after = await standingOf(fx.tenant.id, provider.id, TODAY);
    expect(after.verdict).toBe('recommendable');
    expect(after.requiredDisclosures).toHaveLength(1);
  });

  it('writes an audit row and a Ledger event for every decision', async () => {
    // Both, deliberately. The decision row carries from/to and rationale in queryable form;
    // the Ledger entry puts it in the same hash chain as everything else that day.
    const provider = await newProvider('Audited Bank');
    await submitForReview({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      submittedBy: 'funding-strategy',
      rationale: 'Candidate for the card stack.',
      actor: actor(),
    });
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Verified.',
      actor: actor(),
      now: TODAY,
    });

    const history = await decisionHistory(fx.tenant.id, provider.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.toStatus).toBe('approved');
    expect(history[0]?.fromStatus).toBe('pending_review');
    for (const decision of history) {
      expect(decision.rationale.length).toBeGreaterThan(0);
      expect(decision.decidedBy.length).toBeGreaterThan(0);
    }

    const events = await read({ tenantId: fx.tenant.id, type: 'governance.provider.approved' });
    expect(events.some((event) => event.payload['providerId'] === provider.id)).toBe(true);
  });

  it('cannot change the status of a provider with no governance record', async () => {
    const provider = await newProvider('Ungoverned Bank');
    const result = await suspend({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      decidedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Trying to suspend something never approved.',
      actor: actor(),
    });
    expect(result.status).toBe('no_data');
  });
});

describe('Decision D is enforced at approval, not at registration', () => {
  it('records what we know about a deferred credit union', async () => {
    // Knowing PenFed's rules is the V1.5 research work; refusing to write it down would make
    // the database worse at being a defensible long-term asset.
    const result = await registerProvider({
      tenantId: fx.tenant.id,
      name: 'BECU',
      kind: 'credit_union',
      statesServed: ['WA'],
      actor: actor(),
    });
    expect(result.status).toBe('ok');
  });

  it('refuses to approve a credit union other than Navy Federal', async () => {
    const becu = await registerProvider({
      tenantId: fx.tenant.id,
      name: 'BECU',
      kind: 'credit_union',
      statesServed: ['WA'],
      actor: actor(),
    });
    if (becu.status !== 'ok') throw new Error('fixture failed');

    const result = await approve({
      tenantId: fx.tenant.id,
      providerId: becu.value.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Attractive business line pricing.',
      actor: actor(),
      now: TODAY,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.principle).toMatch(/Decision D/);
      expect(result.reason).toMatch(/Navy Federal/);
      expect(result.reason).toMatch(/V1\.5 research workstream/i);
    }
  });

  it('approves Navy Federal, which is in V1 scope', async () => {
    const navy = await newProvider('Navy Federal Credit Union', 'credit_union');
    const result = await approve({
      tenantId: fx.tenant.id,
      providerId: navy.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'The one credit union in V1 scope per Decision D; terms verified.',
      actor: actor(),
      now: TODAY,
    });
    expect(result.status).toBe('ok');
  });
});

describe('blacklist and reinstatement', () => {
  it('makes a blacklisted provider unrecommendable and records the reason', async () => {
    const provider = await newProvider('Blacklisted Capital', 'mca_provider');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Initially approved.',
      actor: actor(),
      now: TODAY,
    });

    const result = await blacklist({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      decidedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Pattern of undisclosed fees across three client files.',
      actor: actor(),
    });
    expect(result.status).toBe('ok');

    const after = await standingOf(fx.tenant.id, provider.id, TODAY);
    expect(after.verdict).toBe('not_recommendable');
    expect(after.explanation).toMatch(/undisclosed fees/);
  });

  it('refuses to approve straight out of a blacklist', async () => {
    // Reversing a blacklist must be its own decision with its own rationale, not a side
    // effect of a routine approval.
    const provider = await newProvider('Still Blacklisted Capital', 'factor');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Initially approved.',
      actor: actor(),
      now: TODAY,
    });
    await blacklist({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      decidedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Regulatory action.',
      actor: actor(),
    });

    const result = await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'They said it is resolved.',
      actor: actor(),
      now: TODAY,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/explicitly reinstated/i);
  });

  it('reinstates to pending_review, never straight to approved', async () => {
    // Reinstatement restores candidacy, not approval. Someone has to look again before
    // clients are placed there.
    const provider = await newProvider('Reinstated Capital', 'factor');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Initially approved.',
      actor: actor(),
      now: TODAY,
    });
    await blacklist({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      decidedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Complaint pattern.',
      actor: actor(),
    });

    await reinstate({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      decidedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Provider remediated; disclosure now published.',
      actor: actor(),
    });

    const record = await governanceOf(fx.tenant.id, provider.id);
    expect(record?.status).toBe('pending_review');
    expect((await standingOf(fx.tenant.id, provider.id, TODAY)).verdict).toBe('not_recommendable');
  });
});

describe('complaint threshold', () => {
  it('weights severity rather than counting complaints', () => {
    // Three low-severity billing gripes and three regulator complaints about undisclosed
    // fees are not the same signal, and a flat count says they are.
    expect(COMPLAINT_WEIGHTS.severe).toBeGreaterThan(COMPLAINT_WEIGHTS.moderate);
    expect(COMPLAINT_WEIGHTS.severe).toBeGreaterThanOrEqual(COMPLAINT_FLAG_THRESHOLD);
  });

  it('auto-flags for review on a single severe complaint - and does not suspend', async () => {
    // Auto-suspension would let one unhappy client remove a provider without a human ever
    // weighing the complaint. Flagging pauses recommendations and puts it in front of the
    // board, which is the body the blueprint makes responsible.
    const provider = await newProvider('Complained About Capital', 'mca_provider');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved before the complaint.',
      actor: actor(),
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    const result = await recordComplaint({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      source: 'client file BW-1042',
      summary: 'Advance funded net of an origination fee that was never disclosed in writing.',
      severity: 'severe',
      receivedAt: new Date('2026-08-05T00:00:00.000Z'),
      actor: actor(),
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.thresholdCrossed).toBe(true);
      expect(result.value.governance?.status).toBe('under_review');
    }

    const after = await standingOf(fx.tenant.id, provider.id, TODAY);
    expect(after.verdict).toBe('not_recommendable');
    expect(after.blockers).toContain('under_review');
  });

  it('does not flag below the threshold', async () => {
    const provider = await newProvider('Minor Grumbles Bank');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved.',
      actor: actor(),
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    for (let i = 0; i < 2; i += 1) {
      await recordComplaint({
        tenantId: fx.tenant.id,
        providerId: provider.id,
        source: `client file ${i}`,
        summary: 'Statement arrived two days late.',
        severity: 'low',
        receivedAt: new Date('2026-08-05T00:00:00.000Z'),
        actor: actor(),
      });
    }

    expect((await standingOf(fx.tenant.id, provider.id, TODAY)).verdict).toBe('recommendable');
  });

  it('records a complaint against an ungoverned provider rather than losing it', async () => {
    // It is evidence. Discarding it because nobody had opened a governance file would mean
    // the file, when opened, starts blind.
    const provider = await newProvider('Unknown To The Board Capital', 'factor');
    const result = await recordComplaint({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      source: 'regulator bulletin',
      summary: 'Consent order regarding fee disclosure.',
      severity: 'severe',
      receivedAt: new Date('2026-08-05T00:00:00.000Z'),
      actor: actor(),
    });

    expect(result.status).toBe('ok');
    const history = await complaintHistory(fx.tenant.id, provider.id);
    expect(history).toHaveLength(1);
  });

  it('clears the window on a re-review, so old complaints do not re-flag forever', async () => {
    const provider = await newProvider('Reviewed After Complaints Bank');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved.',
      actor: actor(),
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    await recordComplaint({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      source: 'client file',
      summary: 'Fee dispute, later resolved in the client favour.',
      severity: 'severe',
      receivedAt: new Date('2026-06-15T00:00:00.000Z'),
      actor: actor(),
    });

    await recordReview({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      reviewedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Complaint reviewed and resolved; provider remains approved.',
      actor: actor(),
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    // Status returns to approved on the board's decision, and the window resets so the same
    // complaint cannot trip the threshold a second time.
    const record = await governanceOf(fx.tenant.id, provider.id);
    expect(record?.complaintCount).toBe(0);
  });
});

describe('state restrictions propagate by derivation', () => {
  it('lists providers permitted in a state', async () => {
    const texasOnly = await newProvider('Texas Only Bank');
    await approve({
      tenantId: fx.tenant.id,
      providerId: texasOnly.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved for Texas placements only pending a broker agreement elsewhere.',
      approvedStates: ['TX'],
      actor: actor(),
      now: TODAY,
    });

    const inTexas = await providersPermittedIn(fx.tenant.id, 'TX');
    const inCalifornia = await providersPermittedIn(fx.tenant.id, 'CA');
    expect(inTexas).toContain(texasOnly.id);
    expect(inCalifornia).not.toContain(texasOnly.id);
  });

  it('collects the disclosures obliged by the providers named', async () => {
    const provider = await newProvider('Disclosing Bank');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved.',
      requiredDisclosures: ['Rates shown are indicative and subject to underwriting.'],
      actor: actor(),
      now: TODAY,
    });

    const disclosures = await disclosuresRequiredFor(fx.tenant.id, [provider.id]);
    expect(disclosures).toContain('Rates shown are indicative and subject to underwriting.');
  });
});

describe('the board review queue', () => {
  it('agrees with the gate about what overdue means', async () => {
    // Built by asking standing() about each approved provider rather than by a date query,
    // so the queue and the gate cannot disagree.
    const provider = await newProvider('Long Overdue Bank');
    await approve({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved a long time ago.',
      actor: actor(),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const queue = await reviewQueue(fx.tenant.id, TODAY);
    expect(queue.map((entry) => entry.providerId)).toContain(provider.id);

    for (const entry of queue) {
      expect((await standingOf(fx.tenant.id, entry.providerId, TODAY)).blockers).toContain(
        'review_overdue',
      );
    }
  });
});
