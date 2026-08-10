-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "vault";

-- CreateEnum
CREATE TYPE "vault"."DocumentKind" AS ENUM ('bank_statement', 'tax_return', 'government_id', 'entity_document', 'credit_report', 'profit_and_loss', 'balance_sheet', 'debt_schedule', 'lender_application', 'signed_authorization', 'adverse_action_notice', 'other');

-- CreateEnum
CREATE TYPE "vault"."ScanStatus" AS ENUM ('pending', 'clean', 'infected', 'scan_unavailable');

-- CreateTable
CREATE TABLE "vault"."vault_documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" "vault"."DocumentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "blobKey" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "scanStatus" "vault"."ScanStatus" NOT NULL DEFAULT 'pending',
    "scannedAt" TIMESTAMP(3),
    "scanDetail" TEXT,
    "retainUntil" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "legalHoldReason" TEXT,
    "legalHoldSetAt" TIMESTAMP(3),
    "uploadedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vault_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault"."vault_access_log" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorKind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "reason" TEXT,
    "watermarked" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vault_documents_blobKey_key" ON "vault"."vault_documents"("blobKey");

-- CreateIndex
CREATE INDEX "vault_documents_tenantId_clientId_idx" ON "vault"."vault_documents"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "vault_documents_tenantId_kind_idx" ON "vault"."vault_documents"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "vault_access_log_tenantId_documentId_idx" ON "vault"."vault_access_log"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "vault_access_log_tenantId_actorId_idx" ON "vault"."vault_access_log"("tenantId", "actorId");

-- AddForeignKey
ALTER TABLE "vault"."vault_access_log" ADD CONSTRAINT "vault_access_log_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "vault"."vault_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
