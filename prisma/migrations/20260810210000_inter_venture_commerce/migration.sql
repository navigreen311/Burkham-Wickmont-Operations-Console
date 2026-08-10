-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "interventure";

-- CreateEnum
CREATE TYPE "interventure"."DisclosureState" AS ENUM ('drafted', 'venture_acknowledged', 'fully_acknowledged', 'withdrawn');

-- CreateEnum
CREATE TYPE "interventure"."DeviationDirection" AS ENUM ('discount', 'premium');

-- CreateEnum
CREATE TYPE "interventure"."HandoffState" AS ENUM ('proposed', 'consented', 'transferred', 'declined');

-- CreateEnum
CREATE TYPE "interventure"."InvoiceState" AS ENUM ('drafted', 'routed_pending', 'settled');

-- CreateTable
CREATE TABLE "interventure"."venture_relationships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "ventureKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "detectionBasis" TEXT NOT NULL,
    "gardnerVisible" BOOLEAN NOT NULL,
    "taggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venture_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventure"."conflict_disclosures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "relationshipId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "state" "interventure"."DisclosureState" NOT NULL DEFAULT 'drafted',
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ventureAcknowledgedBy" TEXT,
    "ventureAcknowledgedAt" TIMESTAMP(3),
    "ventureRepresentative" TEXT,
    "gardnerAcknowledgedBy" UUID,
    "gardnerAcknowledgedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,

    CONSTRAINT "conflict_disclosures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventure"."pricing_deviations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "ventureKey" TEXT NOT NULL,
    "offerKey" TEXT NOT NULL,
    "publishedCents" INTEGER NOT NULL,
    "chargedCents" INTEGER NOT NULL,
    "direction" "interventure"."DeviationDirection" NOT NULL,
    "deviationBasisPoints" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "approvedBy" UUID NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_deviations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventure"."cross_portfolio_handoffs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "state" "interventure"."HandoffState" NOT NULL DEFAULT 'proposed',
    "observation" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "proposedBy" UUID NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentId" UUID,
    "transferredAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declinedReason" TEXT,

    CONSTRAINT "cross_portfolio_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventure"."intercompany_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "relationshipId" UUID NOT NULL,
    "engagementId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "state" "interventure"."InvoiceState" NOT NULL DEFAULT 'drafted',
    "gardnerLedgerReference" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raisedBy" UUID NOT NULL,

    CONSTRAINT "intercompany_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venture_relationships_tenantId_ventureKey_idx" ON "interventure"."venture_relationships"("tenantId", "ventureKey");

-- CreateIndex
CREATE UNIQUE INDEX "venture_relationships_tenantId_clientId_key" ON "interventure"."venture_relationships"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "conflict_disclosures_tenantId_state_idx" ON "interventure"."conflict_disclosures"("tenantId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "conflict_disclosures_tenantId_engagementId_key" ON "interventure"."conflict_disclosures"("tenantId", "engagementId");

-- CreateIndex
CREATE INDEX "pricing_deviations_tenantId_clientId_idx" ON "interventure"."pricing_deviations"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "cross_portfolio_handoffs_tenantId_clientId_state_idx" ON "interventure"."cross_portfolio_handoffs"("tenantId", "clientId", "state");

-- CreateIndex
CREATE INDEX "intercompany_invoices_tenantId_engagementId_idx" ON "interventure"."intercompany_invoices"("tenantId", "engagementId");

-- AddForeignKey
ALTER TABLE "interventure"."conflict_disclosures" ADD CONSTRAINT "conflict_disclosures_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "interventure"."venture_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventure"."intercompany_invoices" ADD CONSTRAINT "intercompany_invoices_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "interventure"."venture_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

