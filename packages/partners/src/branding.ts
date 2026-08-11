/**
 * Co-brand and white-label arrangements - blueprint 8.1's "co-brand configurations,
 * white-label configurations, brand-usage rules".
 *
 * Two things happen here and only one of them is configuration.
 *
 * The configuration is a record: which partner, which arrangement, what name they present under,
 * on what surface, subject to which rules. The **provisioning** of an actual co-branded workspace
 * is reported as `not_built` - no hosting surface exists, and a function that returned `ok` for
 * work nothing performed would put "the partner has a co-branded portal" into a record where it
 * is false.
 *
 * The part that is not configuration is `reviewBrandMaterial`. Text a partner puts our name on is
 * client-facing content, so it goes through the Communication Compliance Scanner (4.2) exactly
 * like anything we write ourselves. A partner is the most likely party in this system to promise
 * something we would never promise - they are compensated per referral, they are not employed by
 * us, and under a white label the client may not know we exist. Exempting their material from the
 * scanner because they wrote it would exempt precisely the highest-risk text in the system.
 *
 * White label carries a stricter rule than co-brand, and it is worth saying why. Under a co-brand
 * the client sees both names and can ask either party what is going on. Under a white label the
 * client may believe they are dealing only with their accountant, so the disclosure obligations
 * that attach to what we do still attach - and the only party who can carry them is the partner.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { scanForTenant } from '@bwc/scanner';
import { notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findPartner } from './partners.js';
import { requireCertification } from './certification.js';

export type BrandArrangement = 'co_brand' | 'white_label';

/**
 * Rules every arrangement carries, whatever else is agreed.
 *
 * Stated as data so a brand-usage review has something concrete to check against. A rule nobody
 * wrote down is a rule nobody can be found to have broken.
 */
export const BASE_BRAND_RULES: readonly string[] = [
  'Only claims the partner is approved for in the Marketing Claim Library may be used.',
  'No statement about approval, funding amount, or timing may be made on our behalf.',
  'Any material carrying our name is subject to Communication Compliance Scanner review before use.',
  'The arrangement ends when the partner is suspended, terminated, or loses certification.',
];

export const WHITE_LABEL_RULES: readonly string[] = [
  'The client must be told, in writing, that capital advisory services are performed by a third party.',
  'Disclosures required in the client’s state attach to the service, not to the name on the door, and the partner must carry them.',
];

export const rulesFor = (arrangement: BrandArrangement): readonly string[] =>
  arrangement === 'white_label'
    ? [...BASE_BRAND_RULES, ...WHITE_LABEL_RULES]
    : [...BASE_BRAND_RULES];

export interface BrandConfig {
  readonly id: string;
  readonly partnerId: string;
  readonly arrangement: BrandArrangement;
  readonly presentedName: string;
  readonly surface: string;
  readonly brandRules: readonly string[];
  readonly approvedAt: string;
  readonly revokedAt: string | null;
}

interface BrandRow {
  id: string;
  partnerId: string;
  arrangement: string;
  presentedName: string;
  surface: string;
  brandRules: string[];
  approvedAt: Date;
  revokedAt: Date | null;
}

