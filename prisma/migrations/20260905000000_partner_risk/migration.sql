-- CreateEnum
CREATE TYPE "partners"."PartnerFindingKind" AS ENUM ('unauthorized_promise', 'unapproved_claim', 'client_complaint', 'documentation_gap', 'brand_misuse', 'other');

-- CreateEnum
CREATE TYPE "partners"."PartnerFindingSeverity" AS ENUM ('critical', 'serious', 'notable', 'context');

-- CreateTable
CREATE TABLE "partners"."partner_conduct_findings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "kind" "partners"."PartnerFindingKind" NOT NULL,
    "severity" "partners"."PartnerFindingSeverity" NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "clientId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" UUID NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "resolutionNote" TEXT,
    "upheld" BOOLEAN,

    CONSTRAINT "partner_conduct_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_conduct_findings_tenantId_partnerId_resolvedAt_idx" ON "partners"."partner_conduct_findings"("tenantId", "partnerId", "resolvedAt");

-- CreateIndex
CREATE INDEX "partner_conduct_findings_tenantId_kind_occurredAt_idx" ON "partners"."partner_conduct_findings"("tenantId", "kind", "occurredAt");

-- AddForeignKey
ALTER TABLE "partners"."partner_conduct_findings" ADD CONSTRAINT "partner_conduct_findings_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints, same discipline as 5.5's and 7.5's.
-- ---------------------------------------------------------------------------

-- A finding says what happened and where it came from.
--
-- The summary is what a decertification would rest on and the source is what
-- distinguishes a finding from a rumour. A standing built on rumours ends a
-- commercial relationship on the recollection of whoever spoke last.
ALTER TABLE "partners"."partner_conduct_findings"
  ADD CONSTRAINT "partner_conduct_findings_summary_and_source_present"
  CHECK (
    length(btrim("summary")) > 0
    AND length(btrim("source")) > 0
  );

-- A resolution is a complete act: a date, a person, a note, and a verdict.
--
-- The half-resolved shape is the dangerous one: `resolvedAt` set means the
-- finding stops counting toward the standing, so a partner comes off review -
-- and `upheld` null means nobody recorded whether the complaint was true.
ALTER TABLE "partners"."partner_conduct_findings"
  ADD CONSTRAINT "partner_conduct_findings_resolution_is_complete"
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

-- A finding is recorded on or after it happened.
--
-- `occurredAt` and `recordedAt` are separate on purpose - a promise made in
-- March and reported in August belongs in March on the partner's record and in
-- August in the audit trail - but the order between them is not optional.
ALTER TABLE "partners"."partner_conduct_findings"
  ADD CONSTRAINT "partner_conduct_findings_dates_in_order"
  CHECK ("recordedAt" >= "occurredAt");
