/**
 * Vendor activation as a recorded governance act - 11.5 with Specification v2 section 11.4.
 * ADR-0065.
 *
 * **What activation was before this file.** `VENDOR_GATES` in `index.ts` is a compile-time
 * constant of four booleans. To let client bank statements, credit reports, SSNs and EINs leave
 * this firm, somebody edited a TypeScript literal and deployed. There was no actor, no authority
 * level, no evidence, no date, and no record that survives a `git blame` being rewritten. The most
 * consequential control in the system - whether client financial data reaches a third party - was
 * a source edit reviewed as code.
 *
 * **ADR-0009 already decided this shape for states, and it is exact.** A state does not go live
 * without a Level 3 human and a counsel review carrying a document reference, and the level is
 * read from the recorded actor rather than from the caller who claims it. A vendor clearing Argus
 * review, a DPA and SOC 2 Type II is the same kind of fact: three pieces of evidence, a human who
 * accepted them, and a date.
 *
 * So activation is derived from `VendorEvidence` rows, each carrying a **required document
 * reference**. There is no boolean anywhere in this file that a person can set.
 *
 * ---
 *
 * Three things worth arguing with.
 *
 * **The document reference has no empty representation.** `recordEvidence` refuses a blank or
 * placeholder one. This is the whole difference between a governance record and a checkbox: a
 * screen where somebody ticks "SOC 2 cleared" with nothing behind it is worse than the constant it
 * replaces, because the constant at least left a commit with an author, and the tick looks
 * reviewed.
 *
 * **Staleness de-activates.** ADR-0013 says staleness moves toward the safe answer and ADR-0044
 * established the direction differs per module. Here it is not close: a SOC 2 Type II report
 * covers a stated period and says nothing about the vendor afterwards, so evidence past
 * `validUntil` stops counting and the gate closes on its own. The alternative - carrying an
 * expired attestation forward - means the firm's answer to "is this vendor still secure" is a
 * document about a period that ended.
 *
 * **The gate is read at the moment of the call, never cached at module load.** Same argument
 * ADR-0058 makes about consent: a withdrawn DPA has to take effect now, not at the next deploy.
 *
 * ---
 *
 * **The synchronous `isActivated` in `index.ts` is deliberately left alone and is now the
 * fail-closed floor.** Three consumers outside this package call it - `@bwc/intelligence`,
 * `apps/api/src/app.ts` and an invariants test - and this slice does not own them. It answers
 * "activated with no evidence considered", which is always `false`. A conservative disagreement
 * between the two can only over-refuse and never over-permit, which is the safe direction; the
 * follow-up is to move those three onto `activationStanding` and is named in ADR-0065.
 */

import { db } from '@bwc/db';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { VENDOR_IDS, type VendorId } from './index.js';

/** Accepting vendor evidence is a Level 3 decision. It is what lets client data leave the firm. */
export const ACTIVATION_AUTHORITY_LEVEL = 3;

export const VENDOR_EVIDENCE_KINDS = [
  'vendor_selection',
  'argus_security_review',
  'data_processing_agreement',
  'security_attestation',
] as const;
export type VendorEvidenceKind = (typeof VENDOR_EVIDENCE_KINDS)[number];

/** Human-readable, for a surface that has to say what is outstanding. */
export const EVIDENCE_LABEL: Readonly<Record<VendorEvidenceKind, string>> = {
  vendor_selection: 'vendor selection',
  argus_security_review: 'Argus security review',
  data_processing_agreement: 'signed DPA',
  security_attestation: 'SOC 2 Type II verification',
};

/**
 * What each vendor must produce before its gate can open.
 *
 * All four require all four. `capitalforge` is a sibling venture rather than an outside vendor,
 * and it was the one gate the old constant marked activated - on nobody's authority, with nothing
 * behind it. Requiring the same evidence of it is the point of the slice: a sibling company
 * holding client financial data is still a third party holding client financial data.
 */
export const REQUIRED_EVIDENCE: Readonly<Record<VendorId, readonly VendorEvidenceKind[]>> = {
  plaid: VENDOR_EVIDENCE_KINDS,
  business_bureau: VENDOR_EVIDENCE_KINDS,
  personal_credit: VENDOR_EVIDENCE_KINDS,
  capitalforge: VENDOR_EVIDENCE_KINDS,
};

