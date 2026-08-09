-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "clients";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "consent";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "firewall";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ledger";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenancy";

-- CreateEnum
CREATE TYPE "identity"."ActorKind" AS ENUM ('village_agent', 'human');

-- CreateEnum
CREATE TYPE "clients"."ComplianceState" AS ENUM ('pending_assessment', 'pass', 'pass_with_findings', 'needs_review', 'fail');

-- CreateEnum
CREATE TYPE "consent"."ConsentKind" AS ENUM ('application', 'business_bureau_pull', 'personal_credit_pull', 'plaid_connection', 'disclosure', 'cross_portfolio_handoff');

-- CreateEnum
CREATE TYPE "firewall"."FirewallState" AS ENUM ('clear', 'triggered');

-- CreateTable
CREATE TABLE "tenancy"."tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."actors" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "identity"."ActorKind" NOT NULL,
    "label" TEXT NOT NULL,
    "authorityLevel" INTEGER NOT NULL,
    "department" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger"."ledger_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "actorKind" TEXT NOT NULL,
    "clientId" UUID,
    "correlationId" UUID,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients"."clients" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "complianceState" "clients"."ComplianceState" NOT NULL DEFAULT 'pending_assessment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients"."compliance_findings" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "compliance_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent"."consents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" "consent"."ConsentKind" NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall"."client_firewall_states" (
    "clientId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "state" "firewall"."FirewallState" NOT NULL DEFAULT 'clear',
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_firewall_states_pkey" PRIMARY KEY ("clientId")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenancy"."tenants"("slug");

-- CreateIndex
CREATE INDEX "actors_tenantId_idx" ON "identity"."actors"("tenantId");

-- CreateIndex
CREATE INDEX "ledger_events_tenantId_clientId_idx" ON "ledger"."ledger_events"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "ledger_events_tenantId_type_idx" ON "ledger"."ledger_events"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_events_tenantId_seq_key" ON "ledger"."ledger_events"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "clients_tenantId_idx" ON "clients"."clients"("tenantId");

-- CreateIndex
CREATE INDEX "compliance_findings_clientId_idx" ON "clients"."compliance_findings"("clientId");

-- CreateIndex
CREATE INDEX "consents_tenantId_clientId_kind_idx" ON "consent"."consents"("tenantId", "clientId", "kind");

-- CreateIndex
CREATE INDEX "client_firewall_states_tenantId_idx" ON "firewall"."client_firewall_states"("tenantId");

-- AddForeignKey
ALTER TABLE "identity"."actors" ADD CONSTRAINT "actors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenancy"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients"."clients" ADD CONSTRAINT "clients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenancy"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients"."compliance_findings" ADD CONSTRAINT "compliance_findings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"."clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Event Ledger: append-only enforcement (design principle 3, blueprint 11.3)
--
-- "Append-only. Corrections happen as new events (compensating events) rather
--  than mutations. This preserves the audit trail even for mistakes."
--   - Specification v2 section 5.2
--
-- Prisma cannot express "no UPDATE, no DELETE", and a repository that merely
-- declines to expose those methods is a convention that the next ORM call, raw
-- query, or psql session walks straight past. The database is the only place
-- this can be made true, so it is enforced here.
--
-- Deliberately NOT bypassable by the application role. Deleting ledger history
-- requires a superuser dropping the trigger, which is an auditable act rather
-- than an ordinary write.
-- ===========================================================================

CREATE OR REPLACE FUNCTION "ledger".reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger_events is append-only: % rejected. Write a compensating event instead.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_events_no_update
    BEFORE UPDATE ON "ledger"."ledger_events"
    FOR EACH ROW EXECUTE FUNCTION "ledger".reject_mutation();

CREATE TRIGGER ledger_events_no_delete
    BEFORE DELETE ON "ledger"."ledger_events"
    FOR EACH ROW EXECUTE FUNCTION "ledger".reject_mutation();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own statement-level guard.
CREATE TRIGGER ledger_events_no_truncate
    BEFORE TRUNCATE ON "ledger"."ledger_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "ledger".reject_mutation();
