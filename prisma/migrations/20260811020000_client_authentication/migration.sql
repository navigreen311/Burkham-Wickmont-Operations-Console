-- CreateTable
CREATE TABLE "identity"."client_users" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "lastSignInAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."client_invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "client_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."client_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_users_tenantId_clientId_idx" ON "identity"."client_users"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "client_users_tenantId_email_key" ON "identity"."client_users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "client_invitations_tokenHash_key" ON "identity"."client_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "client_invitations_tenantId_clientUserId_idx" ON "identity"."client_invitations"("tenantId", "clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "client_sessions_tokenHash_key" ON "identity"."client_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "client_sessions_tenantId_clientUserId_idx" ON "identity"."client_sessions"("tenantId", "clientUserId");

-- AddForeignKey
ALTER TABLE "identity"."client_invitations" ADD CONSTRAINT "client_invitations_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."client_sessions" ADD CONSTRAINT "client_sessions_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "identity"."client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

