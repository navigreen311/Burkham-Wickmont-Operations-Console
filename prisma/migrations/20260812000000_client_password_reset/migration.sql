-- CreateEnum
CREATE TYPE "identity"."ClientPasswordResetSource" AS ENUM ('self_service', 'staff_assisted');

-- CreateTable
CREATE TABLE "identity"."client_password_resets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "source" "identity"."ClientPasswordResetSource" NOT NULL,
    "issuedBy" UUID,
    "verificationBasis" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "client_password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_password_resets_tokenHash_key" ON "identity"."client_password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "client_password_resets_tenantId_clientUserId_idx" ON "identity"."client_password_resets"("tenantId", "clientUserId");

-- AddForeignKey
ALTER TABLE "identity"."client_password_resets" ADD CONSTRAINT "client_password_resets_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