const toConfig = (row: BrandRow): BrandConfig => ({
  id: row.id,
  partnerId: row.partnerId,
  arrangement: row.arrangement as BrandArrangement,
  presentedName: row.presentedName,
  surface: row.surface,
  brandRules: row.brandRules,
  approvedAt: row.approvedAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

/**
 * Approve an arrangement.
 *
 * Gated on certification, per blueprint 8.3, and on the partner being active. The certification
 * check uses the capability that matches the arrangement rather than a generic one, so the refusal
 * a partner reads says what they cannot do.
 */
export const approveBrandArrangement = async (input: {
  tenantId: string;
  partnerId: string;
  arrangement: BrandArrangement;
  presentedName: string;
  surface: string;
  additionalRules?: readonly string[];
  approvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<BrandConfig>> => {
  const now = input.now ?? new Date();

  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  if (!partner.value.engageable) {
    return refused(
      `This partner is ${partner.value.status}. A brand arrangement puts our name in their hands, and that is not something a suspended relationship should carry.`,
      'Blueprint 8.1 - co-brand and white-label configurations',
    );
  }

  const certified = await requireCertification(
    input.tenantId,
    input.partnerId,
    partner.value.track,
    input.arrangement === 'white_label' ? 'white_label' : 'co_brand',
    now,
  );
  if (certified.status !== 'ok') return certified;

  if (input.presentedName.trim() === '' || input.surface.trim() === '') {
    return refused(
      'A brand arrangement needs a presented name and a surface. An arrangement with no stated scope cannot be reviewed and cannot be enforced.',
      'Blueprint 8.1 - brand-usage rules',
    );
  }

  const row = await db().partnerBrandConfig.create({
    data: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      arrangement: input.arrangement as never,
      presentedName: input.presentedName,
      surface: input.surface,
      brandRules: [...rulesFor(input.arrangement), ...(input.additionalRules ?? [])],
      approvedAt: now,
      approvedBy: input.approvedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.brand.approved',
    actor: input.actor,
    payload: {
      partnerId: input.partnerId,
      arrangement: input.arrangement,
      surface: input.surface,
      configId: row.id,
    },
  });

  return ok(toConfig(row));
};

export const revokeBrandArrangement = async (input: {
  tenantId: string;
  configId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ configId: string }>> => {
  const now = input.now ?? new Date();

  const existing = await db().partnerBrandConfig.findFirst({
    where: { tenantId: input.tenantId, id: input.configId, revokedAt: null },
  });
  if (!existing) {
    return refused(
      'No active brand arrangement with that id.',
      'Blueprint 8.1 - co-brand and white-label configurations',
    );
  }

  await db().partnerBrandConfig.update({
    where: { id: existing.id },
    data: { revokedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.brand.revoked',
    actor: input.actor,
    payload: { partnerId: existing.partnerId, configId: existing.id, reason: input.reason },
  });

  return ok({ configId: existing.id });
};

/**
 * Live arrangements for a partner.
 *
 * Certification is checked here rather than trusted from approval time, because a partner whose
 * training lapsed after their co-brand was approved is exactly the case this gate exists for -
 * and the arrangement is a standing capability, not a one-off act.
 */
export const activeArrangementsFor = async (
  tenantId: string,
  partnerId: string,
  now: Date = new Date(),
): Promise<Outcome<readonly BrandConfig[]>> => {
  const partner = await findPartner(tenantId, partnerId);
  if (partner.status !== 'ok') return partner;

  const rows = await db().partnerBrandConfig.findMany({
    where: { tenantId, partnerId, revokedAt: null },
    orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
  });

  if (rows.length === 0) return ok([]);

  const certified = await requireCertification(
    tenantId,
    partnerId,
    partner.value.track,
    'co_brand',
    now,
  );
  if (certified.status !== 'ok') return certified;

  if (!partner.value.engageable) {
    return refused(
      `This partner is ${partner.value.status}, so their brand arrangements are not in force.`,
      'Blueprint 8.1 - the arrangement ends when the partner is suspended or terminated',
    );
  }

  return ok(rows.map(toConfig));
};

export interface BrandMaterialReview {
  readonly permitted: boolean;
  readonly findings: readonly string[];
  readonly requiredDisclosures: readonly string[];
  readonly detail: string;
}

/**
 * Review partner-authored material that carries our name.
 *
 * Runs 4.2's scanner. The scanner refuses against an empty library rather than certifying clean,
 * so a tenant reviewing partner material must have the Claim Library seeded - the same condition
 * the Communications Hub carries, and the same reason: a scan that checked nothing is not a pass.
 *
 * The disclosure check is stricter than the send path's. There, a required disclosure that the
 * content already carries lets the message through. Here the disclosure has to be present too, and
 * the material is refused if it is not - because we do not control what the partner adds after we
 * approve it, so "they will attach it" is a hope rather than a control.
 */
export const reviewBrandMaterial = async (input: {
  tenantId: string;
  partnerId: string;
  text: string;
  jurisdiction?: string;
  actor: EventActor;
}): Promise<Outcome<BrandMaterialReview>> => {
  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  const scan = await scanForTenant({
    tenantId: input.tenantId,
    text: input.text,
    actor: input.actor,
    context: `partner brand material (${partner.value.legalName})`,
    ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
  });

  if (scan.status !== 'ok') return scan as Outcome<never>;

  if (scan.value.verdict === 'blocked') {
    return refused(
      `Partner material contains language the Marketing Claim Library bans: ${scan.value.findings
        .map((finding) => `'${finding.phrase}'`)
        .join(', ')}. It cannot carry our name.`,
      'Blueprint 4.2 with 8.1 - partner material is client-facing content',
    );
  }

  const missing = scan.value.requiredDisclosures.filter(
    (disclosure) => !input.text.includes(disclosure),
  );

  if (missing.length > 0) {
    return refused(
      `Partner material uses language that requires disclosure, and the disclosure is not in the material: ${missing.join(' | ')}. We cannot rely on the partner attaching it afterwards.`,
      'Blueprint 7.4 with 8.1 - a required disclosure travels with the claim',
    );
  }

  return ok({
    permitted: true,
    findings: scan.value.findings.map((finding) => finding.phrase),
    requiredDisclosures: scan.value.requiredDisclosures,
    detail: `Checked against ${scan.value.libraryEntriesChecked} library entries.`,
  });
};

/**
 * Provision the workspace an approved arrangement describes.
 *
 * `not_built`, and it will stay that way until a hosting surface exists. The configuration is
 * real; the portal is not. Returning `ok` here would put "this partner has a co-branded workspace"
 * into a record where nothing had been built.
 */
export const provisionWorkspace = async (
  configId: string,
): Promise<Outcome<{ configId: string }>> =>
  notBuilt(
    '8.1 co-brand / white-label workspace provisioning',
    `Brand arrangement ${configId} is recorded and its rules are in force, but no workspace hosting surface exists in the Console, so nothing has been provisioned.`,
  );
