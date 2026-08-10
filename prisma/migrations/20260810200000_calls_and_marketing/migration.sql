-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "calls";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "marketing";

-- CreateEnum
CREATE TYPE "calls"."CallStatus" AS ENUM ('consent_refused', 'recording', 'captured', 'analysed');

-- CreateEnum
CREATE TYPE "calls"."ObligationStatus" AS ENUM ('open', 'corrected', 'dismissed');

-- CreateEnum
CREATE TYPE "marketing"."CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "marketing"."AssetState" AS ENUM ('draft', 'in_review', 'approved', 'rejected', 'retired');

-- CreateEnum
CREATE TYPE "marketing"."ProposalStatus" AS ENUM ('submitted', 'approved', 'rejected');

-- AlterEnum
ALTER TYPE "consent"."ConsentKind" ADD VALUE 'call_recording';

-- CreateTable
CREATE TABLE "calls"."call_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "status" "calls"."CallStatus" NOT NULL DEFAULT 'recording',
    "jurisdiction" TEXT NOT NULL,
    "clientConsentRequired" BOOLEAN NOT NULL,
    "consentBasis" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "internalParticipants" TEXT[],
    "recordingReference" TEXT,
    "transcript" JSONB,
    "analysedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls"."correction_obligations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "callId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "whyItMatters" TEXT NOT NULL,
    "status" "calls"."ObligationStatus" NOT NULL DEFAULT 'open',
    "owedBy" UUID NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "correctionText" TEXT,
    "correctedAt" TIMESTAMP(3),
    "correctedBy" UUID,
    "dismissalReason" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."campaigns" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "marketing"."CampaignStatus" NOT NULL DEFAULT 'draft',
    "sourceChannel" TEXT NOT NULL,
    "jurisdictions" TEXT[],
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."marketing_assets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "marketing"."AssetState" NOT NULL DEFAULT 'draft',
    "body" TEXT NOT NULL,
    "sourceReference" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" UUID,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "marketing_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."claim_proposals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phrase" TEXT NOT NULL,
    "intendedUse" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "status" "marketing"."ProposalStatus" NOT NULL DEFAULT 'submitted',
    "submittedBy" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedClaimId" UUID,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,

    CONSTRAINT "claim_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."experiments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "winningVariantKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."experiment_variants" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "experimentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "scanVerdict" TEXT NOT NULL,
    "requiredDisclosures" TEXT[],

    CONSTRAINT "experiment_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_records_tenantId_clientId_startedAt_idx" ON "calls"."call_records"("tenantId", "clientId", "startedAt");

-- CreateIndex
CREATE INDEX "call_records_tenantId_status_idx" ON "calls"."call_records"("tenantId", "status");

-- CreateIndex
CREATE INDEX "correction_obligations_tenantId_status_dueAt_idx" ON "calls"."correction_obligations"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "correction_obligations_tenantId_clientId_idx" ON "calls"."correction_obligations"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "campaigns_tenantId_status_idx" ON "marketing"."campaigns"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_tenantId_key_key" ON "marketing"."campaigns"("tenantId", "key");

-- CreateIndex
CREATE INDEX "marketing_assets_tenantId_state_idx" ON "marketing"."marketing_assets"("tenantId", "state");

-- CreateIndex
CREATE INDEX "claim_proposals_tenantId_status_idx" ON "marketing"."claim_proposals"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "experiments_tenantId_key_key" ON "marketing"."experiments"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_variants_experimentId_key_key" ON "marketing"."experiment_variants"("experimentId", "key");

-- AddForeignKey
ALTER TABLE "calls"."correction_obligations" ADD CONSTRAINT "correction_obligations_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"."call_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing"."marketing_assets" ADD CONSTRAINT "marketing_assets_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing"."campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing"."experiments" ADD CONSTRAINT "experiments_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing"."campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing"."experiment_variants" ADD CONSTRAINT "experiment_variants_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "marketing"."experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

