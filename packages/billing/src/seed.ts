/**
 * The five-offer ladder, as a DRAFT for the owner to correct.
 *
 * **Every figure in this file is invented and none of it is researched.** Nobody told me what this
 * firm charges. What follows is a scaffold with the right shape - five rungs, ascending, with the
 * credit chain computable between them - so that the owner has something concrete to correct rather
 * than a blank ladder. `LADDER_FIGURES_TO_CONFIRM` lists every number, and the seeding function
 * refuses to run in `live` integration mode so a draft price cannot quietly become a real one.
 *
 * **The numbers are deliberately round.** $2,500 and not $2,485; 500 basis points and not 487.
 * A round number is visibly a placeholder and gets changed. A specific one looks like the output of
 * an analysis somebody did, and it survives review because nobody wants to argue with research
 * that does not exist.
 *
 * ---
 *
 * **Why an empty ladder is a problem today, and not just an unfinished feature.** ADR-0018 makes
 * the published ladder the DEFINITION of an arm's-length price: an intercompany engagement is
 * checked against what unrelated clients actually pay, because a price a stranger paid is better
 * evidence than any transfer-pricing model this firm could defend. With no ladder published there
 * is no such price, so `mayCharge` cannot show that any related-party engagement is priced
 * correctly - and MedLink, Greenstone, Argus and Collingswood are all related parties.
 *
 * That is what this file unblocks. It does not make the figures right.
 *
 * ---
 *
 * **Units.** Everything here is integer cents and basis points, per ADR-0011. The concrete reason,
 * not the abstract one: `(0.615).toFixed(2)` is `'0.61'`, and `paid - earned` in floats can be
 * `-0.001`, which is not a refund anybody can pay. `fromDollars` is used at the boundary because it
 * THROWS on a fraction of a cent rather than truncating.
 *
 * **`@bwc/lenders` stores whole dollars and this module stores cents.** They are not interchangeable
 * and nothing here reads a lender figure. A number that crossed that boundary unconverted would be
 * wrong by a factor of a hundred in the direction that flatters us.
 */

import { fromDollars, type Cents } from './money.js';
import { currentOffer, publishOffer, type OfferRecord } from './engagements.js';
import type { EventActor, Outcome } from '@bwc/core';

/**
 * A rung of the ladder.
 *
 * `successFeeBasisPoints` computes against `approvedCreditLimit` and never `creditLimit` - the
 * Seek Capital lesson, and a revenue-integrity bug if inverted. This file does not perform that
 * computation; it only states the rate the computation will use.
 */
interface SeedOffer {
  readonly key: string;
  readonly name: string;
  readonly rung: number;
  readonly description: string;
  readonly retainerCents: Cents;
  readonly monthlyCents: Cents;
  readonly successFeeBasisPoints: number;
  readonly minimumCents: Cents;
  readonly committedMonths: number;
}

/**
 * Five rungs, because blueprint 1.4 owns a "5-offer ladder".
 *
 * The SHAPE is defensible and is the part worth keeping if the numbers change:
 *
 *   - Rung 1 has no success fee. A client paying for readiness work has not been placed with
 *     anybody, and charging a placement rate for advice is the shape principle 1 fails.
 *   - The success fee rises with the rung while the retainer rises faster. Principle 2 says
 *     structure rewards stewardship, not transactions: the higher rungs should be worth more to
 *     this firm through the recurring relationship, not through a bigger cut of a single placement.
 *   - `committedMonths` rises with the rung, and every rung has a stated minimum, because 1.4 owns
 *     "engagement minimum tracking" and a minimum of zero is not a minimum.
 *   - Rung 5 is annual-prepay only in intent; the mechanism for that is not modelled here.
 */
