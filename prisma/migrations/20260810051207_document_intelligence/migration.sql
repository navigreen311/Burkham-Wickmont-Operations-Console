-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "intelligence";

-- CreateEnum
CREATE TYPE "intelligence"."IntelligenceSource" AS ENUM ('plaid', 'business_bureau', 'personal_credit', 'uploaded_document');

-- CreateEnum
CREATE TYPE "intelligence"."IngestionStatus" AS ENUM ('completed', 'not_available', 'unauthorized', 'failed');

-- CreateEnum
CREATE TYPE "intelligence"."FindingKind" AS ENUM ('nsf_event', 'large_deposit', 'owner_transfer', 'revenue_mismatch', 'balance_deterioration', 'missing_document', 'bureau_bank_disagreement');

-- CreateEnum
CREATE TYPE "intelligence"."FindingSeverity" AS ENUM ('informational', 'attention', 'urgent');

-- CreateTable
CREATE TABLE "intelligence"."ingestion_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "source" "intelligence"."IntelligenceSource" NOT NULL,
    "status" "intelligence"."IngestionStatus" NOT NULL,
    "consentId" UUID,
    "retrievedAt" TIMESTAMP(3),
    "monthsRequested" INTEGER NOT NULL,
    "monthsCovered" INTEGER NOT NULL DEFAULT 0,
    "normalized" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."intelligence_findings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "runId" UUID,
    "kind" "intelligence"."FindingKind" NOT NULL,
    "severity" "intelligence"."FindingSeverity" NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intelligence_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_runs_tenantId_clientId_source_idx" ON "intelligence"."ingestion_runs"("tenantId", "clientId", "source");

-- CreateIndex
CREATE INDEX "intelligence_findings_tenantId_clientId_kind_idx" ON "intelligence"."intelligence_findings"("tenantId", "clientId", "kind");

-- AddForeignKey
ALTER TABLE "intelligence"."intelligence_findings" ADD CONSTRAINT "intelligence_findings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "intelligence"."ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
