-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "billing";

-- CreateEnum
CREATE TYPE "billing"."EngagementStatus" AS ENUM ('active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "billing"."BillingRecordKind" AS ENUM ('charge', 'payment', 'refund', 'credit_applied');

-- CreateEnum
CREATE TYPE "billing"."RefundDisposition" AS ENUM ('paid', 'declined');

-- CreateTable
CREATE TABLE "billing"."offer_definitions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "rung" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "retainerCents" INTEGER NOT NULL,
    "monthlyCents" INTEGER NOT NULL DEFAULT 0,
    "successFeeBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "minimumCents" INTEGER NOT NULL DEFAULT 0,
    "committedMonths" INTEGER NOT NULL DEFAULT 0,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "offer_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."engagements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "status" "billing"."EngagementStatus" NOT NULL DEFAULT 'active',
    "startedOn" TIMESTAMP(3) NOT NULL,
    "committedThrough" TIMESTAMP(3),
    "annualPrepay" BOOLEAN NOT NULL DEFAULT false,
    "cancelledOn" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."billing_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "kind" "billing"."BillingRecordKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "approvedCreditLimitCents" INTEGER,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "billing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."credit_applications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceRecordId" UUID NOT NULL,
    "toEngagementId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "appliedOn" TIMESTAMP(3) NOT NULL,
    "appliedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."refund_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "disposition" "billing"."RefundDisposition" NOT NULL,
    "declineReason" TEXT,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."funding_outcomes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "approvedCreditLimitCents" INTEGER NOT NULL,
    "approvedOn" TIMESTAMP(3) NOT NULL,
    "fundedOn" TIMESTAMP(3),
    "fundedCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_definitions_tenantId_key_supersededAt_idx" ON "billing"."offer_definitions"("tenantId", "key", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "offer_definitions_tenantId_key_version_key" ON "billing"."offer_definitions"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "engagements_tenantId_clientId_status_idx" ON "billing"."engagements"("tenantId", "clientId", "status");

-- CreateIndex
CREATE INDEX "billing_records_tenantId_engagementId_kind_idx" ON "billing"."billing_records"("tenantId", "engagementId", "kind");

-- CreateIndex
CREATE INDEX "credit_applications_tenantId_sourceRecordId_idx" ON "billing"."credit_applications"("tenantId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "credit_applications_tenantId_toEngagementId_idx" ON "billing"."credit_applications"("tenantId", "toEngagementId");

-- CreateIndex
CREATE INDEX "refund_records_tenantId_engagementId_idx" ON "billing"."refund_records"("tenantId", "engagementId");

-- CreateIndex
CREATE INDEX "funding_outcomes_tenantId_engagementId_idx" ON "billing"."funding_outcomes"("tenantId", "engagementId");

-- AddForeignKey
ALTER TABLE "billing"."engagements" ADD CONSTRAINT "engagements_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "billing"."offer_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."billing_records" ADD CONSTRAINT "billing_records_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "billing"."engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."credit_applications" ADD CONSTRAINT "credit_applications_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "billing"."billing_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
