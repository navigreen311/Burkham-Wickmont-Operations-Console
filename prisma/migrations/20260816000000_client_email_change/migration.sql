-- CreateEnum
CREATE TYPE "identity"."ClientEmailChangeSource" AS ENUM ('self_service', 'staff_assisted');

-- CreateEnum
CREATE TYPE "identity"."ClientEmailVerification" AS ENUM ('email', 'staff_assertion');

-- CreateTable
CREATE TABLE "identity"."client_email_changes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "newEmail" TEXT NOT NULL,
    "previousEmail" TEXT,
    "tokenHash" TEXT NOT NULL,
    "source" "identity"."ClientEmailChangeSource" NOT NULL,
    "verifiedBy" "identity"."ClientEmailVerification",
    "requestedBy" UUID,
    "verificationBasis" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,

    CONSTRAINT "client_email_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_email_changes_tokenHash_key" ON "identity"."client_email_changes"("tokenHash");

-- CreateIndex
CREATE INDEX "client_email_changes_tenantId_clientUserId_idx" ON "identity"."client_email_changes"("tenantId", "clientUserId");

-- AddForeignKey
ALTER TABLE "identity"."client_email_changes" ADD CONSTRAINT "client_email_changes_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

