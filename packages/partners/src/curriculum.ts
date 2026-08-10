/**
 * Curriculum and completion - blueprint 8.3.
 *
 * The material itself is not here. Blueprint 8.3 names SelfPublisherForge as the source of
 * curriculum content, and authoring training text inside a governance module would put the words a
 * partner is trained on in a place nobody publishes from. What this owns is the fact that a module
 * exists, what it is meant to teach, which tracks must complete it, and who completed what.
 *
 * **Completion is recorded against a module VERSION.** That is the whole mechanism behind
 * blueprint 8.3's "annual recertification with change delta training": a partner who completed v1
 * has not completed v2, so republishing a module with changed content decertifies everyone who
 * only ever saw the old one - without a job running and without anybody remembering to.
 *
 * It also means a typo fix would decertify the network, which is why `publishModule` takes a
 * `changeKind` the way 7.2 does. Same argument, same failure it prevents: a default chosen once is
 * inherited silently, and the silent inheritance is how a material rewrite ships as a typo fix.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { isPartnerTrack, type PartnerTrack } from './tracks.js';

/**
 * Whether republishing this module invalidates prior completions.
 *
 *   `material`   the content changed in a way a partner needs to see - prior completions no
 *                longer count toward certification
 *   `editorial`  wording, formatting, a broken link - prior completions carry forward
 */
export type ModuleChangeKind = 'material' | 'editorial';

/** Blueprint 8.3: "annual recertification". */
export const RECERTIFICATION_CADENCE_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CurriculumModule {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly objective: string;
  /** Empty means every track. */
  readonly requiredForTracks: readonly PartnerTrack[];
  readonly materialReference: string | null;
  readonly publishedAt: string;
  readonly supersededAt: string | null;
}

interface ModuleRow {
  id: string;
  key: string;
  version: number;
  title: string;
  objective: string;
  requiredForTracks: string[];
  materialReference: string | null;
  publishedAt: Date;
  supersededAt: Date | null;
}

const toModule = (row: ModuleRow): CurriculumModule => ({
  id: row.id,
  key: row.key,
  version: row.version,
  title: row.title,
  objective: row.objective,
  requiredForTracks: row.requiredForTracks.filter(isPartnerTrack),
  materialReference: row.materialReference,
  publishedAt: row.publishedAt.toISOString(),
  supersededAt: row.supersededAt?.toISOString() ?? null,
});

export interface PublishModuleInput {
  readonly tenantId: string;
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  /** Empty means every track must complete it. */
  readonly requiredForTracks?: readonly PartnerTrack[];
  readonly materialReference?: string;
  /**
   * Required, never defaulted. `material` invalidates prior completions; `editorial` carries them
   * forward. Version 1 cannot be editorial - there is nothing to carry forward from.
   */
  readonly changeKind: ModuleChangeKind;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Publish a module, superseding the previous version.
 *
 * An editorial republish COPIES FORWARD the completions recorded against the previous version, so
 * a partner who has seen the content is not asked to see it again because somebody fixed a typo.
 * A material republish does not - and every partner who completed the old version is decertified
 * on the next read, which is the intended behaviour and the reason `changeKind` is not optional.
 */
export const publishModule = async (
  input: PublishModuleInput,
): Promise<Outcome<CurriculumModule>> => {
  const now = input.now ?? new Date();

  if (input.objective.trim().length < 10) {
    return refused(
      `Module '${input.key}' needs an objective. A module nobody can state the point of cannot be assessed as complete or incomplete by a person.`,
      'Blueprint 8.3 - training curriculum',
    );
  }

  const current = await db().partnerCurriculumModule.findFirst({
    where: { tenantId: input.tenantId, key: input.key, supersededAt: null },
    orderBy: { version: 'desc' },
  });

  if (!current && input.changeKind === 'editorial') {
    return refused(
      `Module '${input.key}' has no previous version, so this publish cannot be editorial. An editorial change carries prior completions forward, and there are none.`,
      'Blueprint 8.3 - version 1 is never editorial',
    );
  }

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.partnerCurriculumModule.update({
        where: { id: current.id },
        data: { supersededAt: now },
      });
    }