export const OFFER_LADDER: readonly SeedOffer[] = [
  {
    key: 'readiness',
    name: 'Capital Readiness',
    rung: 1,
    description:
      'DRAFT PRICING. Capital readiness assessment and the artifacts that come out of it. No placement, and deliberately no success fee: a client who has not been placed with anybody should not be paying a placement rate.',
    retainerCents: fromDollars(2_500),
    monthlyCents: fromDollars(500),
    successFeeBasisPoints: 0,
    minimumCents: fromDollars(2_500),
    committedMonths: 3,
  },
  {
    key: 'foundation',
    name: 'Foundation',
    rung: 2,
    description:
      'DRAFT PRICING. Readiness work plus placement into the first capital position, with ongoing stack monitoring.',
    retainerCents: fromDollars(5_000),
    monthlyCents: fromDollars(1_000),
    // 3% of the approved credit limit. Never of the requested one.
    successFeeBasisPoints: 300,
    minimumCents: fromDollars(8_000),
    committedMonths: 6,
  },
  {
    key: 'growth',
    name: 'Growth',
    rung: 3,
    description:
      'DRAFT PRICING. Multi-position capital stack construction, cost-of-capital management and quarterly review.',
    retainerCents: fromDollars(10_000),
    monthlyCents: fromDollars(2_000),
    successFeeBasisPoints: 350,
    minimumCents: fromDollars(22_000),
    committedMonths: 12,
  },
  {
    key: 'private_cfo',
    name: 'Private CFO',
    rung: 4,
    description:
      'DRAFT PRICING. The private-CFO-style engagement: continuous capital operations, lender relationship management and board-ready reporting.',
    retainerCents: fromDollars(20_000),
    monthlyCents: fromDollars(4_000),
    successFeeBasisPoints: 400,
    minimumCents: fromDollars(44_000),
    committedMonths: 12,
  },
  {
    key: 'portfolio',
    name: 'Portfolio',
    rung: 5,
    description:
      'DRAFT PRICING. Multi-entity portfolios and holding structures. Intended as annual prepay; the prepay accounting 1.4 owns is not modelled by this seed.',
    retainerCents: fromDollars(40_000),
    monthlyCents: fromDollars(7_500),
    successFeeBasisPoints: 450,
    minimumCents: fromDollars(90_000),
    committedMonths: 12,
  },
];

/**
 * Every figure I invented, so the owner knows exactly what to correct.
 *
 * Exported rather than left in a comment so a test can assert it covers the ladder - a list of
 * invented figures that silently stops matching the figures is worse than no list.
 */
export const LADDER_FIGURES_TO_CONFIRM: readonly string[] = [
  'All five retainers: $2,500 / $5,000 / $10,000 / $20,000 / $40,000.',
  'All five monthly fees: $500 / $1,000 / $2,000 / $4,000 / $7,500.',
  'All four success fee rates: 0 / 300 / 350 / 400 / 450 basis points (0% / 3% / 3.5% / 4% / 4.5%).',
  'All five engagement minimums: $2,500 / $8,000 / $22,000 / $44,000 / $90,000.',
  'All five committed terms: 3 / 6 / 12 / 12 / 12 months.',
  'The five rung names and keys: readiness, foundation, growth, private_cfo, portfolio.',
  'That there are five rungs at all - blueprint 1.4 says "5-offer ladder", which fixes the count but not the contents.',
  'That rung 1 carries no success fee. This is the one figure I would defend on principle rather than on price.',
  'That the success fee rises with the rung. An owner may want it FLAT across the ladder, or falling, and either is arguable.',
  'Whether rung 5 is annual-prepay only, and what discount that carries. Not modelled.',
];

export interface SeedLadderInput {
  readonly tenantId: string;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
  /**
   * Republish rungs that already exist.
   *
   * Off by default, which is what makes this idempotent: `publishOffer` supersedes the current
   * version and creates a new one on every call, so a seed that always published would walk the
   * whole ladder to version 2 on its second run and leave the owner's corrections superseded by
   * these drafts.
   */
  readonly republishExisting?: boolean;
}

export interface SeedLadderResult {
  readonly published: readonly OfferRecord[];
  /** Rungs already on record, left exactly as they were. */
  readonly skipped: readonly string[];
  readonly figuresToConfirm: readonly string[];
}

/**
 * Publish the draft ladder.
 *
 * Exported, idempotent, and never run on import. Skips any rung already on record, so an owner who
 * has corrected `foundation` keeps their correction when somebody re-runs this.
 */
export const seedOfferLadder = async (
  input: SeedLadderInput,
): Promise<Outcome<SeedLadderResult>> => {
  const published: OfferRecord[] = [];
  const skipped: string[] = [];

  for (const offer of OFFER_LADDER) {
    const existing = await currentOffer(input.tenantId, offer.key);
    if (existing.status === 'ok' && input.republishExisting !== true) {
      skipped.push(offer.key);
      continue;
    }

    const result = await publishOffer({
      tenantId: input.tenantId,
      key: offer.key,
      name: offer.name,
      rung: offer.rung,
      description: offer.description,
      retainerCents: offer.retainerCents,
      monthlyCents: offer.monthlyCents,
      successFeeBasisPoints: offer.successFeeBasisPoints,
      minimumCents: offer.minimumCents,
      committedMonths: offer.committedMonths,
      publishedBy: input.publishedBy,
      actor: input.actor,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    // A refusal is returned rather than collected and swallowed. A seed that published four rungs
    // and reported success would leave a ladder with a hole in it, and the hole would be invisible
    // in a caller that only checked the status.
    if (result.status !== 'ok') return result as Outcome<never>;
    published.push(result.value);
  }

  return {
    status: 'ok',
    value: { published, skipped, figuresToConfirm: LADDER_FIGURES_TO_CONFIRM },
  };
};
