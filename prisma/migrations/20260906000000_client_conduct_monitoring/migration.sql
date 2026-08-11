-- CreateEnum
CREATE TYPE "risk"."ConductBreachKind" AS ENUM ('independent_application', 'undisclosed_debt', 'funds_usage_anomaly', 'document_inconsistency', 'payment_alert_non_response', 'staff_pressure_incident', 'post_funding_non_response', 'unfounded_fee_dispute', 'abuse');

-- CreateTable
CREATE TABLE "risk"."client_conduct_breaches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" "risk"."ConductBreachKind" NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detectedBy" UUID NOT NULL,
    "reviewCadenceDays" INTEGER NOT NULL,
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "resolutionNote" TEXT,
    "upheld" BOOLEAN,
    "observationId" UUID,

    CONSTRAINT "client_conduct_breaches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_conduct_breaches_tenantId_clientId_resolvedAt_idx" ON "risk"."client_conduct_breaches"("tenantId", "clientId", "resolvedAt");

-- CreateIndex
CREATE INDEX "client_conduct_breaches_tenantId_kind_occurredAt_idx" ON "risk"."client_conduct_breaches"("tenantId", "kind", "occurredAt");


-- ---------------------------------------------------------------------------
-- CHECK constraints. Same discipline as 5.5, 7.5 and 8.4.
-- ---------------------------------------------------------------------------

-- A breach says what happened and where the detection came from.
--
-- A breach with no provenance is an accusation, and a service pause built on
-- accusations cuts a client off on a rumour.
ALTER TABLE "risk"."client_conduct_breaches"
  ADD CONSTRAINT "client_conduct_breaches_summary_and_source_present"
  CHECK (
    length(btrim("summary")) > 0
    AND length(btrim("source")) > 0
  );

-- Severity is one of the four 6.5 already uses.
--
-- Held as text so a fifth severity is a decision rather than a migration, and
-- constrained here so a typo is a rejected write rather than a breach that
-- silently falls through every severity comparison in the engine.
ALTER TABLE "risk"."client_conduct_breaches"
  ADD CONSTRAINT "client_conduct_breaches_severity_known"
  CHECK ("severity" IN ('critical', 'serious', 'notable', 'context'));

-- A resolution is complete: a date, a person, a note and a verdict.
--
-- The half-resolved shape lifts a service pause - `resolvedAt` set means the
-- breach stops counting toward the standing - while leaving no record of who
-- decided that or whether the detection was founded.
ALTER TABLE "risk"."client_conduct_breaches"
  ADD CONSTRAINT "client_conduct_breaches_resolution_is_complete"
  CHECK (
    (
      "resolvedAt" IS NULL
      AND "resolvedBy" IS NULL
      AND "resolutionNote" IS NULL
      AND "upheld" IS NULL
    )
    OR (
      "resolvedAt" IS NOT NULL
      AND "resolvedBy" IS NOT NULL
      AND "resolutionNote" IS NOT NULL
      AND length(btrim("resolutionNote")) > 0
      AND "upheld" IS NOT NULL
    )
  );

-- A review cadence is a positive number of days, and detection follows the act.
ALTER TABLE "risk"."client_conduct_breaches"
  ADD CONSTRAINT "client_conduct_breaches_cadence_positive"
  CHECK ("reviewCadenceDays" > 0);

ALTER TABLE "risk"."client_conduct_breaches"
  ADD CONSTRAINT "client_conduct_breaches_dates_in_order"
  CHECK ("detectedAt" >= "occurredAt");
