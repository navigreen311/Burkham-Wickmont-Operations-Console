-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "retention";

-- CreateEnum
CREATE TYPE "retention"."LegalHoldKind" AS ENUM ('litigation', 'complaint', 'regulator_request', 'client_dispute');

-- CreateEnum
CREATE TYPE "retention"."LegalHoldScope" AS ENUM ('tenant', 'client', 'document_kind');

-- CreateEnum
CREATE TYPE "retention"."DeletionRequestStatus" AS ENUM ('received', 'refused', 'approved', 'completed');

-- CreateTable
CREATE TABLE "retention"."legal_holds" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "retention"."LegalHoldKind" NOT NULL,
    "scope" "retention"."LegalHoldScope" NOT NULL,
    "clientId" UUID,
    "documentKind" "vault"."DocumentKind",
    "matterReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedBy" UUID NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "reviewCadenceDays" INTEGER NOT NULL DEFAULT 180,
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedBy" UUID,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" UUID,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention"."retention_schedules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentKind" "vault"."DocumentKind" NOT NULL,
    "stateCode" TEXT,
    "retainMonths" INTEGER NOT NULL,
    "provenanceTag" "lenders"."ProvenanceTag" NOT NULL,
    "sourceUrl" TEXT,
    "lastVerified" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "rationale" TEXT,
    "recordedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededBy" UUID,

    CONSTRAINT "retention_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention"."deletion_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "requestedBy" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "requestDetail" TEXT NOT NULL,
    "status" "retention"."DeletionRequestStatus" NOT NULL DEFAULT 'received',
    "decidedAt" TIMESTAMP(3),
    "decidedBy" UUID,
    "decisionReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "documentsDeleted" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_holds_tenantId_releasedAt_idx" ON "retention"."legal_holds"("tenantId", "releasedAt");

-- CreateIndex
CREATE INDEX "legal_holds_tenantId_clientId_releasedAt_idx" ON "retention"."legal_holds"("tenantId", "clientId", "releasedAt");

-- CreateIndex
CREATE INDEX "retention_schedules_tenantId_documentKind_stateCode_superse_idx" ON "retention"."retention_schedules"("tenantId", "documentKind", "stateCode", "supersededAt");

-- CreateIndex
CREATE INDEX "retention_schedules_tenantId_provenanceTag_idx" ON "retention"."retention_schedules"("tenantId", "provenanceTag");

-- CreateIndex
CREATE INDEX "deletion_requests_tenantId_clientId_status_idx" ON "retention"."deletion_requests"("tenantId", "clientId", "status");


-- ---------------------------------------------------------------------------
-- CHECK constraints. Same discipline as 5.5's, and the same reason: a rule the
-- application enforces is a rule a script, a backfill or a psql session can
-- walk past - and the thing on the other side of these rules is destroyed
-- records.
-- ---------------------------------------------------------------------------

-- Scope and its arguments agree, in both directions.
--
-- Both halves are silent failures and they fail in opposite directions. A
-- `client` hold with no client falls through to the tenant-wide branch of
-- `holdsCovering` and holds EVERY client - which looks like caution and is
-- actually a hold nobody can release without releasing all the others. A
-- `tenant` hold carrying a client id reads as narrower in a listing than it
-- actually is, which is how somebody concludes a matter is contained.
ALTER TABLE "retention"."legal_holds"
  ADD CONSTRAINT "legal_holds_scope_arguments_agree"
  CHECK (
    ("scope" = 'client' AND "clientId" IS NOT NULL AND "documentKind" IS NULL)
    OR ("scope" = 'document_kind' AND "documentKind" IS NOT NULL AND "clientId" IS NULL)
    OR ("scope" = 'tenant' AND "clientId" IS NULL AND "documentKind" IS NULL)
  );

-- A hold names its matter and its reason.
--
-- Required rather than optional because a hold nobody can trace to a matter is
-- a hold nobody will ever dare release, and the failure mode of that is a
-- system that accumulates holds until it can delete nothing at all.
ALTER TABLE "retention"."legal_holds"
  ADD CONSTRAINT "legal_holds_matter_and_reason_present"
  CHECK (
    length(btrim("matterReference")) > 0
    AND length(btrim("reason")) > 0
  );

