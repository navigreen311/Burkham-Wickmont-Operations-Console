-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "admin";

-- CreateTable
CREATE TABLE "admin"."configuration_changes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "previousValue" DOUBLE PRECISION NOT NULL,
    "newValue" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "changedBy" UUID NOT NULL,
    "staged" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "promotedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configuration_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "configuration_changes_tenantId_key_appliedAt_idx" ON "admin"."configuration_changes"("tenantId", "key", "appliedAt");

-- CreateIndex
CREATE INDEX "configuration_changes_tenantId_appliedAt_idx" ON "admin"."configuration_changes"("tenantId", "appliedAt");

