/**
 * Ingestion — blueprint 3.3 steps 1, 2, 4, 5, and the persistence of what comes out.
 *
 * Every vendor in this flow is ungated (§11.4, §12.3), so nothing can actually be fetched. What
 * *can* be built correctly today is the part that will still be true when they are activated: the
 * consent gate, the run record, the provenance, and the honest report of what is outstanding.
 *
 * **Consent is checked before the vendor gate**, deliberately. Decision A makes a Plaid connection
 * GLBA-adjacent and Decision B makes bureau pulls FCRA-adjacent, both requiring per-event
 * authorization. If the client has not authorized the pull, that is the accurate reason to refuse
 * — the vendor gate is our problem, not theirs, and reporting ours first would misdescribe why
 * nothing happened.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { check as checkConsent, type ConsentKind } from '@bwc/consent';
import {
  businessBureauPull,
  isActivated,
  outstandingPreconditions,
  personalCreditPull,
  plaidTransactions,
  type VendorId,
} from '@bwc/integration';
import { failed, type EventActor, type Outcome } from '@bwc/core';
import type { Finding } from './analyze.js';
import type { NormalizedFeed } from './normalized.js';

export type IntelligenceSource =
  'plaid' | 'business_bureau' | 'personal_credit' | 'uploaded_document';

export type IngestionStatus = 'completed' | 'not_available' | 'unauthorized' | 'failed';

/** Which consent each source requires, per Decisions A and B. */
export const REQUIRED_CONSENT: Record<
  Exclude<IntelligenceSource, 'uploaded_document'>,
  ConsentKind
> = {
  plaid: 'plaid_connection',
  business_bureau: 'business_bureau_pull',
  personal_credit: 'personal_credit_pull',
};

const VENDOR_FOR_SOURCE: Record<Exclude<IntelligenceSource, 'uploaded_document'>, VendorId> = {
  plaid: 'plaid',
  business_bureau: 'business_bureau',
  personal_credit: 'personal_credit',
};

export interface IngestInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly source: Exclude<IntelligenceSource, 'uploaded_document'>;
  /** What the consent must cover — the institution for Plaid, the entity for a bureau pull. */
  readonly scope: string;
  readonly monthsRequested: number;
  readonly actor: EventActor;
  readonly now?: Date;
}

export interface IngestionRun {
  readonly id: string;
  readonly source: IntelligenceSource;
  readonly status: IngestionStatus;
  readonly monthsRequested: number;
  readonly monthsCovered: number;
  readonly failureReason: string | null;
}

const recordRun = async (
  input: IngestInput,
  status: IngestionStatus,
  consentId: string | null,
  failureReason: string | null,
  monthsCovered = 0,
): Promise<IngestionRun> => {
  const row = await db().ingestionRun.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      source: input.source,
      status,
      consentId,
      monthsRequested: input.monthsRequested,
      monthsCovered,
      failureReason,
    },
  });

  return {
    id: row.id,
    source: row.source as IntelligenceSource,
    status: row.status as IngestionStatus,
    monthsRequested: row.monthsRequested,
    monthsCovered: row.monthsCovered,
    failureReason: row.failureReason,
  };
};

/**
 * Attempt an ingestion.
 *
 * Every attempt is recorded, including the ones that go nowhere. A run row that says
 * `unauthorized` or `not_available` is how "we tried and could not" is distinguishable from "we
 * never tried" — and the second is what an absent row would mean.
 */
