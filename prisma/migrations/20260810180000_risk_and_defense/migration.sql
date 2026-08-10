-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "risk";

-- CreateEnum
CREATE TYPE "risk"."DoNotFundStatus" AS ENUM ('listed', 'removed');

-- CreateEnum
CREATE TYPE "risk"."DoNotFundTrigger" AS ENUM ('compliance_fail', 'fraud_indicator', 'material_misrepresentation', 'repeated_default', 'regulatory_action', 'client_conduct', 'other');

-- CreateTable
CREATE TABLE "risk"."do_not_fund_listings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "status" "risk"."DoNotFundStatus" NOT NULL DEFAULT 'listed',
    "trigger" "risk"."DoNotFundTrigger" NOT NULL,
    "justification" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "listedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listedBy" UUID,
    "reviewCadenceDays" INTEGER NOT NULL DEFAULT 90,
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedBy" UUID,
    "removedAt" TIMESTAMP(3),
    "removedBy" UUID,
    "removalJustification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "do_not_fund_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk"."do_not_fund_overrides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "approvedBy" UUID NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "do_not_fund_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk"."risk_observations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" UUID NOT NULL,

    CONSTRAINT "risk_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "do_not_fund_listings_tenantId_clientId_status_idx" ON "risk"."do_not_fund_listings"("tenantId", "clientId", "status");

-- CreateIndex
CREATE INDEX "do_not_fund_overrides_tenantId_listingId_consumedAt_idx" ON "risk"."do_not_fund_overrides"("tenantId", "listingId", "consumedAt");

-- CreateIndex
CREATE INDEX "risk_observations_tenantId_clientId_occurredAt_idx" ON "risk"."risk_observations"("tenantId", "clientId", "occurredAt");

-- AddForeignKey
ALTER TABLE "risk"."do_not_fund_overrides" ADD CONSTRAINT "do_not_fund_overrides_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "risk"."do_not_fund_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

