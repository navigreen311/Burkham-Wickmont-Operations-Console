-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "governance";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "lenders";

-- CreateEnum
CREATE TYPE "lenders"."ProviderKind" AS ENUM ('card_issuer', 'national_bank', 'fintech_loc', 'credit_union', 'mca_provider', 'factor', 'equipment_lessor', 'sba_lender');

-- CreateEnum
CREATE TYPE "lenders"."ProductKind" AS ENUM ('business_credit_card', 'line_of_credit', 'term_loan', 'merchant_cash_advance', 'invoice_factoring', 'equipment_finance', 'sba_loan');

-- CreateEnum
CREATE TYPE "lenders"."ProvenanceTag" AS ENUM ('issuer_rule', 'unresearched_default', 'vendor_feed');

-- CreateEnum
CREATE TYPE "lenders"."AppetiteSignalValue" AS ENUM ('expanding', 'steady', 'tightening', 'paused');

-- CreateEnum
CREATE TYPE "lenders"."PlacementOutcome" AS ENUM ('approved', 'declined', 'withdrawn', 'funded', 'failed_to_fund');

-- CreateEnum
CREATE TYPE "lenders"."ResearchStatus" AS ENUM ('not_started', 'in_progress', 'blocked', 'complete');

-- CreateEnum
CREATE TYPE "governance"."GovernanceStatus" AS ENUM ('pending_review', 'approved', 'under_review', 'suspended', 'blacklisted');

-- CreateEnum
CREATE TYPE "governance"."ComplaintSeverity" AS ENUM ('low', 'moderate', 'severe');

-- CreateTable
CREATE TABLE "lenders"."providers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "lenders"."ProviderKind" NOT NULL,
    "statesServed" TEXT[],
    "brokerRulesSummary" TEXT,
    "disclosureRequirements" TEXT[],
    "knownRisks" TEXT[],
    "renewalBehavior" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."lender_rules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleValue" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "provenanceTag" "lenders"."ProvenanceTag" NOT NULL,
    "sourceUrl" TEXT,
    "lastVerified" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "rationale" TEXT,
    "vendor" TEXT,
    "retrievedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lender_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."product_offerings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "productKind" "lenders"."ProductKind" NOT NULL,
    "minAmount" DECIMAL(14,2) NOT NULL,
    "maxAmount" DECIMAL(14,2) NOT NULL,
    "minTimeInBusinessMonths" INTEGER,
    "minAnnualRevenue" DECIMAL(14,2),
    "minPersonalCreditScore" INTEGER,
    "excludedIndustries" TEXT[],
    "repaymentStructure" TEXT NOT NULL,
    "feeModel" TEXT NOT NULL,
    "typicalAnnualRate" DECIMAL(8,6),
    "typicalFactorRate" DECIMAL(6,4),
    "provenanceTag" "lenders"."ProvenanceTag" NOT NULL,
    "sourceUrl" TEXT,
    "lastVerified" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "rationale" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."appetite_signals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "signal" "lenders"."AppetiteSignalValue" NOT NULL,
    "note" TEXT NOT NULL,
    "observedBy" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appetite_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."lender_outcomes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "productKind" "lenders"."ProductKind" NOT NULL,
    "clientProfileKey" TEXT NOT NULL,
    "outcome" "lenders"."PlacementOutcome" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lender_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."provider_contacts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lenders"."research_workstreams" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerName" TEXT NOT NULL,
    "kind" "lenders"."ProviderKind" NOT NULL,
    "status" "lenders"."ResearchStatus" NOT NULL DEFAULT 'not_started',
    "assignedTo" TEXT,
    "targetCompletionDate" TIMESTAMP(3),
    "notes" TEXT,
    "promotedProviderId" UUID,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_workstreams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."provider_governance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" "governance"."GovernanceStatus" NOT NULL DEFAULT 'pending_review',
    "lastReviewedAt" TIMESTAMP(3),
    "reviewCadenceDays" INTEGER NOT NULL DEFAULT 90,
    "approvedStates" TEXT[],
    "restrictedStates" TEXT[],
    "requiredDisclosures" TEXT[],
    "referralAgreementRef" TEXT,
    "reputationRiskNotes" TEXT,
    "complaintCount" INTEGER NOT NULL DEFAULT 0,
    "complaintWindowStart" TIMESTAMP(3),
    "blacklistReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_governance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."governance_decisions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "fromStatus" "governance"."GovernanceStatus",
    "toStatus" "governance"."GovernanceStatus" NOT NULL,
    "rationale" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governance_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."provider_complaints" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "severity" "governance"."ComplaintSeverity" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_complaints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "providers_tenantId_kind_active_idx" ON "lenders"."providers"("tenantId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "providers_tenantId_name_key" ON "lenders"."providers"("tenantId", "name");

-- CreateIndex
CREATE INDEX "lender_rules_tenantId_providerId_supersededAt_idx" ON "lenders"."lender_rules"("tenantId", "providerId", "supersededAt");

-- CreateIndex
CREATE INDEX "lender_rules_tenantId_provenanceTag_idx" ON "lenders"."lender_rules"("tenantId", "provenanceTag");

-- CreateIndex
CREATE UNIQUE INDEX "lender_rules_providerId_ruleKey_version_key" ON "lenders"."lender_rules"("providerId", "ruleKey", "version");

-- CreateIndex
CREATE INDEX "product_offerings_tenantId_productKind_active_idx" ON "lenders"."product_offerings"("tenantId", "productKind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_offerings_providerId_name_key" ON "lenders"."product_offerings"("providerId", "name");

-- CreateIndex
CREATE INDEX "appetite_signals_tenantId_providerId_observedAt_idx" ON "lenders"."appetite_signals"("tenantId", "providerId", "observedAt");

-- CreateIndex
CREATE INDEX "lender_outcomes_tenantId_providerId_productKind_idx" ON "lenders"."lender_outcomes"("tenantId", "providerId", "productKind");

-- CreateIndex
CREATE INDEX "lender_outcomes_tenantId_clientProfileKey_idx" ON "lenders"."lender_outcomes"("tenantId", "clientProfileKey");

-- CreateIndex
CREATE INDEX "provider_contacts_tenantId_providerId_idx" ON "lenders"."provider_contacts"("tenantId", "providerId");

-- CreateIndex
CREATE INDEX "research_workstreams_tenantId_status_idx" ON "lenders"."research_workstreams"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "research_workstreams_tenantId_providerName_key" ON "lenders"."research_workstreams"("tenantId", "providerName");

-- CreateIndex
CREATE INDEX "provider_governance_tenantId_status_idx" ON "governance"."provider_governance"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_governance_tenantId_providerId_key" ON "governance"."provider_governance"("tenantId", "providerId");

-- CreateIndex
CREATE INDEX "governance_decisions_tenantId_providerId_decidedAt_idx" ON "governance"."governance_decisions"("tenantId", "providerId", "decidedAt");

-- CreateIndex
CREATE INDEX "provider_complaints_tenantId_providerId_receivedAt_idx" ON "governance"."provider_complaints"("tenantId", "providerId", "receivedAt");

-- AddForeignKey
ALTER TABLE "lenders"."lender_rules" ADD CONSTRAINT "lender_rules_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "lenders"."providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lenders"."product_offerings" ADD CONSTRAINT "product_offerings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "lenders"."providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lenders"."appetite_signals" ADD CONSTRAINT "appetite_signals_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "lenders"."providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lenders"."lender_outcomes" ADD CONSTRAINT "lender_outcomes_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "lenders"."providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lenders"."provider_contacts" ADD CONSTRAINT "provider_contacts_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "lenders"."providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
