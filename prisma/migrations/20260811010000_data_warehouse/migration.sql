-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "warehouse";

-- CreateTable
CREATE TABLE "warehouse"."analytics_snapshots" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "asOf" DATE NOT NULL,
    "facts" JSONB NOT NULL,
    "gaps" TEXT[],
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedBy" UUID NOT NULL,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse"."subject_snapshots" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "complianceState" TEXT NOT NULL,
    "engaged" BOOLEAN NOT NULL,
    "billedToDateCents" INTEGER NOT NULL,

    CONSTRAINT "subject_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_snapshots_tenantId_asOf_idx" ON "warehouse"."analytics_snapshots"("tenantId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_tenantId_asOf_key" ON "warehouse"."analytics_snapshots"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "subject_snapshots_tenantId_subjectKey_idx" ON "warehouse"."subject_snapshots"("tenantId", "subjectKey");

-- CreateIndex
CREATE INDEX "subject_snapshots_tenantId_cohort_idx" ON "warehouse"."subject_snapshots"("tenantId", "cohort");

-- CreateIndex
CREATE UNIQUE INDEX "subject_snapshots_snapshotId_subjectKey_key" ON "warehouse"."subject_snapshots"("snapshotId", "subjectKey");

-- AddForeignKey
ALTER TABLE "warehouse"."subject_snapshots" ADD CONSTRAINT "subject_snapshots_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "warehouse"."analytics_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

