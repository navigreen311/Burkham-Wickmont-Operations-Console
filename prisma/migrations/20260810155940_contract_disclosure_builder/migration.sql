-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "contracts";

-- CreateEnum
CREATE TYPE "contracts"."ContractKind" AS ENUM ('service_agreement', 'fee_exhibit', 'application_authorization', 'bureau_pull_authorization', 'plaid_connection_authorization', 'refund_policy', 'partner_disclosure', 'product_disclosure');

-- CreateEnum
CREATE TYPE "contracts"."TemplateChangeKind" AS ENUM ('material', 'editorial');

-- CreateTable
CREATE TABLE "contracts"."contract_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "contracts"."ContractKind" NOT NULL,
    "title" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "changeKind" "contracts"."TemplateChangeKind" NOT NULL,
    "changeRationale" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts"."template_reviews" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "documentReference" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts"."clauses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT '*',
    "appliesToTiers" TEXT[],
    "appliesToChannels" TEXT[],
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "clauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts"."generated_contracts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" "contracts"."ContractKind" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "stateModuleVersion" INTEGER NOT NULL,
    "offerTier" TEXT,
    "channel" TEXT,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "clauseKeys" TEXT[],
    "disclosureKeys" TEXT[],
    "generatedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_templates_tenantId_key_supersededAt_idx" ON "contracts"."contract_templates"("tenantId", "key", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "contract_templates_tenantId_key_version_key" ON "contracts"."contract_templates"("tenantId", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "template_reviews_tenantId_templateKey_templateVersion_key" ON "contracts"."template_reviews"("tenantId", "templateKey", "templateVersion");

-- CreateIndex
CREATE INDEX "clauses_tenantId_jurisdiction_supersededAt_idx" ON "contracts"."clauses"("tenantId", "jurisdiction", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "clauses_tenantId_key_jurisdiction_version_key" ON "contracts"."clauses"("tenantId", "key", "jurisdiction", "version");

-- CreateIndex
CREATE INDEX "generated_contracts_tenantId_clientId_kind_idx" ON "contracts"."generated_contracts"("tenantId", "clientId", "kind");

-- CreateIndex
CREATE INDEX "generated_contracts_tenantId_state_stateModuleVersion_idx" ON "contracts"."generated_contracts"("tenantId", "state", "stateModuleVersion");
