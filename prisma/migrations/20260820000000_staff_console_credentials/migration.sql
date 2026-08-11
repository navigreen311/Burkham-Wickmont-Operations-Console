-- CreateTable
CREATE TABLE "identity"."actor_credentials" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecretCiphertext" TEXT,
    "totpLastUsedStep" BIGINT,
    "enrolledAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastSignInAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actor_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."actor_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "actor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "actor_credentials_actorId_key" ON "identity"."actor_credentials"("actorId");

-- CreateIndex
CREATE INDEX "actor_credentials_tenantId_idx" ON "identity"."actor_credentials"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "actor_credentials_tenantId_email_key" ON "identity"."actor_credentials"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "actor_sessions_tokenHash_key" ON "identity"."actor_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "actor_sessions_tenantId_actorId_idx" ON "identity"."actor_sessions"("tenantId", "actorId");

-- AddForeignKey
ALTER TABLE "identity"."actor_credentials" ADD CONSTRAINT "actor_credentials_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "identity"."actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."actor_sessions" ADD CONSTRAINT "actor_sessions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "identity"."actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

