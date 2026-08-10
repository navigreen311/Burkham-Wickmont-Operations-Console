-- CreateEnum
CREATE TYPE "identity"."ClientWebauthnCeremony" AS ENUM ('registration', 'authentication');

-- AlterEnum
ALTER TYPE "identity"."ClientMfaKind" ADD VALUE 'webauthn';

-- AlterTable
ALTER TABLE "identity"."client_mfa_factors" ADD COLUMN     "credentialId" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "publicKey" TEXT,
ADD COLUMN     "signCount" INTEGER,
ADD COLUMN     "transports" TEXT,
ALTER COLUMN "secretCiphertext" DROP NOT NULL;

-- CreateTable
CREATE TABLE "identity"."client_webauthn_challenges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "challenge" TEXT NOT NULL,
    "ceremony" "identity"."ClientWebauthnCeremony" NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "client_webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_webauthn_challenges_challenge_key" ON "identity"."client_webauthn_challenges"("challenge");

-- CreateIndex
CREATE INDEX "client_webauthn_challenges_tenantId_clientUserId_idx" ON "identity"."client_webauthn_challenges"("tenantId", "clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "client_mfa_factors_credentialId_key" ON "identity"."client_mfa_factors"("credentialId");

-- AddForeignKey
ALTER TABLE "identity"."client_webauthn_challenges" ADD CONSTRAINT "client_webauthn_challenges_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