/**
 * A reference that is not a reference.
 *
 * Checked because the failure mode is not a blank field - a form makes that hard - it is somebody
 * typing `n/a` to get past a required input. Naming the shapes is not a complete defence and is
 * not meant to be; it is the cheap half, and the expensive half is that a human at Level 3 has
 * their name against it.
 */
const PLACEHOLDER = /^(n\/?a|none|tbd|todo|pending|xxx+|-+|\.+|test|na)$/i;

export const isUsableDocumentReference = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.length >= 6 && !PLACEHOLDER.test(trimmed);
};

export interface RecordEvidenceInput {
  readonly vendor: VendorId;
  readonly kind: VendorEvidenceKind;
  /** Required. A report number, an executed agreement reference, an attestation id. */
  readonly documentReference: string;
  readonly issuedBy: string;
  readonly issuedOn: Date;
  /** When the document stops describing the vendor. Required for an attestation. */
  readonly validUntil?: Date;
  /** The actor accepting it. Their level is read from the record, not from the caller. */
  readonly acceptedBy: string;
  readonly now?: Date;
}

export interface AcceptedEvidence {
  readonly id: string;
  readonly vendor: VendorId;
  readonly kind: VendorEvidenceKind;
  readonly documentReference: string;
  readonly issuedBy: string;
  readonly issuedOn: string;
  readonly validUntil: string | null;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

interface Row {
  id: string;
  vendor: string;
  kind: string;
  documentReference: string;
  issuedBy: string;
  issuedOn: Date;
  validUntil: Date | null;
  acceptedBy: string;
  acceptedAt: Date;
}

const toEvidence = (row: Row): AcceptedEvidence => ({
  id: row.id,
  vendor: row.vendor as VendorId,
  kind: row.kind as VendorEvidenceKind,
  documentReference: row.documentReference,
  issuedBy: row.issuedBy,
  issuedOn: row.issuedOn.toISOString(),
  validUntil: row.validUntil?.toISOString() ?? null,
  acceptedBy: row.acceptedBy,
  acceptedAt: row.acceptedAt.toISOString(),
});

/**
 * Accept one piece of evidence for one vendor.
 *
 * Five checks, in this order, and the order is the design:
 *
 *   1. the vendor and kind are real            - a typo cannot create a gate nobody reads
 *   2. the document reference is usable        - HERE, before any authority check, so that a
 *                                                Level 3 human cannot wave through a blank one
 *   3. an attestation carries an expiry        - a SOC 2 with no end date is a misread document
 *   4. the accepting actor is a Level 3 human  - read from the actor record
 *   5. nothing identical is already live       - accepting twice is two authorisations for one act
 */
export const recordEvidence = async (
  input: RecordEvidenceInput,
): Promise<Outcome<AcceptedEvidence>> => {
  const now = input.now ?? new Date();

  if (!(VENDOR_IDS as readonly string[]).includes(input.vendor)) {
    return refused(
      `'${input.vendor}' is not a known vendor.`,
      'Blueprint 11.5 - Integration Layer',
    );
  }
  if (!(VENDOR_EVIDENCE_KINDS as readonly string[]).includes(input.kind)) {
    return refused(
      `'${input.kind}' is not a kind of evidence this gate recognises.`,
      'Specification v2 section 11.4 - vendor preconditions',
    );
  }

  // Before authority, deliberately. A Level 3 human is not a licence to record nothing.
  if (!isUsableDocumentReference(input.documentReference)) {
    return refused(
      `Evidence needs a document reference somebody can go and read - a report number, an executed agreement reference, an attestation id. '${input.documentReference}' is blank or a placeholder. A gate that opens on a tick with nothing behind it is worse than the compile-time constant this replaces, because the constant at least left a commit with an author against it.`,
      'ADR-0065 - vendor activation is a recorded governance act',
    );
  }

  if (input.issuedBy.trim().length < 2) {
    return refused(
      'Evidence needs an issuer. For three of the four kinds the issuer is not us, and which outside party stood behind the document is the substance of it.',
      'ADR-0065 - vendor activation is a recorded governance act',
    );
  }

  if (input.kind === 'security_attestation' && input.validUntil === undefined) {
    return refused(
      'A security attestation needs the date it stops describing the vendor. A SOC 2 Type II covers a stated period; recording one with no end is recording a document somebody has misread, and it would keep this gate open on evidence about a period that has finished.',
      'ADR-0065 - staleness de-activates',
    );
  }

  if (input.validUntil !== undefined && input.validUntil.getTime() <= input.issuedOn.getTime()) {
    return refused(
      'Evidence cannot stop being valid before it was issued.',
      'ADR-0065 - vendor activation is a recorded governance act',
    );
  }

  const actor = await findActor(input.acceptedBy);
  if (!actor) return noData(`No actor ${input.acceptedBy} is on record.`);
  if (actor.kind !== 'human' || actor.authorityLevel < ACTIVATION_AUTHORITY_LEVEL) {
    return refused(
      `Accepting vendor evidence requires a human at Authority Level ${ACTIVATION_AUTHORITY_LEVEL}. It is the act that lets client bank statements, credit reports and tax identifiers leave this firm.`,
      'Principle 4 with ADR-0009 - the level is read from the recorded actor',
    );
  }

  const live = await db().vendorEvidence.findFirst({
    where: {
      vendor: input.vendor,
      kind: input.kind,
      withdrawnAt: null,
      documentReference: input.documentReference.trim(),
    },
  });
  if (live) {
    return refused(
      `That document is already on record as ${EVIDENCE_LABEL[input.kind]} for ${input.vendor}. Accepting it twice would be two authorisations for one act.`,
      'ADR-0065 - vendor activation is a recorded governance act',
    );
  }

  const row = await db().vendorEvidence.create({
    data: {
      vendor: input.vendor,
      kind: input.kind,
      documentReference: input.documentReference.trim(),
      issuedBy: input.issuedBy.trim(),
      issuedOn: input.issuedOn,
      validUntil: input.validUntil ?? null,
      acceptedBy: actor.id,
      acceptedAt: now,
      acceptedInTenantId: actor.tenantId,
    },
  });

  return ok(toEvidence(row));
};

/** Withdraw evidence. A compensating write - the row stays, so what we relied on survives. */
export const withdrawEvidence = async (input: {
  evidenceId: string;
  reason: string;
  withdrawnBy: string;
  now?: Date;
}): Promise<Outcome<{ evidenceId: string }>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'Withdrawing evidence needs a reason somebody can read back. It closes a gate that client work may already be depending on.',
      'ADR-0065 - vendor activation is a recorded governance act',
    );
  }

  const row = await db().vendorEvidence.findUnique({ where: { id: input.evidenceId } });
  if (!row) return noData(`No evidence ${input.evidenceId} is on record.`);
  if (row.withdrawnAt !== null) {
    return refused('That evidence is already withdrawn.', 'ADR-0065');
  }

  const actor = await findActor(input.withdrawnBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < ACTIVATION_AUTHORITY_LEVEL) {
    return refused(
      `Withdrawing vendor evidence requires a human at Authority Level ${ACTIVATION_AUTHORITY_LEVEL}.`,
      'Principle 4 with ADR-0009',
    );
  }

  await db().vendorEvidence.update({
    where: { id: row.id },
    data: { withdrawnAt: now, withdrawnBy: actor.id, withdrawnReason: input.reason },
  });

  return ok({ evidenceId: row.id });
};

