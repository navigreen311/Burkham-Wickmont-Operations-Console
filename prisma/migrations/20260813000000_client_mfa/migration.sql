-- CreateEnum
CREATE TYPE "identity"."ClientMfaKind" AS ENUM ('totp');

-- CreateTable
CREATE TABLE "identity"."client_mfa_factors" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "kind" "identity"."ClientMfaKind" NOT NULL DEFAULT 'totp',
    "secretCiphertext" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" UUID,
    "removalVerificationBasis" TEXT,

    CONSTRAINT "client_mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."client_mfa_challenges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "satisfiedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),

    CONSTRAINT "client_mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."client_recovery_codes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "client_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_mfa_factors_tenantId_clientUserId_idx" ON "identity"."client_mfa_factors"("tenantId", "clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "client_mfa_challenges_tokenHash_key" ON "identity"."client_mfa_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "client_mfa_challenges_tenantId_clientUserId_idx" ON "identity"."client_mfa_challenges"("tenantId", "clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "client_recovery_codes_codeHash_key" ON "identity"."client_recovery_codes"("codeHash");

-- CreateIndex
CREATE INDEX "client_recovery_codes_tenantId_clientUserId_idx" ON "identity"."client_recovery_codes"("tenantId", "clientUserId");

-- AddForeignKey
ALTER TABLE "identity"."client_mfa_factors" ADD CONSTRAINT "client_mfa_factors_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."client_mfa_challenges" ADD CONSTRAINT "client_mfa_challenges_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."client_recovery_codes" ADD CONSTRAINT "client_recovery_codes_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

