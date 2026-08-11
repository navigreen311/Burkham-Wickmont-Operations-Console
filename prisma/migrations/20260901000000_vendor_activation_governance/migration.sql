-- CreateEnum
CREATE TYPE "admin"."VendorEvidenceKind" AS ENUM ('vendor_selection', 'argus_security_review', 'data_processing_agreement', 'security_attestation');

-- CreateTable
CREATE TABLE "admin"."vendor_evidence" (
    "id" UUID NOT NULL,
    "vendor" TEXT NOT NULL,
    "kind" "admin"."VendorEvidenceKind" NOT NULL,
    "documentReference" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "acceptedBy" UUID NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "acceptedInTenantId" UUID NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnBy" UUID,
    "withdrawnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_evidence_vendor_kind_withdrawnAt_idx" ON "admin"."vendor_evidence"("vendor", "kind", "withdrawnAt");