export interface OutstandingItem {
  readonly kind: VendorEvidenceKind;
  readonly label: string;
  /** `missing`, or `expired` with the date it stopped counting. */
  readonly why: string;
}

export interface VendorStanding {
  readonly vendor: VendorId;
  /** The single question every caller actually asks. */
  readonly activated: boolean;
  readonly outstanding: readonly OutstandingItem[];
  readonly accepted: readonly AcceptedEvidence[];
  /** One sentence naming the vendor, its state, and what would change it. */
  readonly explanation: string;
}

/**
 * A vendor's activation standing, derived on read.
 *
 * Derived rather than stored, for the reason this codebase has now given several times: a stored
 * flag needs a job to maintain it, and a job that stops leaves every vendor reading as activated.
 * Here it also gets expiry for free - evidence past `validUntil` simply stops being counted, with
 * no scheduled task to notice.
 */
export const activationStanding = async (
  vendor: VendorId,
  now: Date = new Date(),
): Promise<VendorStanding> => {
  const rows = await db().vendorEvidence.findMany({
    where: { vendor, withdrawnAt: null },
    orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
  });

  const required = REQUIRED_EVIDENCE[vendor] ?? VENDOR_EVIDENCE_KINDS;
  const outstanding: OutstandingItem[] = [];
  const accepted: AcceptedEvidence[] = [];

  for (const kind of required) {
    const forKind = rows.filter((row) => row.kind === kind);
    const live = forKind.find(
      (row) => row.validUntil === null || row.validUntil.getTime() > now.getTime(),
    );

    if (live) {
      accepted.push(toEvidence(live));
      continue;
    }

    const expired = forKind[0];
    outstanding.push({
      kind,
      label: EVIDENCE_LABEL[kind],
      why:
        expired?.validUntil != null
          ? `expired ${expired.validUntil.toISOString().slice(0, 10)} (${expired.documentReference})`
          : 'no document on record',
    });
  }

  const activated = outstanding.length === 0;

  return {
    vendor,
    activated,
    outstanding,
    accepted,
    explanation: activated
      ? `${vendor} is activated on ${accepted.length} accepted document(s), the earliest expiry being ${
          accepted
            .map((entry) => entry.validUntil)
            .filter((value): value is string => value !== null)
            .sort()[0]
            ?.slice(0, 10) ?? 'none'
        }.`
      : `${vendor} is not activated. Outstanding: ${outstanding
          .map((item) => `${item.label} (${item.why})`)
          .join(
            ', ',
          )}. Specification v2 section 11.4 requires all of these before any client onboards.`,
  };
};

