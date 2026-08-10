-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "claims";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "deliverables";

-- CreateEnum
CREATE TYPE "claims"."ClaimDisposition" AS ENUM ('approved', 'banned', 'requires_disclaimer');

-- CreateEnum
CREATE TYPE "deliverables"."DeliverableStatus" AS ENUM ('draft', 'qa_checked', 'scanned', 'blocked', 'awaiting_human', 'approved', 'rejected', 'delivered');

-- CreateTable
CREATE TABLE "claims"."marketing_claims" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phrase" TEXT NOT NULL,
    "disposition" "claims"."ClaimDisposition" NOT NULL,
    "rationale" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "requiredDisclosure" TEXT,
    "approvedBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deprecatedAt" TIMESTAMP(3),

    CONSTRAINT "marketing_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverables"."deliverable_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliverable_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverables"."deliverables" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "deliverables"."DeliverableStatus" NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "scanResult" JSONB,
    "scannedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_claims_tenantId_disposition_active_idx" ON "claims"."marketing_claims"("tenantId", "disposition", "active");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_claims_tenantId_phrase_jurisdiction_key" ON "claims"."marketing_claims"("tenantId", "phrase", "jurisdiction");

-- CreateIndex
CREATE UNIQUE INDEX "deliverable_templates_key_version_key" ON "deliverables"."deliverable_templates"("key", "version");

-- CreateIndex
CREATE INDEX "deliverables_tenantId_status_idx" ON "deliverables"."deliverables"("tenantId", "status");

-- CreateIndex
CREATE INDEX "deliverables_tenantId_clientId_idx" ON "deliverables"."deliverables"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "deliverables_clientId_templateKey_version_key" ON "deliverables"."deliverables"("clientId", "templateKey", "version");
