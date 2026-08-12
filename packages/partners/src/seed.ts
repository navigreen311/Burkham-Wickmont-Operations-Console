/**
 * The partner curriculum, as a DRAFT for the owner to correct.
 *
 * **What is invented here is what this firm REQUIRES of a partner**, which is a policy decision and
 * not mine. `CURRICULUM_REQUIREMENTS_TO_CONFIRM` lists every one. What is not invented is the set of
 * topics: blueprint 8.3 names them - approved claims, prohibited claims, client suitability, data
 * privacy, referral disclosure - and this file publishes exactly those five and adds one.
 *
 * **Why the absence matters today.** `certificationStanding` returns `no_curriculum` when nothing is
 * published, and `no_curriculum` is deliberately NOT certified - "nothing to complete" and
 * "completed everything" both produce an empty outstanding list, and treating them alike would
 * certify the whole network the moment a tenant forgot to publish. `canRefer` then refuses on the
 * training gate. So with no curriculum, **no partner can be certified and therefore no partner can
 * refer at all.** This file unblocks that. It does not make the requirements right.
 *
 * ---
 *
 * **Three things about `publishModule` shaped how this is authored.**
 *
 * **Completion is recorded against a module VERSION**, so republishing materially decertifies
 * everyone who only saw the old version. That is the mechanism behind 8.3's "annual recertification
 * with change delta training", and it means a seed that republished on every run would decertify the
 * entire network on its second run. `seedCurriculum` skips any module already on record.
 *
 * **An editorial republish carries prior completions forward keeping their ORIGINAL dates.** So a
 * typo fix does not reset anybody's recertification clock - and equally, an editorial republish
 * cannot be used to quietly extend it. Nothing in this seed publishes editorially; version 1 cannot
 * be editorial anyway, because there is nothing to carry forward from.
 *
 * **`requiredForTracks: []` means EVERY track.** That is why the five blueprint topics are published
 * with an empty list rather than with all seven names enumerated: enumerating them means a track
 * added later silently escapes the requirement, and the empty list means it does not.
 *
 * ---
 *
 * **On `disclosureSensitivity`: this file does not set one, and that is deliberate.**
 * `PublishModuleInput` has no such field - sensitivity is a property of the TRACK, already recorded
 * in `TRACK_REQUIREMENTS` with a cited basis (AICPA independence, Model Rule 7.2, SEC solicitation
 * rules). Asserting a fresh sensitivity on a module would be a second, uncited source for a fact
 * that already has a cited one. The one track-scoped module below is scoped by reading the tracks
 * that already carry `disclosureSensitivity: 'high'`, so it inherits their citations rather than
 * inventing a basis.
 *
 * No score, no ranking, no average. Certification is categorical - a partner is certified or is
 * not, and `certificationStanding` says which module is outstanding rather than how close they are.
 */

import { publishModule, currentCurriculum, type CurriculumModule } from './curriculum.js';
import { PARTNER_TRACKS, TRACK_REQUIREMENTS, type PartnerTrack } from './tracks.js';
import type { EventActor, Outcome } from '@bwc/core';

interface SeedModule {
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  /** Omitted means every track, which is what an empty list means to `publishModule`. */
  readonly requiredForTracks?: readonly PartnerTrack[];
  readonly materialReference?: string;
}

/**
 * Tracks whose own licensing body constrains what they may say about a referral fee.
 *
 * Derived from `TRACK_REQUIREMENTS` rather than listed, so a track whose sensitivity is corrected
 * later moves in and out of the scoped module without this file being edited. The basis for each is
 * already recorded and cited on the track.
 */
export const HIGH_SENSITIVITY_TRACKS: readonly PartnerTrack[] = PARTNER_TRACKS.filter(
  (track) => TRACK_REQUIREMENTS[track].disclosureSensitivity === 'high',
);

/**
 * Six modules: blueprint 8.3's five, plus one scoped to the regulated professions.
 *
 * The objectives say what a partner must be able to DO afterwards, because
 * `certificationStanding` shows the objective to the partner as the thing outstanding - and "read
 * the data privacy module" is not something anybody can tell they have finished.
 *
 * `materialReference` points at SelfPublisherForge keys that DO NOT EXIST YET. Blueprint 8.3 names
 * SelfPublisherForge as the curriculum source and this module deliberately does not hold training
 * text - so these are the names the material should be published under, not evidence that it has
 * been. A partner cannot actually complete any of this until somebody writes the material.
 */
