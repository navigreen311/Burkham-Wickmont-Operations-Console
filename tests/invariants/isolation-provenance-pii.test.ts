/**
 * Invariants: tenant isolation, provenance on output, honest refusal states, PII never
 * reaching the Ledger, and the success-fee basis.
 *
 * Grouped because each is short and all five are the "zero tolerance" class in
 * Specification v2 section 10.5.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { create as createClient, find as findClient } from '@bwc/clients';
import { append, read } from '@bwc/ledger';
import { chain } from '@bwc/middleware';
import { assertSameTenant } from '@bwc/tenancy';
import { assembleRecommendation, successFeeBasis } from '@bwc/placement';
import { isActivated, outstandingPreconditions, plaidTransactions } from '@bwc/integration';
import {
  OUTCOME_STATUSES,
  REDACTED,
  assertNoPii,
  hasProvenance,
  redactPii,
  requireProvenance,
  sourced,
} from '@bwc/core';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await makeFixture('iso-a');
  b = await makeFixture('iso-b');
});

afterAll(async () => {
  await cleanupTenant(a.tenant.id);
  await cleanupTenant(b.tenant.id);
});

describe('multi-tenant isolation is strict', () => {
  it('refuses a cross-tenant assertion', () => {
    expect(assertSameTenant(a.tenant.id, b.tenant.id).status).toBe('refused');
    expect(assertSameTenant(a.tenant.id, a.tenant.id).status).toBe('ok');
  });

  it("refuses a read of another tenant's client", async () => {
    const client = await createClient(b.tenant.id, 'Tenant B Co', {
      id: b.human.id,
      kind: 'human',
    });

    // Same client id, wrong tenant. Must not resolve.
    const leaked = await findClient(a.tenant.id, client.id);
    expect(leaked.status).not.toBe('ok');
  });

  it('blocks a cross-tenant action at the chain and logs it to the actor tenant', async () => {
    const { result, trace } = await chain({
      actorId: a.agent.id,
      tenantId: b.tenant.id,
      action: 'draft_recommendation',
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');
    expect(trace.find((step) => step.step === 'tenant_scope')?.outcome).toBe('blocked');

    const blockedInA = await read({
      tenantId: a.tenant.id,
      type: 'tenancy.cross_tenant_access_blocked',
    });
    expect(blockedInA.length).toBeGreaterThan(0);

    // The target tenant must not gain a record of an outsider's attempt.
    const blockedInB = await read({
      tenantId: b.tenant.id,
      type: 'tenancy.cross_tenant_access_blocked',
    });
    expect(blockedInB.length).toBe(0);
  });
});

describe('provenance on output', () => {
  it('requires provenance structurally - a bare value cannot be assembled', () => {
    const recommendation = assembleRecommendation({
      provider: sourced('Navy Federal', {
        tag: 'issuer_rule',
        sourceUrl: 'https://example.invalid/terms',
        lastVerified: '2026-08-01',
        verifiedBy: 'funding_strategy',
      }),
      product: sourced('Business LOC', {
        tag: 'unresearched_default',
        rationale: 'assumed from product family; not verified against the issuer',
      }),
      requestedCreditLimit: 50_000,
      rationale: 'test',
      alternativesRejected: [],
    });

    expect(hasProvenance(recommendation.provider)).toBe(true);
    expect(hasProvenance(recommendation.product)).toBe(true);
    // Any unresearched input must surface on the recommendation as a whole - Decision D.
    expect(recommendation.containsUnverifiedInputs).toBe(true);
  });

  it('rejects an untagged rule at the write guard', () => {
    expect(() => {
      requireProvenance({ rule: 'max 3 applications per 30 days' }, 'lender rule write');
    }).toThrow(/provenance/i);
  });
});

describe('honest empty states and refusals', () => {
  it('keeps all five outcome statuses distinguishable', () => {
    expect(new Set(OUTCOME_STATUSES).size).toBe(OUTCOME_STATUSES.length);
    expect([...OUTCOME_STATUSES].sort()).toEqual([
      'failed',
      'no_data',
      'not_built',
      'ok',
      'refused',
    ]);
  });

  it('reports an ungated vendor as not_built with the outstanding preconditions named', async () => {
    expect(isActivated('plaid')).toBe(false);
    expect(outstandingPreconditions('plaid')).toContain('Argus security review');

    const outcome = await plaidTransactions.call({
      clientId: 'irrelevant',
      consentReference: 'irrelevant',
      months: 24,
    });

    // Never an empty transaction list, which would read as "this client has no activity".
    expect(outcome.status).toBe('not_built');
  });

  it('names the two vendors whose selection is still open', () => {
    expect(outstandingPreconditions('business_bureau')).toContain('vendor selection');
    expect(outstandingPreconditions('personal_credit')).toContain('vendor selection');
  });
});

describe('PII never reaches the Ledger', () => {
  it('redacts by field name and by value shape', () => {
    const redacted = redactPii({
      legalName: 'Acme LLC',
      ssn: '123-45-6789',
      note: 'contact on 987-65-4321',
      nested: { bankAccountNumber: '12345678901' },
    }) as Record<string, unknown>;

    expect(redacted['legalName']).toBe('Acme LLC');
    expect(redacted['ssn']).toBe(REDACTED);
    expect(redacted['note']).toBe(REDACTED);
    expect((redacted['nested'] as Record<string, unknown>)['bankAccountNumber']).toBe(REDACTED);
  });

  it('throws when PII survives into a payload', () => {
    expect(() => assertNoPii({ ssn: '123-45-6789' }, 'test')).toThrow(/PII detected/i);
  });

  it('strips PII on append rather than storing it', async () => {
    const event = await append({
      tenantId: a.tenant.id,
      type: 'client.created',
      actor: { id: a.human.id, kind: 'human' },
      payload: { legalName: 'Acme LLC', ssn: '123-45-6789', taxId: '12-3456789' },
    });

    expect(event.payload['legalName']).toBe('Acme LLC');
    expect(event.payload['ssn']).toBe(REDACTED);
    expect(event.payload['taxId']).toBe(REDACTED);

    const stored = (await read({ tenantId: a.tenant.id })).find((e) => e.id === event.id);
    expect(JSON.stringify(stored?.payload)).not.toContain('123-45-6789');
  });
});

describe('success fees compute from approvedCreditLimit', () => {
  it('takes only the approved figure, so the requested one cannot be passed by mistake', () => {
    expect(successFeeBasis(75_000)).toBe(75_000);
    expect(successFeeBasis.length).toBe(1);
  });

  it('rejects a negative or non-finite basis', () => {
    expect(() => successFeeBasis(-1)).toThrow();
    expect(() => successFeeBasis(Number.NaN)).toThrow();
  });
});
