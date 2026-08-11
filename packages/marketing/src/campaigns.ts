/**
 * Campaigns and the asset library - blueprint 4.5.
 *
 * Two things worth knowing before reading.
 *
 * **This module does not write attribution.** Blueprint 4.5 lists "channel attribution feeds to
 * Sales Motion", and the feed runs one way: a campaign owns a `sourceChannel` VALUE, and whoever
 * creates a lead passes it to 1.3. 1.3's attribution columns are written once with no update path,
 * because a referral fee is owed on them - and a marketing module able to rewrite them would undo
 * the property 1.3 was built around. `channelFor` hands out the value; nothing here writes a lead.
 *
 * For the same reason a campaign's `sourceChannel` is fixed at creation. Renaming it would leave
 * every lead already attributed to the old value pointing at nothing, and a channel report would
 * quietly split one campaign in two.
 *
 * **A campaign cannot activate into a state we are not activated in.** Marketing into a state is
 * the same regulatory exposure as serving a client there - arguably earlier, since the marketing
 * is what brings them. 7.2 already knows which states are live, so this asks rather than keeping
 * its own list.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { activeStates } from '@bwc/regulatory';
import { scanForTenant } from '@bwc/scanner';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';
export type AssetState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'retired';

export interface CampaignRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly sourceChannel: string;
  readonly jurisdictions: readonly string[];
  readonly startedAt: string | null;
}

interface CampaignRow {
  id: string;
  key: string;
  name: string;
  status: string;
  sourceChannel: string;
  jurisdictions: string[];
  startedAt: Date | null;
}

const toCampaign = (row: CampaignRow): CampaignRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  status: row.status as CampaignStatus,
  sourceChannel: row.sourceChannel,
  jurisdictions: row.jurisdictions,
  startedAt: row.startedAt?.toISOString() ?? null,
});

export const createCampaign = async (input: {
  tenantId: string;
  key: string;
  name: string;
  sourceChannel: string;
  jurisdictions: readonly string[];
  createdBy: string;
  actor: EventActor;
}): Promise<Outcome<CampaignRecord>> => {
  if (input.sourceChannel.trim() === '') {
    return refused(
      'A campaign needs a source channel. It is the value 1.3 records on every lead it produces, and 1.3 refuses a default such as "unknown" because it is indistinguishable from a real answer in a channel report.',
      'Blueprint 4.5 with 1.3 - channel attribution feeds to Sales Motion',
    );
  }
  if (input.jurisdictions.length === 0) {
    return refused(
      'A campaign needs at least one jurisdiction. Marketing into a state is the same regulatory exposure as serving a client there, and a campaign with no stated states cannot be checked against 7.2.',
      'Blueprint 4.5 with 7.2 - state-by-state regulatory engine',
    );
  }

  const row = await db().campaign.create({
    data: {
      tenantId: input.tenantId,
      key: input.key,
      name: input.name,
      sourceChannel: input.sourceChannel,
      jurisdictions: input.jurisdictions.map((state) => state.trim().toUpperCase()),
      createdBy: input.createdBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.campaign.created',
    actor: input.actor,
    payload: {
      campaignId: row.id,
      key: input.key,
      sourceChannel: input.sourceChannel,
      jurisdictions: row.jurisdictions,
    },
  });

  return ok(toCampaign(row));
};

/**
 * Activate a campaign.
 *
 * Every jurisdiction it names must be active in 7.2. The refusal names which are not, because
 * "one of your five states is not live" sends somebody to check all five.
 */
