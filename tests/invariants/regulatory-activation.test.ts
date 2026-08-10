/**
 * Invariants for the state activation gate - 7.2 and specification §11.2.
 *
 * > "No state comes online without documented counsel review of the state's Regulatory Engine
 * > module."
 *
 * Everything here tests one property from a different angle: **a state is servable only when a
 * named human recorded a review of the exact module version now in force.** Each test removes one
 * of those clauses and checks the answer flips.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FEDERAL_BASELINE,
  V1_PRIORITY_STATES,
  V1_STATE_SEEDS,
  activateState,
  activeStates,
  coverage,
  currentModule,
  markChangeAddressed,
  missingDisclosures,
  moduleHistory,
  outstandingLawChanges,
  publishStateModule,
  recordLawChange,
  requiredDisclosures,
  seedV1PriorityStates,
  standingFor,
  withdrawState,
} from '@bwc/regulatory';
import { read } from '@bwc/ledger';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('regulatory');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const human = () => ({ id: fx.human.id, kind: 'human' as const });
const agent = () => ({ id: fx.agent.id, kind: 'village_agent' as const });

const REVIEWED_AT = new Date('2026-08-01T00:00:00.000Z');

const publish = (
  state: string,
  overrides: Partial<Parameters<typeof publishStateModule>[0]> = {},
) =>
  publishStateModule({
    tenantId: fx.tenant.id,
    state,
    summary: `Rules for ${state}.`,
    citations: [`${state} Commercial Financing Act`],
    disclosures: [
      {
        key: `${state.toLowerCase()}_disclosure`,
        text: `A ${state} disclosure.`,
        citation: `${state} Commercial Financing Act §1`,
      },
    ],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
    ...overrides,
  });

const activate = (state: string, overrides: Record<string, unknown> = {}) =>
  activateState({
    tenantId: fx.tenant.id,
    state,
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: REVIEWED_AT,
    documentReference: 'Memo BW-REG-2026-014',
    ...overrides,
  });

describe('a state is not active until counsel has reviewed it', () => {
  it('reports no_module for a state nobody has written rules for', async () => {
    const standing = await standingFor(fx.tenant.id, 'WY');
    expect(standing.status).toBe('no_module');
    expect(standing.permitsClientFacingAction).toBe(false);
    expect(standing.explanation).toMatch(/No regulatory module exists for WY/);
  });

  it('does not activate a state merely by publishing its module', async () => {
    // The whole point. Writing the rules down is not the same as anyone having checked them.
    await publish('CO');

    const standing = await standingFor(fx.tenant.id, 'CO');
    expect(standing.status).toBe('draft');
    expect(standing.permitsClientFacingAction).toBe(false);
    expect(standing.explanation).toMatch(/never been activated/);
    expect(standing.currentVersion).toBe(1);
    expect(standing.reviewedVersion).toBeNull();
  });

  it('activates once a human at Level 3 records a documented review', async () => {
    await publish('NM');
    const result = await activate('NM');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.status).toBe('active');
    expect(result.value.permitsClientFacingAction).toBe(true);
    expect(result.value.reviewedVersion).toBe(1);
  });

  it('refuses activation by an agent, whatever it claims to be', async () => {
    // Not a policy check but a refusal: an agent able to bring a state online would make the
    // counsel-review gate decorative, and a gate that can be bypassed is not a gate.
    await publish('ID');
    const result = await activate('ID', { actor: agent() });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/requires a human at Authority Level 3/);
      expect(result.principle).toMatch(/11\.2/);
    }
    expect((await standingFor(fx.tenant.id, 'ID')).permitsClientFacingAction).toBe(false);
  });

  it('reads the actor from the database rather than trusting the caller', async () => {
    // The EventActor is supplied by the caller. A gate that believes its caller about whether the
    // caller is allowed through is not a gate - so the level is read from the recorded actor.
    await publish('MT');
    const result = await activate('MT', { actor: { id: fx.observer.id, kind: 'village_agent' } });
    expect(result.status).toBe('refused');
  });

  it('refuses activation with no document reference', async () => {
    // A review nobody can produce is indistinguishable from one that never happened.
    await publish('OR');
    const result = await activate('OR', { documentReference: '   ' });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/document reference/i);
  });

  it('refuses activation with no named counsel', async () => {
    await publish('WA');
    expect((await activate('WA', { reviewedBy: '' })).status).toBe('refused');
  });

  it('refuses to activate a state that has no module to have reviewed', async () => {
    const result = await activate('AK');
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/nothing for counsel/i);
  });

  it('records the activation in the Ledger with the review that permitted it', async () => {
    const events = await read({ tenantId: fx.tenant.id, type: 'regulatory.state.activated' });
    const nm = events.find((event) => event.payload['state'] === 'NM');

    expect(nm?.payload['reviewedBy']).toBe('Outside counsel, Fig & Rowe LLP');
    expect(nm?.payload['documentReference']).toBe('Memo BW-REG-2026-014');
    expect(nm?.payload['moduleVersion']).toBe(1);
  });
});

describe('a material change sends an active state back to counsel', () => {
  it('deactivates on a material republish', async () => {
    await publish('KS');
    expect((await activate('KS')).status).toBe('ok');

    await publish('KS', { summary: 'Rules for KS, materially revised.' });

    const standing = await standingFor(fx.tenant.id, 'KS');
    expect(standing.status).toBe('needs_counsel_review');
    expect(standing.permitsClientFacingAction).toBe(false);
    expect(standing.reviewedVersion).toBe(1);
    expect(standing.currentVersion).toBe(2);
    expect(standing.explanation).toMatch(/version 2 made a material change/);
  });

  it('leaves activation intact for an editorial change', async () => {
    await publish('IA');
    expect((await activate('IA')).status).toBe('ok');

    await publish('IA', {
      changeKind: 'editorial',
      changeRationale: 'Corrected a statute section number in a citation; no requirement changed.',
    });

    // Version advanced, activation still covers it, because an editorial change does not move
    // what the module requires.
    //
    // This assertion originally read `needs_counsel_review` - agreeing with the code and
    // contradicting its own test name. The implementation compared version numbers alone, so
    // every republish deactivated and `changeKind` was decorative. Stricter, and still wrong: a
    // rule that punishes a typo fix exactly as hard as a rewrite teaches people to batch typo
    // fixes into rewrites.
    const standing = await standingFor(fx.tenant.id, 'IA');
    expect(standing.currentVersion).toBe(2);
    expect(standing.status).toBe('active');
    expect(standing.permitsClientFacingAction).toBe(true);
    expect(standing.reviewedVersion).toBe(1);
  });

  it('still sends the state back when a material change follows an editorial one', async () => {
    // The version-number shortcut would also have got this right, so it is worth pinning: the
    // rule is "any material change since the reviewed version", not "the latest change was
    // material". An editorial patch on top of an unreviewed rewrite must not launder it.
    await publish('IA', { summary: 'Rules for IA, materially revised.' });
    await publish('IA', {
      changeKind: 'editorial',
      changeRationale: 'Fixed a typo introduced in version 3.',
      summary: 'Rules for IA, materially revised.',
    });

    const standing = await standingFor(fx.tenant.id, 'IA');
    expect(standing.currentVersion).toBe(4);
    expect(standing.status).toBe('needs_counsel_review');
    expect(standing.explanation).toMatch(/version 3 made a material change/);
  });

  it('refuses an editorial change with no rationale', async () => {
    // Declaring a change non-material suppresses a counsel review, so it has to be an assertion
    // somebody made deliberately rather than a default nobody chose.
    await publish('NE');
    const result = await publish('NE', { changeKind: 'editorial' });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/needs a rationale/);
  });

  it('refuses to call a first version editorial', async () => {
    // There is no prior version for it to be editorially different from - and the claim is
    // exactly the one that would let a whole state module skip its first review.
    const result = await publish('SD', {
      changeKind: 'editorial',
      changeRationale: 'Trying to skip the first review.',
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/cannot be editorial/);
  });

  it('re-activating after a material change requires a fresh review of the new version', async () => {
    const reactivated = await activate('KS', {
      documentReference: 'Memo BW-REG-2026-021',
      reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    });

    expect(reactivated.status).toBe('ok');
    if (reactivated.status !== 'ok') return;

    expect(reactivated.value.status).toBe('active');
    expect(reactivated.value.reviewedVersion).toBe(2);
  });

  it('keeps every version readable, with its change kind', async () => {
    const history = await moduleHistory(fx.tenant.id, 'KS');
    expect(history).toHaveLength(2);
    expect(history[0]?.version).toBe(2);
    expect(history[0]?.supersededAt).toBeNull();
    expect(history[1]?.supersededAt).not.toBeNull();
  });
});

describe('publishing a module', () => {
  it('refuses a module with no citations', async () => {
    // A state module is a claim about what the law requires. Without the law it cites there is
    // nothing for counsel to review, and no way to tell a researched rule from a guess.
    const result = await publish('ND', { citations: [] });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/no citations/);
  });

  it('refuses a disclosure requirement with no citation', async () => {
    const result = await publish('MN', {
      disclosures: [{ key: 'uncited', text: 'Something must be disclosed.', citation: '  ' }],
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/no citation/);
  });
});

describe('withdrawal', () => {
  it('takes an active state offline and says why', async () => {
    await publish('VT');
    await activate('VT');

    const result = await withdrawState({
      tenantId: fx.tenant.id,
      state: 'VT',
      actor: human(),
      reason: 'Licensing question raised by counsel pending resolution.',
      now: new Date('2026-08-09T00:00:00.000Z'),
    });

    expect(result.status).toBe('ok');
    const standing = await standingFor(fx.tenant.id, 'VT');
    expect(standing.status).toBe('withdrawn');
    expect(standing.permitsClientFacingAction).toBe(false);
    expect(standing.explanation).toMatch(/Licensing question/);
  });

  it('requires a reason, and Level 3', async () => {
    expect(
      (
        await withdrawState({
          tenantId: fx.tenant.id,
          state: 'VT',
          actor: human(),
          reason: '  ',
        })
      ).status,
    ).toBe('refused');

    expect(
      (
        await withdrawState({
          tenantId: fx.tenant.id,
          state: 'VT',
          actor: agent(),
          reason: 'An agent trying to take a state offline.',
        })
      ).status,
    ).toBe('refused');
  });
});

describe('disclosures', () => {
  it('returns the federal baseline even where a state requires nothing extra', async () => {
    // An empty list would read as "nothing must be disclosed here", which is never true.
    const disclosures = await requiredDisclosures({ tenantId: fx.tenant.id, state: 'WY' });

    expect(disclosures.length).toBe(FEDERAL_BASELINE.length);
    expect(disclosures.every((entry) => entry.source === 'federal')).toBe(true);
  });

  it('layers the state requirements on top of the federal baseline', async () => {
    const disclosures = await requiredDisclosures({ tenantId: fx.tenant.id, state: 'NM' });

    expect(disclosures.length).toBeGreaterThan(FEDERAL_BASELINE.length);
    // Federal first: the unconditional obligations should be met before the jurisdictional ones.
    expect(disclosures[0]?.source).toBe('federal');
    expect(disclosures.some((entry) => entry.source === 'NM')).toBe(true);
  });

  it('carries a citation on every disclosure', async () => {
    // A requirement with no cited basis cannot be reviewed, argued with, or revisited when the
    // statute changes. Same reasoning as a banned marketing phrase needing its rationale.
    const disclosures = await requiredDisclosures({ tenantId: fx.tenant.id, state: 'NM' });
    for (const disclosure of disclosures) {
      expect(disclosure.citation.length, disclosure.key).toBeGreaterThan(5);
    }
  });

  it('names the ones a document is missing', () => {
    const missing = missingDisclosures(FEDERAL_BASELINE, ['not_a_lender', 'no_guarantee']);
    expect(missing.map((entry) => entry.key)).toEqual([
      'not_credit_repair',
      'application_authorization',
      'business_purpose',
    ]);
  });

  it('states plainly that Burkham Wickmont is not a lender and guarantees nothing', () => {
    // Principle 1 made concrete: these two are what stop the company being recharacterised.
    const keys = FEDERAL_BASELINE.map((entry) => entry.key);
    expect(keys).toContain('not_a_lender');
    expect(keys).toContain('no_guarantee');
    expect(keys).toContain('not_credit_repair');
  });
});

describe('the V1 priority states', () => {
  it('seeds all seven as drafts, and activates none of them', async () => {
    // The seeded content is a scaffold for counsel, not legal advice - and the gate is what makes
    // that distinction enforceable rather than a disclaimer in a comment.
    const published = await seedV1PriorityStates(
      fx.tenant.id,
      'compliance@burkhamwickmont.test',
      human(),
    );
    expect(published).toBe(7);

    for (const state of V1_PRIORITY_STATES) {
      const standing = await standingFor(fx.tenant.id, state);
      expect(standing.status, state).toBe('draft');
      expect(standing.permitsClientFacingAction, state).toBe(false);
    }

    expect(await activeStates(fx.tenant.id)).not.toContain('CA');
  });

  it('cites a statute for every seeded state', () => {
    for (const seed of V1_STATE_SEEDS) {
      expect(seed.citations.length, seed.state).toBeGreaterThan(0);
      expect(seed.summary.length, seed.state).toBeGreaterThan(40);
    }
  });

  it('says so when a state appears to have no disclosure statute rather than inventing one', () => {
    // An invented rule is worse than a missing one: it looks reviewed.
    const texas = V1_STATE_SEEDS.find((seed) => seed.state === 'TX');
    expect(texas?.disclosures).toHaveLength(0);
    expect(texas?.summary).toMatch(/counsel should confirm/i);
  });

  it('reports coverage across every state with a module', async () => {
    const map = await coverage(fx.tenant.id);
    expect(map.length).toBeGreaterThanOrEqual(V1_PRIORITY_STATES.length);
    for (const standing of map) {
      expect(standing.explanation.length).toBeGreaterThan(20);
    }
  });
});

describe('the state-law change tracker', () => {
  it('records a change without altering the module or the activation', async () => {
    // Noticing that a state amended its regulations is not the same as knowing what our module
    // should now say, and auto-deactivating on a notice would let anyone with write access take
    // a state offline by filing a bulletin.
    await publish('ME');
    await activate('ME');

    const change = await recordLawChange({
      tenantId: fx.tenant.id,
      state: 'ME',
      summary: 'Commercial financing disclosure bill enacted.',
      citation: 'ME LD 1234 (2026)',
      noticedBy: 'compliance@burkhamwickmont.test',
      noticedAt: new Date('2026-08-05T00:00:00.000Z'),
      actor: human(),
    });

    expect((await standingFor(fx.tenant.id, 'ME')).status).toBe('active');

    const outstanding = await outstandingLawChanges(fx.tenant.id, 'ME');
    expect(outstanding.map((entry) => entry.id)).toContain(change.id);
  });

  it('clears from the backlog once a module version incorporates it', async () => {
    const [change] = await outstandingLawChanges(fx.tenant.id, 'ME');
    if (!change) throw new Error('expected an outstanding change');

    await publish('ME', { summary: 'Rules for ME, incorporating LD 1234.' });
    await markChangeAddressed({
      tenantId: fx.tenant.id,
      changeId: change.id,
      moduleVersion: 2,
      actor: human(),
    });

    expect(await outstandingLawChanges(fx.tenant.id, 'ME')).toHaveLength(0);
    // And the material republish did what it should: ME is back with counsel.
    expect((await standingFor(fx.tenant.id, 'ME')).status).toBe('needs_counsel_review');
  });

  it('keeps the current module readable while a change is outstanding', async () => {
    const module = await currentModule(fx.tenant.id, 'ME');
    expect(module.status).toBe('ok');
    if (module.status === 'ok') expect(module.value.version).toBe(2);
  });
});
