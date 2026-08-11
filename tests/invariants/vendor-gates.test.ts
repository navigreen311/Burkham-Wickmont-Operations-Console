/**
 * Vendor activation is a recorded governance act - ADR-0065.
 *
 * The assertion this file exists for is the second one: **a gate cannot open without a document
 * reference**. Everything else is scaffolding around that.
 *
 * The check is deliberately placed BEFORE the authority check in `recordEvidence`, and the test
 * asserts that ordering directly - a Level 3 human is not a licence to record nothing, and if the
 * order were reversed the refusal a blank reference gets would be "you are not senior enough",
 * which is a different and misleading sentence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVATION_AUTHORITY_LEVEL,
  CLIENT_ONBOARDING_VENDORS,
  VENDOR_EVIDENCE_KINDS,
  VENDOR_GATES,
  VENDOR_IDS,
  activationStanding,
  isActivated,
  isUsableDocumentReference,
  mayOnboardClients,
  outstandingPreconditions,
  plaidTransactions,
  recordEvidence,
  withdrawEvidence,
} from '@bwc/integration';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const NOW = new Date('2026-09-01T10:00:00.000Z');
const ISSUED = new Date('2026-06-01T00:00:00.000Z');
const VALID_UNTIL = new Date('2027-06-01T00:00:00.000Z');

/** A vendor nothing else in the suite touches, so these tests do not collide. */
const VENDOR = 'capitalforge' as const;

const recorded: string[] = [];

const accept = async (kind: (typeof VENDOR_EVIDENCE_KINDS)[number], reference: string) => {
  const result = await recordEvidence({
    vendor: VENDOR,
    kind,
    documentReference: reference,
    issuedBy: 'Argus Security',
    issuedOn: ISSUED,
    validUntil: VALID_UNTIL,
    acceptedBy: fx.human.id,
    now: NOW,
  });
  if (result.status === 'ok') recorded.push(result.value.id);
  return result;
};

beforeAll(async () => {
  fx = await makeFixture('vendor-gates');
  // Vendor evidence is FIRM-WIDE, not per-tenant, so `makeFixture`'s tenant isolation does not
  // reach it and a previous run's rows would still be here. Clearing this vendor's evidence up
  // front is what makes the file rerunnable - the afterAll alone is not enough, because a run
  // that fails part way never reaches it.
  const { db } = await import('@bwc/db');
  await db().vendorEvidence.deleteMany({ where: { vendor: VENDOR } });
});

afterAll(async () => {
  // Vendor evidence is firm-wide rather than per-tenant, so `cleanupTenant` does not reach it.
  const { db } = await import('@bwc/db');
  for (const id of recorded) {
    await db().vendorEvidence.deleteMany({ where: { id } });
  }
  await cleanupTenant(fx.tenant.id);
});

describe('nothing is activated by a constant', () => {
  it('reports every vendor closed on the synchronous floor, including CapitalForge', () => {
    // The old constant marked CapitalForge cleared on nobody's authority. A sibling venture
    // holding client financial data is still a third party holding client financial data.
    for (const vendor of VENDOR_IDS) {
      expect(isActivated(vendor), vendor).toBe(false);
      expect(VENDOR_GATES[vendor].argusReviewed, vendor).toBe(false);
      expect(VENDOR_GATES[vendor].dpaSigned, vendor).toBe(false);
      expect(VENDOR_GATES[vendor].securityAttestationVerified, vendor).toBe(false);
    }
  });

  it('keeps the sync answer strictly more conservative than the recorded one', () => {
    // Three callers outside this package read the sync answer and this slice does not own them.
    // The disagreement is safe in exactly one direction: it can over-refuse, never over-permit.
    for (const vendor of VENDOR_IDS) {
      expect(isActivated(vendor), vendor).toBe(false);
      expect(outstandingPreconditions(vendor).length, vendor).toBeGreaterThan(0);
    }
  });
});

