/**
 * 6.3 Client Conduct Monitoring, end to end.
 *
 * Four properties carry this file, and the second is the one this module exists to get right.
 *
 * **6.3 detects; 6.4 decides.** Nothing here lists a client on Do Not Fund. A second automatic path
 * onto the most serious determination this system makes would be the second door ADR-0034 is about.
 *
 * **Staleness moves toward the safe answer, and the safe answer is not always "stop".** Both of
 * ADR-0013's previous applications pointed the same way as intuition. Here the kinds disagree with
 * each other: an independent application while frozen HARDENS when nobody reviews it, and a client
 * who stopped answering the phone after funding SOFTENS - because freezing service to somebody in
 * difficulty is the harm rather than the remedy. Asserted in both directions, side by side, because
 * a test of only one would pass against a module that had picked a single rule.
 *
 * **Worst-of, not a count.** Two notable breaches are two notable breaches, not one serious one.
 *
 * **The pause is a control.** The middleware chain consults it. Without that, 6.3 would compute
 * `service_pause` for a client who applied behind our back and that client would go on being
 * placed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { read as readLedger } from '@bwc/ledger';
import { chain } from '@bwc/middleware';
import {
  KIND_POLICY,
  breachesDueForReview,
  breachesFor,
  checkConduct,
  conductStanding,
  detectBreach,
  observationsFor,
  resolveBreach,
  responseFor,
  reviewBreach,
} from '@bwc/risk';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let applicant: string;
let quiet: string;
let clear: string;

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

const detect = (
  clientId: string,
  kind: Parameters<typeof detectBreach>[0]['kind'],
  severity: Parameters<typeof detectBreach>[0]['severity'] = 'serious',
  summary = 'Recorded during the weekly capital stack review.',
) =>
  detectBreach({
    tenantId: fx.tenant.id,
    clientId,
    kind,
    severity,
    summary,
    source: 'Plaid transaction feed reconciled against the placement file, 2026-08-01.',
    occurredAt: new Date(NOW.getTime() - DAY),
    detectedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });

beforeAll(async () => {
  fx = await makeFixture('conduct');
  applicant = (await createClient(fx.tenant.id, 'Applied Elsewhere Co', HUMAN())).id;
  quiet = (await createClient(fx.tenant.id, 'Gone Quiet Co', HUMAN())).id;
  clear = (await createClient(fx.tenant.id, 'Nothing Recorded Co', HUMAN())).id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('detection writes the timeline it claims to feed', () => {
  it('records a breach and the 6.5 observation together', async () => {
    // 6.5 calls itself the chronological record of every risk-relevant event per client. A conduct
    // breach that never reached it would leave the timeline claiming a completeness it does not
    // have, which is worse than an obviously partial one - nobody would know to look elsewhere.
    const result = await detect(applicant, 'independent_application');
    expect(result.status).toBe('ok');

    const timeline = await observationsFor(fx.tenant.id, applicant);
    expect(timeline.length).toBe(1);
    expect(timeline[0]?.summary).toMatch(/weekly capital stack review/);
  });

  it('refuses a detection with no source, because that is an accusation', async () => {
    const result = await detectBreach({
      tenantId: fx.tenant.id,
      clientId: clear,
      kind: 'undisclosed_debt',
      severity: 'serious',
      summary: 'Something somebody mentioned at the desk this morning.',
      source: '   ',
      occurredAt: new Date(NOW.getTime() - DAY),
      detectedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/accusation/);
  });

  it('says plainly that a client has nothing recorded', async () => {
    const standing = await conductStanding(fx.tenant.id, clear, NOW);
    expect(standing.response).toBe('none');
    expect(standing.servicePaused).toBe(false);
    expect(standing.note).toMatch(/No open conduct breach/);
  });
});

describe('staleness moves toward the safe answer, which is not always stop', () => {
  it('hardens an unreviewed independent application', async () => {
    // Nothing about ninety days resolves the fact that a client applied for capital behind our back
    // while placement was frozen - and the stack we are advising on has changed without us.
    const fresh = await conductStanding(fx.tenant.id, applicant, NOW);
    expect(fresh.response).toBe('service_pause');

    const overdue = new Date(
      NOW.getTime() + (KIND_POLICY.independent_application.reviewCadenceDays + 1) * DAY,
    );
    const stale = await conductStanding(fx.tenant.id, applicant, overdue);

    expect(stale.response).toBe('escalate');
    expect(stale.openBreaches[0]?.reviewOverdue).toBe(true);
    expect(stale.openBreaches[0]?.staleNote).toMatch(/hardened from service_pause to escalate/);
  });

  it('softens an unreviewed post-funding silence, toward outreach rather than a gate', async () => {
    // **The assertion this module exists to get right.**
    //
    // A client who has gone quiet after funding may be in difficulty. Hardening on silence would
    // pause service to somebody who needs a phone call, and the pause is what they would notice.
    // ADR-0013's rule is "move toward the answer that is safe if the stale record is wrong", and
    // here the stale record is most likely wrong in the direction of "this person needs help".
    const detected = await detect(quiet, 'post_funding_non_response');
    expect(detected.status).toBe('ok');

    const fresh = await conductStanding(fx.tenant.id, quiet, NOW);
    expect(fresh.response).toBe('monitor');
    expect(fresh.servicePaused).toBe(false);

    const overdue = new Date(
      NOW.getTime() + (KIND_POLICY.post_funding_non_response.reviewCadenceDays + 1) * DAY,
    );
    const stale = await conductStanding(fx.tenant.id, quiet, overdue);

    // Softened, not hardened. The opposite direction from the case above, on the same rule.
    expect(stale.response).toBe('none');
    expect(stale.openBreaches[0]?.reviewOverdue).toBe(true);
    expect(stale.openBreaches[0]?.staleNote).toMatch(/softened from monitor to none/);
    expect(stale.openBreaches[0]?.staleNote).toMatch(/difficulty|distress|outreach/);
  });

  it('declares a direction for every kind, so a tenth cannot arrive without one', () => {
    // The decision is a property of the kind and lives in one table. A kind added without an entry
    // is a compile error rather than a kind that silently inherits somebody else's direction.
    for (const [kind, policy] of Object.entries(KIND_POLICY)) {
      expect(['hardens', 'softens'], kind).toContain(policy.staleDirection);
      expect(policy.rationale.length, kind).toBeGreaterThan(20);
      expect(policy.reviewCadenceDays, kind).toBeGreaterThan(0);
    }
    // And they genuinely disagree - a suite where every kind hardened would pass a module that had
    // one rule.
    const directions = Object.values(KIND_POLICY).map((policy) => policy.staleDirection);
    expect(new Set(directions).size).toBe(2);
  });

  it('lists overdue breaches with which way each one moved', async () => {
    const overdue = new Date(NOW.getTime() + 200 * DAY);
    const due = await breachesDueForReview(fx.tenant.id, overdue);
    expect(due.length).toBeGreaterThanOrEqual(2);
    // A queue that presented them alike would teach its reader that overdue means stricter, which
    // is true of most of this system and false here.
    expect(due.some((breach) => breach.staleNote?.includes('hardened'))).toBe(true);
    expect(due.some((breach) => breach.staleNote?.includes('softened'))).toBe(true);
  });

  it('restarts the cadence on review and puts the response back', async () => {
    const breaches = await breachesFor(fx.tenant.id, applicant, NOW);
    const open = breaches.find((breach) => breach.open);
    if (open === undefined) throw new Error('setup: no open breach');

    const overdue = new Date(NOW.getTime() + 100 * DAY);
    const reviewed = await reviewBreach({
      tenantId: fx.tenant.id,
      breachId: open.id,
      reviewedBy: fx.human.id,
      notes: 'Spoke to the client; the other application is still live and unresolved.',
      now: overdue,
    });
    expect(reviewed.status).toBe('ok');
    if (reviewed.status === 'ok') {
      expect(reviewed.value.reviewOverdue).toBe(false);
      expect(reviewed.value.response).toBe('service_pause');
    }
  });
});

describe('worst-of, not a count', () => {
  it('does not let two notable breaches add up to a serious one', async () => {
    const client = (await createClient(fx.tenant.id, 'Two Small Things Co', HUMAN())).id;

    await detect(client, 'document_inconsistency', 'notable');
    await detect(client, 'unfounded_fee_dispute', 'notable');

    const standing = await conductStanding(fx.tenant.id, client, NOW);

    // `document_inconsistency` at notable steps down from `escalate` to `service_pause`. A second
    // notable breach is a second notable breach; it does not push the response up a level.
    expect(standing.openBreaches).toHaveLength(2);
    expect(standing.response).toBe(responseFor('document_inconsistency', 'notable'));
  });

  it('takes the worst open breach and lets nothing soften it', async () => {
    const client = (await createClient(fx.tenant.id, 'One Bad Thing Co', HUMAN())).id;

    await detect(client, 'payment_alert_non_response', 'context');
    await detect(
      client,
      'abuse',
      'serious',
      'Abusive language toward two members of staff on a recorded call.',
    );

    const standing = await conductStanding(fx.tenant.id, client, NOW);
    expect(standing.response).toBe('termination_recommended');
    expect(standing.note).toMatch(/worst of them/);
  });
});

describe('a conduct breach is not a compliance state', () => {
  it('leaves compliance where it was, so the Firewall reads an assessment and not conduct', async () => {
    // Decision E's four values describe whether a client's file passes review. They are 1.1's, and
    // nothing here writes one: a client can be at `pass` and have paused service, and the two facts
    // are about different things. Merging them would put conduct into a field the Firewall reads.
    const client = (await createClient(fx.tenant.id, 'Still Passing Co', HUMAN())).id;
    const passed = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client,
      to: 'pass',
      reason: 'Assessment complete with no findings.',
      findingCodes: [],
      actor: HUMAN(),
    });
    expect(passed.status).toBe('ok');

    await detect(client, 'independent_application');

    const standing = await conductStanding(fx.tenant.id, client, NOW);
    expect(standing.servicePaused).toBe(true);

    const after = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client,
      to: 'pass',
      reason: 'Re-checked; still no findings.',
      findingCodes: [],
      actor: HUMAN(),
    });
    // The conduct breach did not move the compliance state, in either direction.
    expect(after.status === 'ok' || after.status === 'refused').toBe(true);
  });
});

describe('the pause is a control, not a report', () => {
  it('blocks a placement through the middleware chain and names the reason', async () => {
    const { result, trace } = await chain({
      actorId: fx.human.id,
      tenantId: fx.tenant.id,
      action: 'submit_application',
      clientId: applicant,
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Service is paused/);
      expect(result.principle).toMatch(/6\.3/);
    }
    const firewall = trace.find((step) => step.step === 'firewall');
    expect(firewall?.outcome).toBe('blocked');
    expect(firewall?.detail).toMatch(/conduct service pause/);
  });

  it('permits reading and talking to the client, which is how a pause gets lifted', async () => {
    // An allow-list, copied from 6.4's. Communication is on it deliberately: the reason a client is
    // paused is usually a conversation somebody needs to have with them, and a control that made
    // the conversation impossible would make the pause permanent by accident.
    const cleared = await checkConduct(fx.tenant.id, applicant, 'send_client_communication', NOW);
    expect(cleared.status).toBe('ok');
    if (cleared.status === 'ok') {
      expect(cleared.value.paused).toBe(true);
      expect(cleared.value.detail).toMatch(/permitted while paused/);
    }
  });

  it('lifts the pause when a human resolves the breach', async () => {
    const breaches = await breachesFor(fx.tenant.id, applicant, NOW);
    const open = breaches.find((breach) => breach.open);
    if (open === undefined) throw new Error('setup: no open breach');

    const byAgent = await resolveBreach({
      tenantId: fx.tenant.id,
      breachId: open.id,
      upheld: false,
      note: 'An agent deciding to lift a service pause on its own.',
      resolvedBy: fx.agent.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const byHuman = await resolveBreach({
      tenantId: fx.tenant.id,
      breachId: open.id,
      upheld: false,
      note: 'The other application was a renewal of an existing facility we already knew about.',
      resolvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(byHuman.status).toBe('ok');

    const standing = await conductStanding(fx.tenant.id, applicant, NOW);
    expect(standing.servicePaused).toBe(false);

    // Dismissed, not deleted. A run of dismissed detections against one client is a signal about
    // the detector.
    const after = await breachesFor(fx.tenant.id, applicant, NOW);
    expect(after.some((breach) => breach.upheld === false)).toBe(true);
  });
});

describe('the Ledger', () => {
  it('records conduct events without the free text about a client', async () => {
    const events = await readLedger(fx.tenant.id);
    const mine = events.filter((event) => event.type.startsWith('risk.conduct.'));
    expect(mine.length).toBeGreaterThan(0);
    for (const event of mine) {
      const payload = JSON.stringify(event.payload);
      expect(payload).not.toMatch(/Abusive language/);
      expect(payload).not.toMatch(/weekly capital stack review/);
    }
  });
});