    const created = await tx.partnerCurriculumModule.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        version: (current?.version ?? 0) + 1,
        title: input.title,
        objective: input.objective,
        requiredForTracks: [...(input.requiredForTracks ?? [])],
        materialReference: input.materialReference ?? null,
        publishedAt: now,
        publishedBy: input.publishedBy,
      },
    });

    if (current && input.changeKind === 'editorial') {
      const carried = await tx.partnerModuleCompletion.findMany({
        where: { tenantId: input.tenantId, moduleId: current.id },
      });
      if (carried.length > 0) {
        await tx.partnerModuleCompletion.createMany({
          data: carried.map((completion) => ({
            tenantId: completion.tenantId,
            partnerId: completion.partnerId,
            moduleId: created.id,
            // The ORIGINAL completion date carries forward, not today's. Stamping today would
            // reset every partner's recertification clock on an editorial fix - quietly extending
            // certifications by a year because somebody corrected a link.
            completedAt: completion.completedAt,
            recordedBy: completion.recordedBy,
          })),
        });
      }
    }

    return created;
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.module.published',
    actor: input.actor,
    payload: {
      moduleKey: input.key,
      version: row.version,
      changeKind: input.changeKind,
      requiredForTracks: [...(input.requiredForTracks ?? [])],
    },
  });

  return ok(toModule(row));
};

/** The live curriculum. Superseded versions are excluded; completions against them are not. */
export const currentCurriculum = async (tenantId: string): Promise<readonly CurriculumModule[]> => {
  const rows = await db().partnerCurriculumModule.findMany({
    where: { tenantId, supersededAt: null },
    orderBy: { key: 'asc' },
  });
  return rows.map(toModule);
};

/** The live modules a partner on this track must complete. */
export const requiredModulesFor = async (
  tenantId: string,
  track: PartnerTrack,
): Promise<readonly CurriculumModule[]> => {
  const modules = await currentCurriculum(tenantId);
  return modules.filter(
    (module) => module.requiredForTracks.length === 0 || module.requiredForTracks.includes(track),
  );
};

/**
 * Record that a partner completed a module.
 *
 * `recordedBy` is ours, not the partner's. Blueprint 8.3 makes certification a precondition for
 * referring, so self-attested completion would let a partner grant themselves the capability the
 * module exists to gate.
 *
 * `completedAt` may be backdated - training often happens before anybody records it - but not
 * into the future, because the recertification clock runs from it.
 */
export const recordCompletion = async (input: {
  tenantId: string;
  partnerId: string;
  moduleId: string;
  completedAt: Date;
  recordedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ completionId: string }>> => {
  const now = input.now ?? new Date();

  if (input.completedAt.getTime() > now.getTime()) {
    return refused(
      'A module completion cannot be dated in the future. The recertification clock runs from this date, so a future date would grant a certification that outlasts its own training.',
      'Blueprint 8.3 - annual recertification cadence',
    );
  }

  const module = await db().partnerCurriculumModule.findFirst({
    where: { tenantId: input.tenantId, id: input.moduleId },
  });
  if (!module) return noData(`No curriculum module ${input.moduleId} is on record.`);

  const row = await db().partnerModuleCompletion.upsert({
    where: { partnerId_moduleId: { partnerId: input.partnerId, moduleId: input.moduleId } },
    create: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      moduleId: input.moduleId,
      completedAt: input.completedAt,
      recordedBy: input.recordedBy,
    },
    update: { completedAt: input.completedAt, recordedBy: input.recordedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.module.completed',
    actor: input.actor,
    payload: {
      partnerId: input.partnerId,
      moduleKey: module.key,
      moduleVersion: module.version,
      completedAt: input.completedAt.toISOString(),
    },
  });

  return ok({ completionId: row.id });
};

export interface CompletionRecord {
  readonly moduleId: string;
  readonly completedAt: Date;
}

export const completionsFor = async (
  tenantId: string,
  partnerId: string,
): Promise<readonly CompletionRecord[]> => {
  const rows = await db().partnerModuleCompletion.findMany({
    where: { tenantId, partnerId },
  });
  return rows.map((row) => ({ moduleId: row.moduleId, completedAt: row.completedAt }));
};

/** When a completion falls due for recertification. */
export const recertificationDueAt = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + RECERTIFICATION_CADENCE_DAYS * DAY_MS);
