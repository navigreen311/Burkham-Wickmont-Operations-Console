-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sales";

-- CreateEnum
CREATE TYPE "sales"."LeadStage" AS ENUM ('new_lead', 'qualified', 'blueprint_delivered', 'review_call_scheduled', 'converted', 'closed_lost');

-- CreateEnum
CREATE TYPE "sales"."QualificationStatus" AS ENUM ('unqualified', 'qualified', 'disqualified');

-- CreateEnum
CREATE TYPE "sales"."LostReason" AS ENUM ('price', 'timing', 'not_a_fit', 'went_elsewhere', 'unresponsive', 'compliance_concern', 'client_withdrew', 'other');

-- CreateTable
CREATE TABLE "sales"."leads" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "prospectName" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "stage" "sales"."LeadStage" NOT NULL DEFAULT 'new_lead',
    "qualification" "sales"."QualificationStatus" NOT NULL DEFAULT 'unqualified',
    "qualificationNote" TEXT,
    "sourceChannel" TEXT NOT NULL,
    "referrerName" TEXT,
    "sourceDetail" TEXT,
    "attributedAt" TIMESTAMP(3) NOT NULL,
    "blueprintDeliveredOn" TIMESTAMP(3),
    "blueprintReadiness" INTEGER,
    "reviewCallScheduledFor" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales"."lead_activities" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "fromStage" "sales"."LeadStage",
    "toStage" "sales"."LeadStage",
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales"."attribution_corrections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "fromReferrerName" TEXT,
    "toReferrerName" TEXT,
    "fromSourceChannel" TEXT NOT NULL,
    "toSourceChannel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedBy" TEXT NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales"."lead_outcomes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "converted" BOOLEAN NOT NULL,
    "clientId" UUID,
    "engagementId" UUID,
    "lostReason" "sales"."LostReason",
    "lostDetail" TEXT,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_tenantId_stage_idx" ON "sales"."leads"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "leads_tenantId_lastActivityAt_idx" ON "sales"."leads"("tenantId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "lead_activities_tenantId_leadId_occurredAt_idx" ON "sales"."lead_activities"("tenantId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "attribution_corrections_tenantId_leadId_idx" ON "sales"."attribution_corrections"("tenantId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_outcomes_leadId_key" ON "sales"."lead_outcomes"("leadId");

-- CreateIndex
CREATE INDEX "lead_outcomes_tenantId_converted_idx" ON "sales"."lead_outcomes"("tenantId", "converted");

-- AddForeignKey
ALTER TABLE "sales"."lead_activities" ADD CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "sales"."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"."attribution_corrections" ADD CONSTRAINT "attribution_corrections_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "sales"."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"."lead_outcomes" ADD CONSTRAINT "lead_outcomes_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "sales"."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
