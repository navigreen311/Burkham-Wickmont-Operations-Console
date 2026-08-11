/**
 * From an empty database to the edge of serving a client - ADR-0065, ADR-0066.
 *
 * This file walks the launch path and asserts where it stops. The stopping point is the product of
 * the slice: `mayOnboardClients` refuses, and it refuses for reasons no engineer can clear.
 *
 * The activation half uses `plaid` and its two siblings, which nothing else in the suite records
 * evidence for - `tests/invariants/vendor-gates.test.ts` uses `capitalforge` for the same reason.
 * Vendor evidence is firm-wide rather than per-tenant, so the two files would otherwise collide.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import {
  CLIENT_ONBOARDING_VENDORS,
  VENDOR_EVIDENCE_KINDS,
  activationBoard,
  activationStanding,
  mayOnboardClients,
  plaidTransactions,
  recordEvidence,
  withdrawEvidence,
} from '@bwc/integration';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const NOW = new Date('2026-09-01T10:00:00.000Z');
const ISSUED = new Date('2026-06-01T00:00:00.000Z');
const VALID_UNTIL = new Date('2027-06-01T00:00:00.000Z');

const clearAll = async (): Promise<void> => {
  await db().vendorEvidence.deleteMany({
    where: { vendor: { in: [...CLIENT_ONBOARDING_VENDORS] } },
  });
};

/** Accept all four documents for one vendor, as a Level 3 human would. */
const activate = async (vendor: (typeof CLIENT_ONBOARDING_VENDORS)[number]): Promise<void> => {
  for (const kind of VENDOR_EVIDENCE_KINDS) {
    const result = await recordEvidence({
      vendor,
      kind,
      documentReference: `${vendor.toUpperCase()}-${kind}-2026-0001`,
      issuedBy: kind === 'argus_security_review' ? 'Argus Security' : 'Independent auditor',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    if (result.status !== 'ok') throw new Error(`activate ${vendor}/${kind}: ${result.status}`);
  }
};

beforeAll(async () => {
  fx = await makeFixture('launch-readiness');
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await cleanupTenant(fx.tenant.id);
});

describe('where the launch path stops today', () => {
  it('refuses client onboarding, and names all three vendors', async () => {
    const result = await mayOnboardClients(NOW);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');

    for (const vendor of CLIENT_ONBOARDING_VENDORS) {
      expect(result.reason, vendor).toMatch(vendor);
    }
    // The refusal names the constraint rather than just failing.
    expect(result.reason).toMatch(/not activated/);
  });

  it('shows every vendor on the board with what each is waiting on', async () => {
    const board = await activationBoard(NOW);
    expect(board.length).toBeGreaterThanOrEqual(CLIENT_ONBOARDING_VENDORS.length);

    for (const standing of board) {
      if (CLIENT_ONBOARDING_VENDORS.includes(standing.vendor)) {
        expect(standing.activated, standing.vendor).toBe(false);
        // Named, not a red dot. An operator has to know what to go and get.
        expect(standing.outstanding.length, standing.vendor).toBe(VENDOR_EVIDENCE_KINDS.length);
      }
    }
  });
});

describe('what clearing the gates actually takes', () => {
  it('opens one vendor only when all four documents are accepted', async () => {
    await activate('plaid');

    const plaid = await activationStanding('plaid', NOW);
    expect(plaid.activated).toBe(true);
    expect(plaid.accepted.length).toBe(VENDOR_EVIDENCE_KINDS.length);

    // The adapter's gate is open now - so it stops reporting "not activated" and starts reporting
    // the NEXT honest thing, which is that INTEGRATION_MODE is stub and no call was made. Two
    // different refusals, and a system that collapsed them would look activated when it was not.
    const call = await plaidTransactions.call({
      clientId: fx.tenant.id,
      consentReference: 'test',
      months: 12,
    });
    expect(call.status).toBe('not_built');
    if (call.status !== 'not_built') throw new Error('expected not_built');
    expect(call.reason).toMatch(/INTEGRATION_MODE is stub/);
    expect(call.reason).not.toMatch(/Argus/);
  });

  it('still refuses onboarding while the other two are outstanding', async () => {
    // One of three is not "nearly there" for a constraint that requires all of them.
    const result = await mayOnboardClients(NOW);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/business_bureau/);
    expect(result.reason).toMatch(/personal_credit/);
    expect(result.reason).not.toMatch(/plaid needs/);
  });

  it('permits onboarding only when every vendor carrying client data is clear', async () => {
    await activate('business_bureau');
    await activate('personal_credit');

    const result = await mayOnboardClients(NOW);
    expect(result.status).toBe('ok');
  });

  it('closes again the moment one document is withdrawn', async () => {
    const row = await db().vendorEvidence.findFirst({
      where: { vendor: 'personal_credit', kind: 'data_processing_agreement', withdrawnAt: null },
    });
    if (!row) throw new Error('setup: no DPA to withdraw');

    const withdrawn = await withdrawEvidence({
      evidenceId: row.id,
      reason: 'The DPA was terminated by the counterparty on notice.',
      withdrawnBy: fx.human.id,
      now: NOW,
    });
    expect(withdrawn.status).toBe('ok');

    // Takes effect immediately, not at the next deploy.
    const result = await mayOnboardClients(NOW);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/personal_credit/);
  });

  it('closes on expiry with nothing scheduled to notice', async () => {
    // Restore the DPA so only expiry is under test.
    await recordEvidence({
      vendor: 'personal_credit',
      kind: 'data_processing_agreement',
      documentReference: 'PERSONAL_CREDIT-dpa-2026-0002',
      issuedBy: 'Counterparty counsel',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    expect((await mayOnboardClients(NOW)).status).toBe('ok');

    // A day after the attestations lapse. No job ran; the standing is derived on read.
    const afterExpiry = new Date(VALID_UNTIL.getTime() + 24 * 60 * 60 * 1000);
    const result = await mayOnboardClients(afterExpiry);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/expired/);
  });
});
