/**
 * Invariants for 4.2 Communication Compliance Scanner and 7.4 Marketing Claim Library.
 *
 * Tested in both directions on purpose. A scanner that catches banned language but also blocks
 * legitimate text gets routed around within a week, and then it protects nothing — so the false
 * positive cases matter as much as the false negatives.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { read } from '@bwc/ledger';
import {
  ALL_JURISDICTIONS,
  FOUNDING_CLAIMS,
  activeLibrary,
  deprecate,
  publish,
  seedFoundingClaims,
  type MarketingClaim,
} from '@bwc/claims';
import { scanForTenant, scanText } from '@bwc/scanner';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;
let library: MarketingClaim[];

beforeAll(async () => {
  fx = await makeFixture('scanner');
  await seedFoundingClaims(fx.tenant.id, 'compliance_review_board', {
    id: fx.human.id,
    kind: 'human',
  });
  library = await activeLibrary({ tenantId: fx.tenant.id });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

describe('banned language is blocked', () => {
  it.each([
    'You have guaranteed approval for this product.',
    'This is a no risk opportunity.',
    'We can remove negative items from your report.',
    'We are a lender and can fund you directly.',
    'You are pre-approved for $100,000.',
  ])('blocks %j', (text) => {
    expect(scanText(text, library).verdict).toBe('blocked');
  });

  it('matches across a line break, the most obvious accidental bypass', () => {
    // A phrase split by wrapping would defeat a naive matcher, and the resulting clean scan
    // would look exactly like a passing one.
    expect(scanText('You have guaranteed\napproval today.', library).verdict).toBe('blocked');
  });

  it('is case-insensitive', () => {
    expect(scanText('GUARANTEED APPROVAL', library).verdict).toBe('blocked');
  });

  it('reports where the phrase appeared, so a reviewer can find it', () => {
    const result = scanText('All good here. You have guaranteed approval.', library);
    const finding = result.findings.find((f) => f.phrase === 'guaranteed approval');
    expect(finding).toBeDefined();
    expect(finding?.offset).toBeGreaterThan(0);
    expect(finding?.excerpt).toContain('guaranteed approval');
    // The rationale travels with the finding: a reviewer should not have to look up why.
    expect(finding?.rationale.length).toBeGreaterThan(20);
  });
});

describe('legitimate language is not blocked', () => {
  it.each([
    'No guarantee of approval is expressed or implied.',
    'We cannot guarantee any particular outcome.',
    'Approval decisions rest solely with the provider.',
    'There is no assurance that any application will be approved.',
    'Risk factors are described in the accompanying schedule.',
    'Negative items cannot be removed by anyone, including us.',
  ])('passes %j', (text) => {
    // Each of these contains words from banned phrases without containing a banned phrase.
    // Word-boundary matching is what separates them; substring matching would block all six.
    expect(scanText(text, library).verdict).not.toBe('blocked');
  });

  it('does not fire on a banned phrase embedded in a longer word', () => {
    expect(scanText('The unguaranteed approvals list is attached.', library).verdict).not.toBe(
      'blocked',
    );
  });
});

describe('requires-disclaimer language is flagged, not blocked', () => {
  it('returns the disclosure the phrase obliges', () => {
    const result = scanText('Estimated savings of up to $4,000 per year.', library);

    expect(result.verdict).toBe('requires_disclosure');
    expect(result.requiredDisclosures.length).toBeGreaterThan(0);
    expect(result.requiredDisclosures.join(' ')).toMatch(/not an offer or commitment|maximums/i);
  });

  it('reports clean for ordinary prose', () => {
    const result = scanText('Your September statement is attached for review.', library);
    expect(result.verdict).toBe('clean');
    expect(result.findings).toHaveLength(0);
  });
});

describe('a scan that checked nothing is not a pass', () => {
  it('refuses when the tenant has an empty claim library', async () => {
    const empty = await makeFixture('scanner-empty');
    try {
      const result = await scanForTenant({
        tenantId: empty.tenant.id,
        text: 'You have guaranteed approval.',
        actor: { id: empty.human.id, kind: 'human' },
        context: 'test',
      });

      // The dangerous alternative: verdict 'clean' from a scanner with nothing to check against.
      expect(result.status).toBe('refused');
      if (result.status === 'refused') expect(result.reason).toMatch(/empty/i);
    } finally {
      await cleanupTenant(empty.tenant.id);
    }
  });

  it('reports how many library entries it checked', async () => {
    const result = await scanForTenant({
      tenantId: fx.tenant.id,
      text: 'Ordinary prose.',
      actor: actor(),
      context: 'test',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.libraryEntriesChecked).toBe(FOUNDING_CLAIMS.length);
  });
});

describe('blocks are recorded for the Compliance Review Board', () => {
  it('writes a ledger event naming the phrase but not the client text', async () => {
    await scanForTenant({
      tenantId: fx.tenant.id,
      text: 'You have guaranteed approval, Acme Operating LLC.',
      actor: actor(),
      context: 'test message',
    });

    const events = await read({ tenantId: fx.tenant.id, type: 'scanner.blocked_content' });
    expect(events.length).toBeGreaterThan(0);

    const latest = events[events.length - 1];
    expect(latest?.payload['blockedPhrases']).toContain('guaranteed approval');
    // The offending content is client text in an append-only store retained indefinitely.
    expect(JSON.stringify(latest?.payload)).not.toContain('Acme Operating LLC');
  });
});

describe('the claim library is governed, not ad hoc', () => {
  it('refuses a claim with no rationale', async () => {
    const result = await publish({
      tenantId: fx.tenant.id,
      phrase: 'some new phrase',
      disposition: 'banned',
      rationale: '   ',
      approvedBy: 'crb',
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a requires_disclaimer entry with no disclosure', async () => {
    const result = await publish({
      tenantId: fx.tenant.id,
      phrase: 'projected',
      disposition: 'requires_disclaimer',
      rationale: 'Projections need their basis stated.',
      approvedBy: 'crb',
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });

  it('deprecates rather than deletes, so past deliverables stay explicable', async () => {
    const published = await publish({
      tenantId: fx.tenant.id,
      phrase: 'temporary phrase',
      disposition: 'banned',
      rationale: 'Banned pending counsel review.',
      approvedBy: 'crb',
      actor: actor(),
    });
    if (published.status !== 'ok') throw new Error('publish failed');

    expect(
      scanText('a temporary phrase here', await activeLibrary({ tenantId: fx.tenant.id })).verdict,
    ).toBe('blocked');

    const deprecated = await deprecate(fx.tenant.id, published.value.id, actor());
    expect(deprecated.status).toBe('ok');

    // Gone from the active library...
    const after = await activeLibrary({ tenantId: fx.tenant.id });
    expect(after.some((claim) => claim.phrase === 'temporary phrase')).toBe(false);
    // ...but the record survives, so a March deliverable can still be explained.
    expect(deprecated.status === 'ok' && deprecated.value.active).toBe(false);
  });

  it('adds jurisdiction-scoped bans to the national list rather than replacing it', async () => {
    await publish({
      tenantId: fx.tenant.id,
      phrase: 'special california phrasing',
      disposition: 'banned',
      rationale: 'CA SB 1235 disclosure regime.',
      approvedBy: 'crb',
      actor: actor(),
      jurisdiction: 'CA',
    });

    const caLibrary = await activeLibrary({ tenantId: fx.tenant.id, jurisdiction: 'CA' });
    const nvLibrary = await activeLibrary({ tenantId: fx.tenant.id, jurisdiction: 'NV' });

    expect(caLibrary.some((claim) => claim.phrase === 'special california phrasing')).toBe(true);
    expect(nvLibrary.some((claim) => claim.phrase === 'special california phrasing')).toBe(false);

    // The national bans are present in both.
    expect(caLibrary.some((claim) => claim.phrase === 'guaranteed approval')).toBe(true);
    expect(nvLibrary.some((claim) => claim.phrase === 'guaranteed approval')).toBe(true);
  });

  it('uses a sentinel rather than NULL so the unique constraint actually constrains', async () => {
    const globals = (await activeLibrary({ tenantId: fx.tenant.id })).filter(
      (claim) => claim.phrase === 'guaranteed approval',
    );
    // Two rows would exist here if jurisdiction were nullable, since NULL != NULL in Postgres.
    expect(globals).toHaveLength(1);
    expect(globals[0]?.jurisdiction).toBe(ALL_JURISDICTIONS);
  });
});