describe('a gate does not open without a document reference', () => {
  it('rejects blank and placeholder references outright', () => {
    for (const bad of [
      '',
      '   ',
      'n/a',
      'N/A',
      'na',
      'none',
      'TBD',
      'todo',
      'pending',
      'xxx',
      '---',
      'test',
    ]) {
      expect(isUsableDocumentReference(bad), bad).toBe(false);
    }
    // Short is also not a reference. Six characters is not much of a bar and is not meant to be -
    // the bar is that a Level 3 human has their name against it.
    expect(isUsableDocumentReference('AB12')).toBe(false);
    expect(isUsableDocumentReference('ARG-2026-0114')).toBe(true);
  });

  it('REFUSES to record evidence with no usable reference, and refuses BEFORE the authority check', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A screen where somebody ticks "SOC 2 cleared" with
    // nothing behind it is worse than the compile-time constant it replaces, because the constant
    // at least left a commit with an author, and the tick looks reviewed.
    const blank = await recordEvidence({
      vendor: VENDOR,
      kind: 'security_attestation',
      documentReference: '   ',
      issuedBy: 'Argus Security',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    expect(blank.status).toBe('refused');
    if (blank.status !== 'refused') throw new Error('expected a refusal');
    expect(blank.reason).toMatch(/document reference/i);

    const placeholder = await recordEvidence({
      vendor: VENDOR,
      kind: 'security_attestation',
      documentReference: 'n/a',
      issuedBy: 'Argus Security',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    expect(placeholder.status).toBe('refused');

    // The ORDER matters. `fx.agent` is Level 1, so if the authority check ran first this would
    // come back complaining about seniority - which would teach an operator that a more senior
    // person could wave a blank reference through.
    const blankAndJunior = await recordEvidence({
      vendor: VENDOR,
      kind: 'security_attestation',
      documentReference: 'n/a',
      issuedBy: 'Argus Security',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.agent.id,
      now: NOW,
    });
    expect(blankAndJunior.status).toBe('refused');
    if (blankAndJunior.status !== 'refused') throw new Error('expected a refusal');
    expect(blankAndJunior.reason).toMatch(/document reference/i);
    expect(blankAndJunior.reason).not.toMatch(/Authority Level/);
  });

  it('requires an issuer, and an expiry on an attestation', async () => {
    const noIssuer = await recordEvidence({
      vendor: VENDOR,
      kind: 'data_processing_agreement',
      documentReference: 'DPA-2026-0091',
      issuedBy: '',
      issuedOn: ISSUED,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    expect(noIssuer.status).toBe('refused');

    // A SOC 2 Type II covers a stated period. One recorded with no end is a misread document.
    const noExpiry = await recordEvidence({
      vendor: VENDOR,
      kind: 'security_attestation',
      documentReference: 'SOC2-TYPE2-2026-4471',
      issuedBy: 'Independent auditor',
      issuedOn: ISSUED,
      acceptedBy: fx.human.id,
      now: NOW,
    });
    expect(noExpiry.status).toBe('refused');
    if (noExpiry.status !== 'refused') throw new Error('expected a refusal');
    expect(noExpiry.reason).toMatch(/stops describing the vendor|stated period/i);
  });
});

describe('the level is read from the recorded actor', () => {
  it('refuses a Level 1 agent even with perfectly good evidence', async () => {
    // ADR-0009's rule. The caller does not get to assert their own level.
    const result = await recordEvidence({
      vendor: VENDOR,
      kind: 'argus_security_review',
      documentReference: 'ARG-2026-0114',
      issuedBy: 'Argus Security',
      issuedOn: ISSUED,
      validUntil: VALID_UNTIL,
      acceptedBy: fx.agent.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(new RegExp(`Authority Level ${ACTIVATION_AUTHORITY_LEVEL}`));
  });
});

describe('activation, expiry and withdrawal', () => {
  it('opens only when every required document is on record', async () => {
    const before = await activationStanding(VENDOR, NOW);
    expect(before.activated).toBe(false);
    expect(before.outstanding.length).toBe(VENDOR_EVIDENCE_KINDS.length);

    expect((await accept('vendor_selection', 'SELECT-2026-0007')).status).toBe('ok');
    expect((await accept('argus_security_review', 'ARG-2026-0114')).status).toBe('ok');

    const partway = await activationStanding(VENDOR, NOW);
    expect(partway.activated).toBe(false);
    // Named, so the surface can say what is missing rather than showing a red dot.
    expect(partway.outstanding.map((item) => item.kind)).toContain('data_processing_agreement');

    expect((await accept('data_processing_agreement', 'DPA-2026-0091')).status).toBe('ok');
    expect((await accept('security_attestation', 'SOC2-TYPE2-2026-4471')).status).toBe('ok');

    const after = await activationStanding(VENDOR, NOW);
    expect(after.activated).toBe(true);
    expect(after.accepted.length).toBe(VENDOR_EVIDENCE_KINDS.length);
    // The evidence travels with the answer.
    expect(after.accepted.map((entry) => entry.documentReference)).toContain('ARG-2026-0114');
  });

  it('closes again on its own when the attestation expires', async () => {
    // Staleness de-activates. A SOC 2 says nothing about the vendor after the period it covers,
    // and no scheduled job is needed to notice - the standing is derived on read.
    const later = new Date(VALID_UNTIL.getTime() + 24 * 60 * 60 * 1000);
    const standing = await activationStanding(VENDOR, later);
    expect(standing.activated).toBe(false);
    expect(standing.outstanding.map((item) => item.why).join(' ')).toMatch(/expired/);
  });

  it('closes on withdrawal, and keeps the row', async () => {
    const id = recorded[recorded.length - 1];
    if (id === undefined) throw new Error('nothing to withdraw');

    const noReason = await withdrawEvidence({
      evidenceId: id,
      reason: 'no',
      withdrawnBy: fx.human.id,
      now: NOW,
    });
    expect(noReason.status).toBe('refused');

    const done = await withdrawEvidence({
      evidenceId: id,
      reason: 'The auditor withdrew the attestation after a control failure was reported.',
      withdrawnBy: fx.human.id,
      now: NOW,
    });
    expect(done.status).toBe('ok');

    expect((await activationStanding(VENDOR, NOW)).activated).toBe(false);

    const { db } = await import('@bwc/db');
    const row = await db().vendorEvidence.findUnique({ where: { id } });
    // A compensating write, not a delete - what we relied on in March has to survive.
    expect(row).not.toBeNull();
    expect(row?.withdrawnAt).not.toBeNull();
  });
});

describe("CLAUDE.md's standing constraint", () => {
  it('refuses client onboarding, naming every vendor in the way', async () => {
    const result = await mayOnboardClients(NOW);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    for (const vendor of CLIENT_ONBOARDING_VENDORS) {
      expect(result.reason, vendor).toMatch(vendor);
    }
  });

  it('keeps the adapter reporting not_built with the outstanding items named', async () => {
    const result = await plaidTransactions.call({
      clientId: fx.tenant.id,
      consentReference: 'none',
      months: 12,
    });
    expect(result.status).toBe('not_built');
    if (result.status !== 'not_built') throw new Error('expected not_built');
    expect(result.reason).toMatch(/Argus security review/);
    expect(result.reason).toMatch(/signed DPA/);
  });
});
