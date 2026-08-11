-- CreateEnum
CREATE TYPE "risk"."AlertTier" AS ENUM ('yellow', 'orange', 'red');

-- CreateEnum
CREATE TYPE "risk"."AlertState" AS ENUM ('open', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "admin"."CostSource" AS ENUM ('model_api', 'voice_minutes', 'document_processing', 'plaid', 'business_bureau', 'personal_credit');

-- CreateEnum
CREATE TYPE "admin"."CostProvenance" AS ENUM ('observed', 'vendor_invoice');

-- CreateEnum
CREATE TYPE "interventure"."OpportunityKind" AS ENUM ('payroll_float', 'emd_or_marketing_capital', 'project_funding', 'advisor_or_client_acquisition', 'shared_vendor_financing', 'insurance_premium_financing', 'tax_reserve_planning');

-- CreateEnum
CREATE TYPE "interventure"."OpportunityState" AS ENUM ('detected', 'gardner_approved', 'gardner_declined', 'routed', 'dismissed');

-- CreateTable
CREATE TABLE "risk"."risk_alerts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "tier" "risk"."AlertTier" NOT NULL,
    "state" "risk"."AlertState" NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedBy" UUID,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "risk_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."cost_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID,
    "actorId" UUID,
    "source" "admin"."CostSource" NOT NULL,
    "provenance" "admin"."CostProvenance" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "units" INTEGER,
    "unitKind" TEXT,
    "vendorRef" TEXT,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventure"."cross_portfolio_opportunities" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "venture" TEXT NOT NULL,
    "clientId" UUID,
    "kind" "interventure"."OpportunityKind" NOT NULL,
    "state" "interventure"."OpportunityState" NOT NULL DEFAULT 'detected',
    "summary" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "gardnerDecidedBy" TEXT,
    "gardnerDecidedAt" TIMESTAMP(3),
    "gardnerNote" TEXT,
    "routedAt" TIMESTAMP(3),
    "routedToDepartment" TEXT,
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cross_portfolio_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "risk_alerts_seq_key" ON "risk"."risk_alerts"("seq");

-- CreateIndex
CREATE INDEX "risk_alerts_tenantId_clientId_state_tier_idx" ON "risk"."risk_alerts"("tenantId", "clientId", "state", "tier");

-- CreateIndex
CREATE INDEX "cost_records_tenantId_occurredOn_idx" ON "admin"."cost_records"("tenantId", "occurredOn");

-- CreateIndex
CREATE INDEX "cost_records_tenantId_clientId_occurredOn_idx" ON "admin"."cost_records"("tenantId", "clientId", "occurredOn");

-- CreateIndex
CREATE INDEX "cost_records_tenantId_source_occurredOn_idx" ON "admin"."cost_records"("tenantId", "source", "occurredOn");

-- CreateIndex
CREATE INDEX "cross_portfolio_opportunities_tenantId_state_detectedAt_idx" ON "interventure"."cross_portfolio_opportunities"("tenantId", "state", "detectedAt");

-- CreateIndex
CREATE INDEX "cross_portfolio_opportunities_tenantId_clientId_idx" ON "interventure"."cross_portfolio_opportunities"("tenantId", "clientId");
