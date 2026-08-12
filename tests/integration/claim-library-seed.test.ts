/**
 * The founding Marketing Claim Library - 7.4 seeded, and the one thing it must not do.
 *
 * The library was empty for every tenant, and `scanForTenant` refuses on an empty library. So the
 * effect was not lax scanning; it was that no client-facing content could be sent, generated or
 * approved at all. Seeding it is what turns 4.2 on.
 *
 * **The assertion this file exists for is the negative one.** A seed may ban a claim and may not
 * approve one. Banning is safe - over-banning produces a complaint from somebody holding the exact
 * phrase they wanted, which is the input the Compliance Review Board is for. Approving is not:
 * nobody complains about a phrase that was permitted, so the error is silent, repeated at scale,
 * and found by a regulator. `no approved claim reaches the library` is the test; the rest of this
 * file is the discipline that keeps the banned half honest.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  FOUNDING_CLAIMS,
  PROPOSED_CLAIMS,
  activeLibrary,
  inertPhrases,
  publish,
  seedFoundingClaims,
  seedProposedClaims,
  type MarketingClaim,
} from '@bwc/claims';
import { approveProposal, pendingProposals, proposeClaim } from '@bwc/marketing';
import { scanText } from '@bwc/scanner';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;
let library: MarketingClaim[];

const human = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('claim-seed');
  await seedFoundingClaims(fx.tenant.id, 'compliance_review_board', human());
  library = await activeLibrary({ tenantId: fx.tenant.id });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('a seed may ban a claim and may not approve one', () => {
  it('publishes no approved claim, at all', () => {
    // The whole point of the slice. An approved phrase authorises a promise this firm makes in
    // writing, and an agent is not who decides that.
    const approved = library.filter((claim) => claim.disposition === 'approved');
    expect(approved).toEqual([]);
  });

  it('publishes only banned and requires_disclaimer entries', () => {
    const dispositions = new Set(library.map((claim) => claim.disposition));
    expect([...dispositions].sort()).toEqual(['banned', 'requires_disclaimer']);
  });

  it('seeds a library large enough to be worth having', () => {
    // Not a magic number: a floor. The failure this guards against is a later edit that trims the
    // paraphrases back to the noun-phrase forms and leaves the sentence orders unmatched.
    expect(library.length).toBeGreaterThan(90);
    expect(library.filter((claim) => claim.disposition === 'banned').length).toBeGreaterThan(80);
  });

  it('routes the claims worth approving to 4.5 instead, where a human decides', async () => {
    const before = await activeLibrary({ tenantId: fx.tenant.id });

    const result = await seedProposedClaims(
      fx.tenant.id,
      // An Actor id, not a label: `submittedBy` is a UUID column, and Prisma rejects anything else.
      fx.human.id,
      human(),
      // The intake is injected: `proposeClaim` lives in @bwc/marketing, which already depends on
      // @bwc/claims, so importing it there would close a package cycle.
      proposeClaim,
    );

    expect(result.refused).toEqual([]);
    expect(result.submitted).toBe(PROPOSED_CLAIMS.length);

    const pending = await pendingProposals(fx.tenant.id);
    expect(pending.length).toBe(PROPOSED_CLAIMS.length);

    // ...and not one of them is in the library. A proposal is a question, not an entry.
    const after = await activeLibrary({ tenantId: fx.tenant.id });
    expect(after.length).toBe(before.length);
    for (const proposed of PROPOSED_CLAIMS) {
      expect(after.some((claim) => claim.phrase === proposed.phrase)).toBe(false);
    }
  });

  it('gives the Board something to review: every proposal states its intended use', () => {
    for (const proposed of PROPOSED_CLAIMS) {
      // `proposeClaim` refuses under 15 characters, because a phrase with no stated use cannot be
      // decided - the same sentence is fine on a landing page and a problem mid-application.
      expect(proposed.intendedUse.trim().length).toBeGreaterThanOrEqual(15);
      expect(proposed.note.trim().length).toBeGreaterThan(20);
    }
  });

  it('accepts `banned` as the outcome of a proposal, which is a decision and not a rejection', async () => {
    const pending = await pendingProposals(fx.tenant.id);
    const upfront = pending.find((proposal) => proposal.phrase === 'no upfront fees');
    expect(upfront).toBeDefined();
    if (!upfront) return;

    const decided = await approveProposal({
      tenantId: fx.tenant.id,
      proposalId: upfront.id,
      disposition: 'banned',
      rationale:
        'The firm is compensated on placement, so the unqualified claim is not accurate for every engagement. 1.4 states the fees for a specific engagement, which is the accurate answer.',
      approvedBy: fx.human.id,
      actor: human(),
    });

    expect(decided.status).toBe('ok');

    // Somebody asked whether we may say this; the answer is that nobody may, and it belongs in the
    // Library where the next person will find it rather than in a rejected proposal nobody reads.
    const after = await activeLibrary({ tenantId: fx.tenant.id });
    const entry = after.find((claim) => claim.phrase === 'no upfront fees');
    expect(entry?.disposition).toBe('banned');
  });
});

describe('a phrase that cannot match is not a rule', () => {
  it('seeds no phrase that begins or ends with a non-word character', () => {
    // The scanner binds `\b` at both ends. `\b` before `$` demands a word character immediately
    // before the `$`, and in "you qualify for $100K" that character is a space - so the entry
    // never fires. It still publishes, still appears in the library, and still counts toward
    // `libraryEntriesChecked`, which is the same shape of lie an empty library tells.
    expect(inertPhrases(FOUNDING_CLAIMS)).toEqual([]);
  });

  it('demonstrates the failure rather than asserting it, so the rule above has a reason', () => {
    const inert: MarketingClaim = {
      id: 'inert',
      tenantId: fx.tenant.id,
      phrase: '$100K',
      disposition: 'banned',
      rationale: 'A money promise, written the way it is written.',
      jurisdiction: '*',
      requiredDisclosure: null,
      approvedBy: 'crb',
      version: 1,
      active: true,
    };

    // A perfectly reasonable-looking library entry that matches nothing.
    const result = scanText('You qualify for $100K today.', [inert]);
    expect(result.verdict).toBe('clean');
    expect(result.findings).toEqual([]);
    // And it reports having checked one entry, so the pass looks thorough.
    expect(result.libraryEntriesChecked).toBe(1);

    // The same phrase without the leading symbol does fire, which is what makes this a property of
    // the boundary rather than of the numeral.
    expect(scanText('You qualify for 100K today.', [{ ...inert, phrase: '100K' }]).verdict).toBe(
      'blocked',
    );
  });

  it('seeds no duplicate phrase', () => {
    // `tests/invariants/compliance-scanner.test.ts` asserts `libraryEntriesChecked` equals
    // `FOUNDING_CLAIMS.length`. Two entries sharing a phrase would upsert into one row and quietly
    // break that assertion in a file this slice does not own.
    const phrases = FOUNDING_CLAIMS.map((claim) => claim.phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it('gives every entry a rationale, and every disclaimer entry its disclosure', () => {
    for (const claim of FOUNDING_CLAIMS) {
      // A banned phrase without a stated reason cannot be taught to a partner, cannot be argued
      // with, and cannot be revisited when the law changes. It calcifies into folklore.
      expect(claim.rationale.trim().length).toBeGreaterThan(20);
      if (claim.disposition === 'requires_disclaimer') {
        expect((claim.requiredDisclosure ?? '').trim().length).toBeGreaterThan(20);
      }
    }
  });
});

describe('the bans fire', () => {
  it.each([
    ['Your approval is guaranteed once you sign.', 'approval is guaranteed'],
    ['We can get you funded this week.', 'get you funded'],
    ['Bad credit no problem, instant approval.', 'instant approval'],
    ['There are no fees for this.', 'no fees'],
    ['I can sign for you if that is easier.', 'sign for you'],
    ['We should be able to secure six figures for you.', 'six figures'],
    ['We will just round your revenue up a little.', 'round your revenue up'],
    ['You can write this off against next year.', 'you can write this off'],
    ['This is a business grant, so it is free money.', 'business grant'],
    ['We can boost your credit score first.', 'boost your credit score'],
    ['Stop paying your creditors while we negotiate.', 'stop paying your creditors'],
    ['Send it over and we will edit your bank statements.', 'edit your bank statements'],
  ])('blocks %j on %j', (text, phrase) => {
    const result = scanText(text, library);
    expect(result.verdict).toBe('blocked');
    expect(result.findings.map((finding) => finding.phrase)).toContain(phrase);
  });

  it('covers the sentence order as well as the noun phrase', () => {
    // The lesson recorded in the 'approval is guaranteed' rationale: the noun-phrase entry alone
    // let the sentence form through, and the sentence form is what a person actually writes.
    for (const text of [
      'You have guaranteed approval.',
      'Your approval is guaranteed.',
      'Approval guaranteed for every applicant.',
      'We guarantee approval on this product.',
      'You are guaranteed to be approved.',
    ]) {
      expect(scanText(text, library).verdict).toBe('blocked');
    }
  });
});

describe('the library does not block the firm own compliance prose', () => {
  // The false-positive direction, and the reason several obvious bans are absent. A scanner that
  // blocks the disclaimer written to satisfy it is a scanner that gets routed around within a week,
  // and then it protects nothing.
  it.each([
    [
      'the standing not-a-lender disclosure, which contains "credit repair organization"',
      'Burkham Wickmont is not a lender, investment adviser, or credit repair organization. We do not make credit decisions and cannot promise any outcome.',
    ],
    [
      'the no-guarantee disclosure',
      'Nothing in this document is an offer or commitment of credit. Approval decisions rest solely with the applicable provider.',
    ],
    [
      'the CROA disclosure, which contains "remove, repair or dispute"',
      'Burkham Wickmont does not remove, repair or dispute items on any consumer or business credit report, and is not a Credit Repair Organization.',
    ],
    [
      'the regulatory no-guarantee disclosure, which contains "is guaranteed"',
      'No approval, credit limit, rate or funding amount is guaranteed. Any figures shown are estimates based on information available at the time of preparation.',
    ],
    [
      'the authorization disclosure',
      'No application is submitted to any provider without the client written authorization for that specific application.',
    ],
    ['a true statement about what cannot be removed', 'Negative items cannot be removed by anyone, including us.'],
    ['a true statement about approval', 'There is no assurance that any application will be approved.'],
  ])('leaves %s clean', (_name, text) => {
    expect(scanText(text, library).verdict).toBe('clean');
  });
});

describe('seeding is idempotent and never runs on import', () => {
  it('restates the library rather than duplicating it', async () => {
    const before = await activeLibrary({ tenantId: fx.tenant.id });
    await seedFoundingClaims(fx.tenant.id, 'compliance_review_board', human());
    const after = await activeLibrary({ tenantId: fx.tenant.id });

    expect(after.length).toBe(before.length);

    // The version does move, and should: a re-seed is a restatement of the rules of record.
    const first = after.find((claim) => claim.phrase === 'guaranteed approval');
    const original = before.find((claim) => claim.phrase === 'guaranteed approval');
    expect(first?.version).toBeGreaterThan(original?.version ?? 0);
  });

  it('leaves a fresh tenant empty until it is called', async () => {
    // The seeds are exported data and functions. Importing this module publishes nothing.
    const untouched = await makeFixture('claim-seed-untouched');
    try {
      expect(await activeLibrary({ tenantId: untouched.tenant.id })).toEqual([]);
    } finally {
      await cleanupTenant(untouched.tenant.id);
    }
  });

  it('still refuses a publish with no rationale, seed or not', async () => {
    const result = await publish({
      tenantId: fx.tenant.id,
      phrase: 'a phrase with no reasoning',
      disposition: 'banned',
      rationale: '  ',
      approvedBy: 'crb',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});
