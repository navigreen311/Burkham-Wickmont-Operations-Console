-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "outcomes";

-- CreateEnum
CREATE TYPE "outcomes"."FundingAttemptOutcome" AS ENUM ('pending', 'approved', 'declined', 'withdrawn');

-- CreateEnum
CREATE TYPE "outcomes"."ClientSatisfaction" AS ENUM ('not_asked', 'delighted', 'satisfied', 'dissatisfied');

-- CreateTable
CREATE TABLE "outcomes"."funding_attempts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "productKind" "lenders"."ProductKind" NOT NULL,
    "requestedCents" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "outcomes"."FundingAttemptOutcome" NOT NULL DEFAULT 'pending',
    "decidedAt" TIMESTAMP(3),
    "approvedCreditLimitCents" INTEGER,
    "declineReason" TEXT,
    "fundedOn" TIMESTAMP(3),
    "fundedCents" INTEGER,
    "clientProfileKey" TEXT NOT NULL,
    "underwritingNotes" TEXT,
    "nextRecommendedMove" TEXT,
    "satisfaction" "outcomes"."ClientSatisfaction" NOT NULL DEFAULT 'not_asked',
    "billingOutcomeId" UUID,
    "recordedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funding_attempts_tenantId_clientId_idx" ON "outcomes"."funding_attempts"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "funding_attempts_tenantId_engagementId_idx" ON "outcomes"."funding_attempts"("tenantId", "engagementId");

-- CreateIndex
CREATE INDEX "funding_attempts_tenantId_providerId_productKind_idx" ON "outcomes"."funding_attempts"("tenantId", "providerId", "productKind");

-- CreateIndex
CREATE INDEX "funding_attempts_tenantId_clientProfileKey_idx" ON "outcomes"."funding_attempts"("tenantId", "clientProfileKey");

-- CreateIndex
CREATE INDEX "funding_attempts_tenantId_outcome_decidedAt_idx" ON "outcomes"."funding_attempts"("tenantId", "outcome", "decidedAt");


-- ---------------------------------------------------------------------------
-- CHECK constraints. Blueprint 5.5 asks for them by name ("CHECK-constraint
-- enforced"), and Prisma cannot express one, so they are written here.
--
-- The point of putting these in the database rather than only in the engine is
-- ADR-0034's: a rule the application enforces is a rule a script, a backfill or
-- the next module can walk past. These make the wrong shapes UNWRITABLE.
-- ---------------------------------------------------------------------------

-- An approval has an approved amount, and nothing else does.
--
-- This is the Seek Capital invariant given teeth. `approvedCreditLimit` is the
-- only figure a success fee may compute against, so a declined attempt must not
-- carry one - not even a zero, which would compute a fee of nothing and read in
-- every report as though the question had been asked and answered.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_approved_amount_iff_approved"
  CHECK (
    ("outcome" = 'approved' AND "approvedCreditLimitCents" IS NOT NULL)
    OR ("outcome" <> 'approved' AND "approvedCreditLimitCents" IS NULL)
  );

-- A decline states a reason, and nothing else carries one.
--
-- Required rather than optional because 5.2 learns appetite from it and the
-- client is owed it as an adverse-action explanation. A decline with an empty
-- reason is the row that teaches nobody anything.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_reason_iff_declined"
  CHECK (
    ("outcome" = 'declined' AND "declineReason" IS NOT NULL AND length(btrim("declineReason")) > 0)
    OR ("outcome" <> 'declined' AND "declineReason" IS NULL)
  );

-- Pending means undecided, and every other outcome means decided.
--
-- Without this a row can claim to be approved with no decision date, which makes
-- time-to-approval null on an approval and quietly drops it from the mean.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_decided_at_iff_decided"
  CHECK (
    ("outcome" = 'pending' AND "decidedAt" IS NULL)
    OR ("outcome" <> 'pending' AND "decidedAt" IS NOT NULL)
  );

-- Capital only funds against an approval, and it funds once, for an amount.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_funding_follows_approval"
  CHECK (
    ("fundedOn" IS NULL AND "fundedCents" IS NULL)
    OR ("outcome" = 'approved' AND "fundedOn" IS NOT NULL AND "fundedCents" IS NOT NULL)
  );

-- Money is a positive integer number of cents where it is present at all.
-- `> 0` rather than `>= 0`: an approval for nothing is a decline, and it should
-- be recorded as one so that the reason survives.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_amounts_positive"
  CHECK (
    "requestedCents" > 0
    AND ("approvedCreditLimitCents" IS NULL OR "approvedCreditLimitCents" > 0)
    AND ("fundedCents" IS NULL OR "fundedCents" > 0)
  );

-- Nothing is decided before it was submitted, and nothing funds before it was
-- decided. Time to approval and time to funding are computed from these, and a
-- negative duration would be published rather than caught.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_dates_in_order"
  CHECK (
    ("decidedAt" IS NULL OR "decidedAt" >= "submittedAt")
    AND ("fundedOn" IS NULL OR "decidedAt" IS NULL OR "fundedOn" >= "decidedAt")
  );

-- A cohort key that is blank buckets every client together, which is the one
-- grouping guaranteed to be wrong.
ALTER TABLE "outcomes"."funding_attempts"
  ADD CONSTRAINT "funding_attempts_cohort_key_present"
  CHECK (length(btrim("clientProfileKey")) > 0);
