-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "evidence";

-- CreateEnum
CREATE TYPE "evidence"."EvidenceScope" AS ENUM ('client', 'engagement');

-- CreateTable
CREATE TABLE "evidence"."evidence_exports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" "evidence"."EvidenceScope" NOT NULL,
    "clientId" UUID NOT NULL,
    "engagementId" UUID,
    "purpose" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "coverage" JSONB NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_exports_tenantId_clientId_exportedAt_idx" ON "evidence"."evidence_exports"("tenantId", "clientId", "exportedAt");