-- A release is a complete act: a date, an author, and a stated reason.
--
-- A half-released hold is the worst of both - `releasedAt` set means
-- `holdsCovering` stops returning it, so preservation has stopped, and the
-- record of who decided that is missing.
ALTER TABLE "retention"."legal_holds"
  ADD CONSTRAINT "legal_holds_release_is_complete"
  CHECK (
    ("releasedAt" IS NULL AND "releasedBy" IS NULL AND "releaseReason" IS NULL)
    OR (
      "releasedAt" IS NOT NULL
      AND "releasedBy" IS NOT NULL
      AND "releaseReason" IS NOT NULL
      AND length(btrim("releaseReason")) > 0
    )
  );

-- A review cadence is a positive number of days.
ALTER TABLE "retention"."legal_holds"
  ADD CONSTRAINT "legal_holds_cadence_positive"
  CHECK ("reviewCadenceDays" > 0);

-- A retention period is a positive whole number of months.
--
-- Zero is rejected deliberately. A period of zero authorises immediate
-- destruction, and that is a decision somebody should have to write down as
-- one rather than arrive at by leaving a field empty.
ALTER TABLE "retention"."retention_schedules"
  ADD CONSTRAINT "retention_schedules_period_positive"
  CHECK ("retainMonths" > 0);

-- Provenance is complete for the tag it claims.
--
-- The number in this row decides whether a document is destroyed. An
-- `issuer_rule` with no citation is an assumption wearing the confidence of a
-- statute, which is the exact failure Decision D exists to prevent - with
-- shredded records rather than a disappointed client at the end of it.
ALTER TABLE "retention"."retention_schedules"
  ADD CONSTRAINT "retention_schedules_provenance_complete"
  CHECK (
    (
      "provenanceTag" = 'issuer_rule'
      AND "sourceUrl" IS NOT NULL
      AND length(btrim("sourceUrl")) > 0
      AND "lastVerified" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND "rationale" IS NULL
    )
    OR (
      "provenanceTag" = 'unresearched_default'
      AND "rationale" IS NOT NULL
      AND length(btrim("rationale")) > 0
      AND "sourceUrl" IS NULL
      AND "lastVerified" IS NULL
      AND "verifiedBy" IS NULL
    )
  );

-- A vendor feed and a client statement are not sources of law.
--
-- The enum is shared with 5.2, where `vendor_feed` is legitimate. Here it is
-- not, and the constraint says so rather than leaving the shared vocabulary to
-- imply that every tag applies everywhere.
ALTER TABLE "retention"."retention_schedules"
  ADD CONSTRAINT "retention_schedules_legal_provenance_only"
  CHECK ("provenanceTag" IN ('issuer_rule', 'unresearched_default'));

-- A state code is two letters, or the row is the default.
--
-- A malformed code matches no query and silently falls back to the default,
-- so the rule somebody carefully researched for Texas would apply nowhere and
-- nothing would say so.
ALTER TABLE "retention"."retention_schedules"
  ADD CONSTRAINT "retention_schedules_state_code_shape"
  CHECK ("stateCode" IS NULL OR "stateCode" ~ '^[A-Z]{2}$');

-- A decided request states who decided it and why; a completed one counts what
-- it destroyed.
--
-- "We deleted everything" is not a claim anybody should have to take on trust,
-- and zero is a legitimate count: an approved request that destroyed nothing
-- means every document was still inside its retention period, which the client
-- is entitled to be told.
ALTER TABLE "retention"."deletion_requests"
  ADD CONSTRAINT "deletion_requests_decision_is_complete"
  CHECK (
    ("status" = 'received' AND "decidedAt" IS NULL AND "decidedBy" IS NULL)
    OR (
      "status" <> 'received'
      AND "decidedAt" IS NOT NULL
      AND "decidedBy" IS NOT NULL
      AND "decisionReason" IS NOT NULL
      AND length(btrim("decisionReason")) > 0
    )
  );

ALTER TABLE "retention"."deletion_requests"
  ADD CONSTRAINT "deletion_requests_completion_is_counted"
  CHECK (
    ("status" <> 'completed' AND "completedAt" IS NULL AND "documentsDeleted" IS NULL)
    OR (
      "status" = 'completed'
      AND "completedAt" IS NOT NULL
      AND "documentsDeleted" IS NOT NULL
      AND "documentsDeleted" >= 0
    )
  );
