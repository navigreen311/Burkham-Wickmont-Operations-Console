-- CreateEnum
CREATE TYPE "regulatory"."ReferralFeePosture" AS ENUM ('permitted', 'permitted_with_conditions', 'prohibited');

-- CreateEnum
CREATE TYPE "partners"."PartnerAgreementStatus" AS ENUM ('draft', 'active', 'superseded', 'terminated');

-- CreateEnum
CREATE TYPE "partners"."PayoutStatus" AS ENUM ('pending_approval', 'approved', 'declined');

-- CreateTable
CREATE TABLE "regulatory"."state_referral_fee_rules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "moduleId" UUID NOT NULL,
    "posture" "regulatory"."ReferralFeePosture" NOT NULL,
    "conditions" TEXT[],
    "maxShareBasisPoints" INTEGER,
    "citation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "state_referral_fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_agreements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "shareBasisPoints" INTEGER NOT NULL,
    "termsSummary" TEXT NOT NULL,
    "status" "partners"."PartnerAgreementStatus" NOT NULL DEFAULT 'draft',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "activatedBy" UUID,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "partner_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."partner_payouts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "agreementId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "partners"."PayoutStatus" NOT NULL DEFAULT 'pending_approval',
    "netCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "clawbackCents" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."payout_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "payoutId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "clientId" UUID,
    "state" TEXT NOT NULL,
    "grossFeeCents" INTEGER NOT NULL,
    "appliedBasisPoints" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "rulePosture" "regulatory"."ReferralFeePosture" NOT NULL,
    "ruleCitation" TEXT NOT NULL,
    "ruleConditions" TEXT[],
    "moduleVersion" INTEGER NOT NULL,
    "cappedByState" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."payout_clawbacks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "refundRecordId" UUID,
    "engagementId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "settledByPayoutId" UUID,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "payout_clawbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "state_referral_fee_rules_tenantId_idx" ON "regulatory"."state_referral_fee_rules"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "state_referral_fee_rules_moduleId_key" ON "regulatory"."state_referral_fee_rules"("moduleId");

-- CreateIndex
CREATE INDEX "partner_agreements_tenantId_partnerId_status_idx" ON "partners"."partner_agreements"("tenantId", "partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_agreements_tenantId_partnerId_version_key" ON "partners"."partner_agreements"("tenantId", "partnerId", "version");

-- CreateIndex
CREATE INDEX "partner_payouts_tenantId_partnerId_periodStart_idx" ON "partners"."partner_payouts"("tenantId", "partnerId", "periodStart");

-- CreateIndex
CREATE INDEX "payout_lines_tenantId_payoutId_idx" ON "partners"."payout_lines"("tenantId", "payoutId");

-- CreateIndex
CREATE INDEX "payout_lines_tenantId_leadId_idx" ON "partners"."payout_lines"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "payout_clawbacks_tenantId_partnerId_settledAt_idx" ON "partners"."payout_clawbacks"("tenantId", "partnerId", "settledAt");

-- AddForeignKey
ALTER TABLE "regulatory"."state_referral_fee_rules" ADD CONSTRAINT "state_referral_fee_rules_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "regulatory"."state_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_agreements" ADD CONSTRAINT "partner_agreements_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_payouts" ADD CONSTRAINT "partner_payouts_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."partner_payouts" ADD CONSTRAINT "partner_payouts_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "partners"."partner_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."payout_lines" ADD CONSTRAINT "payout_lines_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "partners"."partner_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."payout_clawbacks" ADD CONSTRAINT "payout_clawbacks_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"."partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
