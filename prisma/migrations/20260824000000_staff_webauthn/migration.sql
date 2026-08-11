-- CreateEnum
CREATE TYPE "identity"."ActorWebauthnCeremony" AS ENUM ('registration', 'authentication');

-- AlterTable
ALTER TABLE "identity"."actor_credentials" ADD COLUMN     "passwordSignInDisabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "identity"."actor_webauthn_credentials" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT,
    "label" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "clonedAt" TIMESTAMP(3),

    CONSTRAINT "actor_webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."actor_webauthn_challenges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID,
    "challenge" TEXT NOT NULL,
    "ceremony" "identity"."ActorWebauthnCeremony" NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "actor_webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "actor_webauthn_credentials_credentialId_key" ON "identity"."actor_webauthn_credentials"("credentialId");

-- CreateIndex
CREATE INDEX "actor_webauthn_credentials_tenantId_actorId_idx" ON "identity"."actor_webauthn_credentials"("tenantId", "actorId");

-- CreateIndex
CREATE UNIQUE INDEX "actor_webauthn_challenges_challenge_key" ON "identity"."actor_webauthn_challenges"("challenge");

-- CreateIndex
CREATE INDEX "actor_webauthn_challenges_tenantId_actorId_idx" ON "identity"."actor_webauthn_challenges"("tenantId", "actorId");

-- AddForeignKey
ALTER TABLE "identity"."actor_webauthn_credentials" ADD CONSTRAINT "actor_webauthn_credentials_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "identity"."actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."actor_webauthn_challenges" ADD CONSTRAINT "actor_webauthn_challenges_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "identity"."actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
