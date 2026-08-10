-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "regulatory";

-- CreateEnum
CREATE TYPE "regulatory"."StateChangeKind" AS ENUM ('material', 'editorial');

-- CreateTable
CREATE TABLE "regulatory"."state_modules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "citations" TEXT[],
    "changeKind" "regulatory"."StateChangeKind" NOT NULL,
    "changeRationale" TEXT,
    "marketingNotes" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "state_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory"."state_disclosures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "moduleId" UUID NOT NULL,
    "productKind" TEXT NOT NULL DEFAULT '*',
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_disclosures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory"."counsel_reviews" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "moduleVersion" INTEGER NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "documentReference" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counsel_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory"."state_activations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "activatedModuleVersion" INTEGER NOT NULL,
    "activatedBy" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "counselReviewId" UUID NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnBy" TEXT,
    "withdrawnReason" TEXT,

    CONSTRAINT "state_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory"."state_law_changes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "noticedAt" TIMESTAMP(3) NOT NULL,
    "noticedBy" TEXT NOT NULL,
    "effectiveOn" TIMESTAMP(3),
    "addressedInVersion" INTEGER,
    "addressedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_law_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "state_modules_tenantId_state_supersededAt_idx" ON "regulatory"."state_modules"("tenantId", "state", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "state_modules_tenantId_state_version_key" ON "regulatory"."state_modules"("tenantId", "state", "version");

-- CreateIndex
CREATE INDEX "state_disclosures_tenantId_productKind_idx" ON "regulatory"."state_disclosures"("tenantId", "productKind");

-- CreateIndex
CREATE UNIQUE INDEX "state_disclosures_moduleId_key_productKind_key" ON "regulatory"."state_disclosures"("moduleId", "key", "productKind");

-- CreateIndex
CREATE INDEX "counsel_reviews_tenantId_state_moduleVersion_idx" ON "regulatory"."counsel_reviews"("tenantId", "state", "moduleVersion");

-- CreateIndex
CREATE UNIQUE INDEX "state_activations_tenantId_state_key" ON "regulatory"."state_activations"("tenantId", "state");

-- CreateIndex
CREATE INDEX "state_law_changes_tenantId_state_addressedAt_idx" ON "regulatory"."state_law_changes"("tenantId", "state", "addressedAt");

-- AddForeignKey
ALTER TABLE "regulatory"."state_disclosures" ADD CONSTRAINT "state_disclosures_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "regulatory"."state_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