export const activateCampaign = async (input: {
  tenantId: string;
  campaignId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<CampaignRecord>> => {
  const now = input.now ?? new Date();

  const campaign = await db().campaign.findFirst({
    where: { tenantId: input.tenantId, id: input.campaignId },
  });
  if (!campaign) return noData(`No campaign ${input.campaignId} is on record.`);

  const live = await activeStates(input.tenantId);
  const notLive = campaign.jurisdictions.filter((state) => !live.includes(state));

  if (notLive.length > 0) {
    return refused(
      `This campaign targets ${notLive.join(', ')}, which ${notLive.length === 1 ? 'is not an activated state' : 'are not activated states'}. Marketing into a state we cannot serve brings us clients we would have to turn away after they applied.`,
      'Blueprint 4.5 with 7.2 - a state activates only on documented counsel review',
    );
  }

  const row = await db().campaign.update({
    where: { id: campaign.id },
    data: { status: 'active', startedAt: campaign.startedAt ?? now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.campaign.activated',
    actor: input.actor,
    payload: { campaignId: campaign.id, jurisdictions: campaign.jurisdictions },
  });

  return ok(toCampaign(row));
};

/**
 * The channel value to record on a lead from this campaign.
 *
 * The whole of the "feeds to Sales Motion" arrow. A caller passes this to `createLead` as
 * `sourceChannel`; nothing here writes a lead, because 1.3 owns that and owns it write-once.
 */
export const channelFor = async (
  tenantId: string,
  campaignKey: string,
): Promise<Outcome<{ sourceChannel: string; campaignId: string }>> => {
  const row = await db().campaign.findFirst({ where: { tenantId, key: campaignKey } });
  if (!row) return noData(`No campaign '${campaignKey}' is on record.`);
  if (row.status !== 'active') {
    return refused(
      `Campaign '${campaignKey}' is ${row.status}. Attributing a lead to a campaign that is not running would put a channel in a report that was not spending.`,
      'Blueprint 4.5 - channel attribution feeds to Sales Motion',
    );
  }
  return ok({ sourceChannel: row.sourceChannel, campaignId: row.id });
};

export interface AssetRecord {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly state: AssetState;
  readonly body: string;
  readonly rejectionReason: string | null;
}

interface AssetRow {
  id: string;
  key: string;
  kind: string;
  state: string;
  body: string;
  rejectionReason: string | null;
}

const toAsset = (row: AssetRow): AssetRecord => ({
  id: row.id,
  key: row.key,
  kind: row.kind,
  state: row.state as AssetState,
  body: row.body,
  rejectionReason: row.rejectionReason,
});

export const createAsset = async (input: {
  tenantId: string;
  campaignId?: string;
  key: string;
  kind: string;
  body: string;
  sourceReference?: string;
  createdBy: string;
  actor: EventActor;
}): Promise<Outcome<AssetRecord>> => {
  if (input.body.trim() === '') {
    return refused(
      'An asset needs a body. An empty one would pass every scan it is ever put through.',
      'Blueprint 4.5 - asset library',
    );
  }

  const row = await db().marketingAsset.create({
    data: {
      tenantId: input.tenantId,
      campaignId: input.campaignId ?? null,
      key: input.key,
      kind: input.kind,
      body: input.body,
      sourceReference: input.sourceReference ?? null,
      createdBy: input.createdBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.asset.created',
    actor: input.actor,
    payload: {
      assetId: row.id,
      key: input.key,
      kind: input.kind,
      sourceReference: input.sourceReference ?? null,
    },
  });

  return ok(toAsset(row));
};

/**
 * Submit an asset for review, scanning it on the way in.
 *
 * Blueprint 4.5 calls this module a "governance layer over content produced via SelfPublisherForge
 * / AnimaForge / VideoEditForge cascades". Content produced by a cascade is exactly the content
 * nobody read before it arrived, so the scan happens at the boundary rather than being left to the
 * reviewer to remember.
 *
 * A blocked asset goes to `rejected` with the reason, not back to `draft`. Draft is where somebody
 * is still writing; rejected is a decision, and losing that distinction means the same banned
 * phrase gets resubmitted by whoever picks the file up next.
 */
export const submitAssetForReview = async (input: {
  tenantId: string;
  assetId: string;
  jurisdiction?: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<AssetRecord>> => {
  const now = input.now ?? new Date();

  const asset = await db().marketingAsset.findFirst({
    where: { tenantId: input.tenantId, id: input.assetId },
  });
  if (!asset) return noData(`No asset ${input.assetId} is on record.`);

  const scan = await scanForTenant({
    tenantId: input.tenantId,
    text: asset.body,
    actor: input.actor,
    context: `marketing asset ${asset.key}`,
    ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
  });
  if (scan.status !== 'ok') return scan as Outcome<never>;

  if (scan.value.verdict === 'blocked') {
    const reason = `Contains language the Marketing Claim Library bans: ${scan.value.findings
      .map((finding) => `'${finding.phrase}'`)
      .join(', ')}.`;

    const rejected = await db().marketingAsset.update({
      where: { id: asset.id },
      data: { state: 'rejected', rejectionReason: reason, reviewedAt: now },
    });

    await append({
      tenantId: input.tenantId,
      type: 'marketing.asset.rejected',
      actor: input.actor,
      payload: { assetId: asset.id, key: asset.key, reason },
    });

    return ok(toAsset(rejected));
  }

  const row = await db().marketingAsset.update({
    where: { id: asset.id },
    data: { state: 'in_review', rejectionReason: null },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.asset.submitted',
    actor: input.actor,
    payload: {
      assetId: asset.id,
      key: asset.key,
      verdict: scan.value.verdict,
      requiredDisclosures: scan.value.requiredDisclosures.length,
    },
  });

  return ok(toAsset(row));
};

/** Approve a reviewed asset. Only from `in_review` - approving a draft skips the scan. */
export const approveAsset = async (input: {
  tenantId: string;
  assetId: string;
  reviewedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<AssetRecord>> => {
  const now = input.now ?? new Date();

  const asset = await db().marketingAsset.findFirst({
    where: { tenantId: input.tenantId, id: input.assetId },
  });
  if (!asset) return noData(`No asset ${input.assetId} is on record.`);
  if (asset.state !== 'in_review') {
    return refused(
      `Asset '${asset.key}' is ${asset.state}. Approval runs from review, and review is where the compliance scan happens - approving straight from draft would put unscanned copy into the library.`,
      'Blueprint 4.5 - content workflow states',
    );
  }

  const row = await db().marketingAsset.update({
    where: { id: asset.id },
    data: { state: 'approved', reviewedAt: now, reviewedBy: input.reviewedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.asset.approved',
    actor: input.actor,
    payload: { assetId: asset.id, key: asset.key, reviewedBy: input.reviewedBy },
  });

  return ok(toAsset(row));
};

export const assetsFor = async (
  tenantId: string,
  filter: { state?: AssetState } = {},
): Promise<readonly AssetRecord[]> => {
  const rows = await db().marketingAsset.findMany({
    where: { tenantId, ...(filter.state !== undefined ? { state: filter.state as never } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toAsset);
};