export const ingest = async (input: IngestInput): Promise<Outcome<IngestionRun>> => {
  const now = input.now ?? new Date();
  const requiredConsent = REQUIRED_CONSENT[input.source];

  await append({
    tenantId: input.tenantId,
    type: 'intelligence.ingestion_attempted',
    actor: input.actor,
    clientId: input.clientId,
    payload: { source: input.source, scope: input.scope, monthsRequested: input.monthsRequested },
  });

  // 1. Consent first. If the client has not authorized this, that is the reason - not our
  //    vendor gate, which is a fact about us.
  const consent = await checkConsent(
    input.tenantId,
    input.clientId,
    requiredConsent,
    input.scope,
    now,
  );

  if (consent.status !== 'ok') {
    const reason =
      consent.status === 'refused' ? consent.reason : 'authorization could not be confirmed';
    await recordRun(input, 'unauthorized', null, reason);
    return consent as Outcome<IngestionRun>;
  }

  // 2. Vendor activation. §11.4 gates all three behind Argus review, a signed DPA and verified
  //    SOC 2 Type II; two also await vendor selection (§12.3).
  const vendor = VENDOR_FOR_SOURCE[input.source];
  if (!isActivated(vendor)) {
    const outstanding = outstandingPreconditions(vendor).join(', ');
    const run = await recordRun(
      input,
      'not_available',
      consent.value.id,
      `vendor not activated: ${outstanding}`,
    );

    await append({
      tenantId: input.tenantId,
      type: 'intelligence.ingestion_unavailable',
      actor: input.actor,
      clientId: input.clientId,
      payload: {
        source: input.source,
        runId: run.id,
        outstanding: outstandingPreconditions(vendor),
      },
    });

    return {
      status: 'not_built',
      module: `3.3 Document Intelligence Pipeline → ${vendor}`,
      reason: `The client has authorized this, but ${vendor} is not activated. Outstanding: ${outstanding}. No data was fetched and none was invented.`,
    };
  }

  // 3. The adapter. Unreachable while the gates are closed; written so activation is a
  //    configuration change rather than a code change.
  //
  // Branched per source rather than selecting an adapter into a variable: the adapters take
  // different request shapes, so a union collapses `call`'s parameter to `never` and the only
  // way past that is a cast that discards the very type-checking this is for.
  const request = { clientId: input.clientId, consentReference: consent.value.id };

  const response =
    input.source === 'plaid'
      ? await plaidTransactions.call({ ...request, months: input.monthsRequested })
      : input.source === 'business_bureau'
        ? await businessBureauPull.call(request)
        : await personalCreditPull.call(request);

  if (response.status !== 'ok') {
    await recordRun(
      input,
      response.status === 'not_built' ? 'not_available' : 'failed',
      consent.value.id,
      // Every non-ok Outcome variant carries a reason - that is the point of the type.
      response.reason,
    );
    return response as Outcome<IngestionRun>;
  }

  return failed(
    'Adapter returned data but no normalizer is wired for it yet. Normalization is defined in @bwc/intelligence/normalized; wire it when the vendor gate clears.',
  );
};

/**
 * Persist an already-normalized feed.
 *
 * The path a native parser (Decision A's V2 roadmap) or a test uses. Separated from `ingest` so
 * the analysis half of this module is exercisable end to end today, rather than waiting on three
 * vendor gates that are not ours to open.
 */
export const recordNormalizedFeed = async (
  tenantId: string,
  clientId: string,
  feed: NormalizedFeed,
  actor: EventActor,
): Promise<IngestionRun> => {
  const row = await db().ingestionRun.create({
    data: {
      tenantId,
      clientId,
      source: feed.source,
      status: 'completed',
      monthsRequested: feed.monthsRequested,
      monthsCovered: feed.monthsCovered,
      retrievedAt:
        feed.provenance.tag === 'vendor_feed' ? new Date(feed.provenance.retrievedAt) : null,
      normalized: feed as unknown as object,
    },
  });

  await append({
    tenantId,
    type: 'intelligence.ingestion_completed',
    actor,
    clientId,
    payload: {
      runId: row.id,
      source: feed.source,
      accounts: feed.accounts.length,
      transactions: feed.transactions.length,
      monthsCovered: feed.monthsCovered,
      monthsRequested: feed.monthsRequested,
    },
  });

  return {
    id: row.id,
    source: row.source as IntelligenceSource,
    status: 'completed',
    monthsRequested: row.monthsRequested,
    monthsCovered: row.monthsCovered,
    failureReason: null,
  };
};

/**
 * Persist findings.
 *
 * The summary and detail reach the Event Ledger, so neither may contain a raw transaction
 * description — those carry counterparty names. The analyses upstream already respect this; the
 * assertion in `append` is the backstop.
 */
export const recordFindings = async (
  tenantId: string,
  clientId: string,
  runId: string | null,
  findings: readonly Finding[],
  actor: EventActor,
): Promise<number> => {
  for (const finding of findings) {
    await db().intelligenceFinding.create({
      data: {
        tenantId,
        clientId,
        runId,
        kind: finding.kind,
        severity: finding.severity,
        summary: finding.summary,
        detail: finding.detail as unknown as object,
        occurredAt: finding.occurredOn !== undefined ? new Date(finding.occurredOn) : null,
      },
    });

    await append({
      tenantId,
      type: 'intelligence.finding_raised',
      actor,
      clientId,
      payload: {
        kind: finding.kind,
        severity: finding.severity,
        ...(runId !== null ? { runId } : {}),
      },
    });
  }

  return findings.length;
};

export const findingsFor = async (
  tenantId: string,
  clientId: string,
): Promise<
  { kind: string; severity: string; summary: string; detail: unknown; occurredAt: Date | null }[]
> => {
  const rows = await db().intelligenceFinding.findMany({
    where: { tenantId, clientId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    detail: row.detail,
    occurredAt: row.occurredAt,
  }));
};

export const runsFor = async (tenantId: string, clientId: string): Promise<IngestionRun[]> => {
  const rows = await db().ingestionRun.findMany({
    where: { tenantId, clientId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    source: row.source as IntelligenceSource,
    status: row.status as IngestionStatus,
    monthsRequested: row.monthsRequested,
    monthsCovered: row.monthsCovered,
    failureReason: row.failureReason,
  }));
};