export const CURRICULUM_SEEDS: readonly SeedModule[] = [
  {
    key: 'approved_claims',
    title: 'Approved claims: what you may say about Burkham Wickmont',
    objective:
      'DRAFT. Reproduce, from memory, the approved description of what this firm does, and state why "we get you funded" is not one of them. Blueprint 8.3 integrates this with the Marketing Claim Library, which is the authority on the wording.',
    materialReference: 'spf/partner-training/approved-claims (NOT YET AUTHORED)',
  },
  {
    key: 'prohibited_claims',
    title: 'Prohibited claims: guarantees, credit repair, and rate promises',
    objective:
      'DRAFT. Identify a prohibited claim in a written or spoken exchange and say what to substitute. Covers guaranteed approval, promised credit repair, describing a card as a loan, and quoting a rate before a provider has offered one - each of which is on the Level 4 prohibited-action list and is never permitted by any approval.',
    materialReference: 'spf/partner-training/prohibited-claims (NOT YET AUTHORED)',
  },
  {
    key: 'client_suitability',
    title: 'Client suitability: who this service is and is not for',
    objective:
      'DRAFT. Decide whether a prospect is a plausible fit before introducing them, and state the two or three facts that would make them unsuitable. Introducing an unsuitable client costs them a hard credit pull and costs the partner their standing.',
    materialReference: 'spf/partner-training/client-suitability (NOT YET AUTHORED)',
  },
  {
    key: 'data_privacy',
    title: 'Data privacy: what you may collect, hold and send',
    objective:
      'DRAFT. State what a partner must never collect or forward - SSN, EIN, bank credentials, statements - and describe the correct route for a client who tries to hand it over anyway. This firm field-level encrypts those and keeps them out of logs and events; a partner emailing a statement defeats all of it.',
    materialReference: 'spf/partner-training/data-privacy (NOT YET AUTHORED)',
  },
  {
    key: 'referral_disclosure',
    title: 'Referral disclosure: telling the client you are paid',
    objective:
      "DRAFT. State, in the partner's own words, that they receive a fee and when the client is told. A referral fee is payable only where the state permits it and the disclosure conditions on the rule are met, so what the partner says to the client is part of what makes the fee lawful.",
    materialReference: 'spf/partner-training/referral-disclosure (NOT YET AUTHORED)',
  },
  {
    key: 'professional_independence',
    title: 'Professional independence: your licensing body, not ours',
    objective:
      'DRAFT. For a partner whose own professional body constrains referral-fee arrangements, state what their body requires of them and confirm they have taken their own advice on it. This firm does not decide that question for them - the basis for treating these tracks differently is recorded on each track in TRACK_REQUIREMENTS, with its citation.',
    // Scoped by reading the tracks that already carry a cited high sensitivity. Not by asserting
    // a new one here.
    requiredForTracks: HIGH_SENSITIVITY_TRACKS,
    materialReference: 'spf/partner-training/professional-independence (NOT YET AUTHORED)',
  },
];

/**
 * Every requirement I invented, so the owner knows exactly what to correct.
 *
 * Exported so a test can assert it stays in step with the seeds.
 */
export const CURRICULUM_REQUIREMENTS_TO_CONFIRM: readonly string[] = [
  'That five of the six modules are required of EVERY track. An owner may want data privacy universal but suitability scoped, and that is arguable.',
  'The sixth module, professional_independence, and that it is scoped to the four tracks carrying disclosureSensitivity high (cpa_bookkeeper, business_attorney, wealth_advisor, ma_advisor). The scoping is derived from existing cited bases; whether a separate module is the right response to them is a policy call.',
  "Every objective. These are my wording for what a partner must be able to do, not the firm's.",
  'That there is no assessment or pass mark. Completion is recorded by whoever records it; nothing here defines what "completed" means in substance.',
  'That recertification is annual (RECERTIFICATION_CADENCE_DAYS = 365, already in the code as blueprint 8.3 states it) and that an owner may only TIGHTEN it - 11.7 registers the cadence as a ceiling.',
  'Every materialReference. The SelfPublisherForge keys are names I chose for material that does not exist. NO PARTNER CAN ACTUALLY COMPLETE ANY OF THIS until the material is written.',
  'Whether a seventh module is needed for co-brand and white-label partners specifically - blueprint 8.3 gates "refer / co-brand / white-label" on completion, and this curriculum does not distinguish the three.',
];

export interface SeedCurriculumInput {
  readonly tenantId: string;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
  /**
   * Republish modules that already exist, as MATERIAL changes.
   *
   * Off by default, and the default is the important part: a material republish decertifies every
   * partner who completed the previous version. A seed that republished on every run would
   * decertify the whole network the second time somebody ran it, which is a worse outcome than the
   * empty curriculum this file exists to fix.
   */
  readonly republishExisting?: boolean;
}

export interface SeedCurriculumResult {
  readonly published: readonly CurriculumModule[];
  /** Modules already on record, left exactly as they were, completions intact. */
  readonly skipped: readonly string[];
  readonly requirementsToConfirm: readonly string[];
}

/**
 * Publish the draft curriculum.
 *
 * Exported, idempotent, and never run on import.
 */
export const seedCurriculum = async (
  input: SeedCurriculumInput,
): Promise<Outcome<SeedCurriculumResult>> => {
  const existing = await currentCurriculum(input.tenantId);
  const onRecord = new Set(existing.map((module) => module.key));

  const published: CurriculumModule[] = [];
  const skipped: string[] = [];

  for (const seed of CURRICULUM_SEEDS) {
    if (onRecord.has(seed.key) && input.republishExisting !== true) {
      skipped.push(seed.key);
      continue;
    }

    const result = await publishModule({
      tenantId: input.tenantId,
      key: seed.key,
      title: seed.title,
      objective: seed.objective,
      // Always material. Version 1 cannot be editorial, and a republish of training content that
      // changed is exactly what should reset completions.
      changeKind: 'material',
      ...(seed.requiredForTracks !== undefined
        ? { requiredForTracks: seed.requiredForTracks }
        : {}),
      ...(seed.materialReference !== undefined
        ? { materialReference: seed.materialReference }
        : {}),
      publishedBy: input.publishedBy,
      actor: input.actor,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    // Returned rather than swallowed: a curriculum missing one module certifies nobody, and the
    // gap would be invisible to a caller that only read the status.
    if (result.status !== 'ok') return result as Outcome<never>;
    published.push(result.value);
  }

  return {
    status: 'ok',
    value: { published, skipped, requirementsToConfirm: CURRICULUM_REQUIREMENTS_TO_CONFIRM },
  };
};
