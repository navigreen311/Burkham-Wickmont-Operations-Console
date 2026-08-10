-- CreateEnum
CREATE TYPE "sales"."RenewalStatus" AS ENUM ('not_due', 'approaching', 'at_risk', 'renewed', 'lapsed');

-- CreateTable
CREATE TABLE "sales"."readiness_readings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "readiness" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "takenOn" TIMESTAMP(3) NOT NULL,
    "takenBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readiness_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "readiness_readings_tenantId_leadId_takenOn_idx" ON "sales"."readiness_readings"("tenantId", "leadId", "takenOn");