/** Every vendor's standing. What the surface shows. */
export const activationBoard = async (
  now: Date = new Date(),
): Promise<readonly VendorStanding[]> => {
  const standings = await Promise.all(VENDOR_IDS.map((vendor) => activationStanding(vendor, now)));
  return standings;
};

/**
 * Whether ANY client may be onboarded.
 *
 * CLAUDE.md's standing constraint, expressed once: no client onboards before Plaid, the business
 * bureaus and personal credit each clear Argus review, a signed DPA and SOC 2 Type II. This is the
 * function that answers it, and it answers `false` today.
 */
export const CLIENT_ONBOARDING_VENDORS: readonly VendorId[] = [
  'plaid',
  'business_bureau',
  'personal_credit',
];

export const mayOnboardClients = async (
  now: Date = new Date(),
): Promise<Outcome<{ readonly since: string }>> => {
  const standings = await Promise.all(
    CLIENT_ONBOARDING_VENDORS.map((vendor) => activationStanding(vendor, now)),
  );

  const blocked = standings.filter((standing) => !standing.activated);
  if (blocked.length > 0) {
    return refused(
      `No client may be onboarded. ${blocked.length} of ${CLIENT_ONBOARDING_VENDORS.length} vendors carrying client financial data are not activated: ${blocked
        .map(
          (standing) =>
            // The `why` travels, not just the label. "needs SOC 2 Type II verification" reads as
            // never-obtained; "needs SOC 2 Type II verification (expired 2027-06-01)" is a
            // different problem with a different fix, and the person reading this has to know
            // which one they have.
            `${standing.vendor} needs ${standing.outstanding
              .map((item) => `${item.label} (${item.why})`)
              .join(' and ')}`,
        )
        .join('; ')}.`,
      'CLAUDE.md with Specification v2 section 11.4 - no client onboards before every vendor gate clears',
    );
  }

  const latest = standings
    .flatMap((standing) => standing.accepted.map((entry) => entry.acceptedAt))
    .sort()
    .pop();

  return ok({ since: latest ?? now.toISOString() });
};
