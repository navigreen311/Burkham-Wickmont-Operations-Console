-- CreateTable
CREATE TABLE "identity"."actor_invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "actor_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "actor_invitations_tokenHash_key" ON "identity"."actor_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "actor_invitations_tenantId_actorId_idx" ON "identity"."actor_invitations"("tenantId", "actorId");

-- AddForeignKey
ALTER TABLE "identity"."actor_invitations" ADD CONSTRAINT "actor_invitations_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "identity"."actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

