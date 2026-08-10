-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "partners";

-- CreateEnum
CREATE TYPE "partners"."PartnerStatus" AS ENUM ('applied', 'onboarding', 'active', 'suspended', 'terminated');

-- CreateEnum
CREATE TYPE "partners"."BrandArrangement" AS ENUM ('co_brand', 'white_label');

-- AlterEnum
ALTER TYPE "consent"."ConsentKind" ADD VALUE 'partner_status_visibility';

-- AlterTable
ALTER TABLE "sales"."attribution_corrections" ADD COLUMN     "fromReferrerPartnerId" UUID,
ADD COLUMN     "toReferrerPartnerId" UUID;

-- AlterTable
ALTER TABLE "sales"."leads" ADD COLUMN     "referrerPartnerId" UUID;

-- CreateTable
CREATE TABLE "partners"."partners" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "status" "partners"."PartnerStatus" NOT NULL DEFAULT 'applied',
    "qualificationsRecorded" TEXT[],
    "onboardedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "terminatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_curriculum_modules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "requiredForTracks" TEXT[],
    "materialReference" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" UUID NOT NULL,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "partner_curriculum_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_module_completions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "moduleId" UUID NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" UUID NOT NULL,

    CONSTRAINT "partner_module_completions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_claim_approvals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" UUID NOT NULL,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "partner_claim_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_brand_configs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "arrangement" "partners"."BrandArrangement" NOT NULL,
    "presentedName" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "brandRules" TEXT[],
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" UUID NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "partner_brand_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partners_tenantId_status_idx" ON "partners"."partners"("tenantId", "status");

-- CreateIndex
CREATE INDEX "partners_tenantId_track_idx" ON "partners"."partners"("tenantId", "track");

-- CreateIndex
CREATE INDEX "partner_curriculum_modules_tenantId_key_idx" ON "partners"."partner_curriculum_modules"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "partner_curriculum_modules_tenantId_key_version_key" ON "partners"."partner_curriculum_modules"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "partner_module_completions_tenantId_partnerId_idx" ON "partners"."partner_module_completions"("tenantId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_module_completions_partnerId_moduleId_key" ON "partners"."partner_module_completions"("partnerId", "moduleId");

-- CreateIndex
CREATE INDEX "partner_claim_approvals_tenantId_partnerId_idx" ON "partners"."partner_claim_approvals"("tenantId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_claim_approvals_partnerId_claimId_key" ON "partners"."partner_claim_approvals"("partnerId", "claimId");

-- CreateIndex
CREATE INDEX "partner_brand_configs_tenantId_partnerId_idx" ON "partners"."partner_brand_configs"("tenantId", "partnerId");

-- CreateIndex
CREATE INDEX "attribution_corrections_tenantId_toReferrerPartnerId_idx" ON "sales"."attribution_corrections"("tenantId", "toReferrerPartnerId");

-- CreateIndex
CREATE INDEX "leads_tenantId_referrerPartnerId_idx" ON "sales"."leads"("tenantId", "referrerPartnerId");

-- AddForeignKey
ALTER TABLE "partners"."partner_module_completions" ADD CONSTRAINT "partner_module_completions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_module_completions" ADD CONSTRAINT "partner_module_completions_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "partners"."partner_curriculum_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_claim_approvals" ADD CONSTRAINT "partner_claim_approvals_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_brand_configs" ADD CONSTRAINT "partner_brand_configs_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

