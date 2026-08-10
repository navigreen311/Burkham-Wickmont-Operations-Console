/**
 * Certification standing, and the gate everything in 8.1 goes through - blueprint 8.3.
 *
 * "Required completion before partner can refer / co-brand / white-label" is the strongest
 * sentence in Category 8, and it is a gate rather than a report. So it is computed in one place
 * and called by every capability, rather than each capability deciding for itself.
 *
 * **Derived at read time**, like every standing in this codebase. A stored `certified` flag would
 * need a job to expire it, and a job that stops leaves every partner reading as certified - the
 * reassuring failure, in a module whose whole point is that an untrained partner does not speak
 * for us.
 *
 * **A lapsed certification REMOVES THE CAPABILITY** rather than flagging it. ADR-0013's rule
 * applied a third time: staleness moves toward whichever answer is safe if the stale record is
 * wrong. Here the stale record is "this partner knows what they may claim", and if it is wrong the
 * harm is a false statement made to a prospective client in our name. That points the same way as
 * 5.4's provider approval and the opposite way from 6.4's Do Not Fund listing - which is what the
 * rule predicts, since the direction of harm is what differs.
 */

import { ok, refused, type Outcome } from '@bwc/core';
import type { PartnerTrack } from './tracks.js';
import {
  RECERTIFICATION_CADENCE_DAYS,
  completionsFor,
  recertificationDueAt,
  requiredModulesFor,
  type CurriculumModule,
} from './curriculum.js';

/**
 * Why a partner is not certified, when they are not.
 *
 *   `certified`         every required module completed, none lapsed
 *   `never_completed`   modules outstanding that were never completed
 *   `lapsed`            completed, but past the recertification cadence
 *   `superseded`        the module was materially republished after they completed it
 *   `no_curriculum`     nothing has been published to certify against
 */
export type CertificationState =
  'certified' | 'never_completed' | 'lapsed' | 'superseded' | 'no_curriculum';

export interface ModuleStanding {
  readonly moduleKey: string;
  readonly moduleTitle: string;
  readonly completedAt: string | null;
  readonly dueAt: string | null;
  readonly lapsed: boolean;
}

export interface CertificationStanding {
  readonly state: CertificationState;
  readonly certified: boolean;
  /** Module by module, so a partner is told what to do rather than that they failed. */
  readonly modules: readonly ModuleStanding[];
  readonly outstanding: readonly string[];
  readonly lapsedModules: readonly string[];
  /** The earliest recertification date across completed modules, or `null`. */
  readonly nextDueAt: string | null;
  readonly explanation: string;
}

/**
 * Compute standing. Pure, given the curriculum and the completions.
 *
 * Exported separately from the database read so the rule can be tested exhaustively without
 * fixtures - and so a reader can see that nothing here consults anything else.
 */
export const deriveStanding = (
  required: readonly CurriculumModule[],
  completions: ReadonlyMap<string, Date>,
  now: Date,
): CertificationStanding => {
  if (required.length === 0) {
    return {
      // Not certified. "Nothing to complete" and "completed everything" both produce an empty
      // outstanding list, and treating them alike would certify the entire network the moment a
      // tenant forgot to publish a curriculum. The scanner makes the same call about an empty
      // claim library, for the same reason.
      state: 'no_curriculum',
      certified: false,
      modules: [],
      outstanding: [],
      lapsedModules: [],
      nextDueAt: null,
      explanation:
        'No curriculum has been published for this track, so there is nothing to certify against. A partner cannot be certified by the absence of a requirement.',
    };
  }

  const modules: ModuleStanding[] = required.map((module) => {
    const completedAt = completions.get(module.id) ?? null;
    const dueAt = completedAt === null ? null : recertificationDueAt(completedAt);
    return {
      moduleKey: module.key,
      moduleTitle: module.title,
      completedAt: completedAt?.toISOString() ?? null,
      dueAt: dueAt?.toISOString() ?? null,
      lapsed: dueAt !== null && now.getTime() > dueAt.getTime(),
    };
  });

  const outstanding = modules.filter((m) => m.completedAt === null).map((m) => m.moduleKey);
  const lapsedModules = modules.filter((m) => m.lapsed).map((m) => m.moduleKey);

  const dueDates = modules
    .filter((m) => m.dueAt !== null)
    .map((m) => m.dueAt as string)
    .sort();
  const nextDueAt = dueDates[0] ?? null;

  if (outstanding.length > 0) {
    // A partner who completed a module against a version that has since been materially
    // republished shows up here too, because the completion was recorded against the old module
    // id and the new one is what is now required. `superseded` distinguishes the case where
    // EVERY outstanding module has a completed predecessor - the partner did the training, and
    // what they need is the delta rather than the course.
    const everyOutstandingWasOnceDone =
      outstanding.length === modules.length && completions.size > 0;
    return {
      state: everyOutstandingWasOnceDone ? 'superseded' : 'never_completed',
      certified: false,
      modules,
      outstanding,
      lapsedModules,
      nextDueAt,
      explanation: everyOutstandingWasOnceDone
        ? `Every required module has been materially republished since this partner completed it. They need the change-delta training for: ${outstanding.join(', ')}.`
        : `Outstanding module(s): ${outstanding.join(', ')}.`,
    };
  }

  if (lapsedModules.length > 0) {
    return {
      state: 'lapsed',
      certified: false,
      modules,
      outstanding,
      lapsedModules,
      nextDueAt,
      explanation: `Recertification is overdue for: ${lapsedModules.join(', ')}. Certification lapses ${RECERTIFICATION_CADENCE_DAYS} days after completion and the capabilities it gates stop with it.`,
    };
  }

  return {
    state: 'certified',
    certified: true,
    modules,
    outstanding,
    lapsedModules,
    nextDueAt,
    explanation: `All ${modules.length} required module(s) complete. Next recertification due ${nextDueAt?.slice(0, 10) ?? 'unknown'}.`,
  };
};

export const standingFor = async (
  tenantId: string,
  partnerId: string,
  track: PartnerTrack,
  now: Date = new Date(),
): Promise<CertificationStanding> => {
  const [required, completions] = await Promise.all([
    requiredModulesFor(tenantId, track),
    completionsFor(tenantId, partnerId),
  ]);

  return deriveStanding(
    required,
    new Map(completions.map((completion) => [completion.moduleId, completion.completedAt])),
    now,
  );
};

/** The capabilities blueprint 8.3 gates on certification. */
export type GatedCapability = 'refer' | 'co_brand' | 'white_label';

export const GATED_CAPABILITIES: readonly GatedCapability[] = ['refer', 'co_brand', 'white_label'];

const CAPABILITY_LABEL: Record<GatedCapability, string> = {
  refer: 'refer a client',
  co_brand: 'operate a co-brand arrangement',
  white_label: 'operate a white-label arrangement',
};

/**
 * The gate.
 *
 * Returns the standing on success so a caller has the recertification date without a second read -
 * and so the value a caller passes around is one that was actually checked, rather than a boolean
 * they could have made up.
 */
export const requireCertification = async (
  tenantId: string,
  partnerId: string,
  track: PartnerTrack,
  capability: GatedCapability,
  now: Date = new Date(),
): Promise<Outcome<CertificationStanding>> => {
  const standing = await standingFor(tenantId, partnerId, track, now);

  if (!standing.certified) {
    return refused(
      `This partner is not certified and cannot ${CAPABILITY_LABEL[capability]}. ${standing.explanation}`,
      'Blueprint 8.3 - required completion before a partner can refer, co-brand or white-label',
    );
  }

  return ok(standing);
};
