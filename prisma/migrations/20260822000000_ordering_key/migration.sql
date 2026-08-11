-- The ordering key - ADR-0040, finishing what ADR-0034 named and left open.
--
-- Four tables get a monotonic `seq` from a Postgres sequence, because on each of them a reader
-- relies on insertion order and the previous tie-break could not carry it: `{ id: 'asc' }` behind a
-- millisecond timestamp is a random UUID, which makes a result stable for a given set of rows and
-- unrelated to the order they arrived in.
--
-- ON THE BACKFILL. `ADD COLUMN ... BIGSERIAL` assigns values to existing rows in heap order. Heap
-- order is roughly insertion order and is not guaranteed to be - a row updated in place can move -
-- so taking it would silently invent an ordering for history and present it with the same
-- confidence as one this column actually recorded. Each table is therefore re-numbered below in
-- exactly the order its read already returned before this migration: business timestamp, then id.
--
-- That is the honest ceiling. **Pre-existing rows that tie on the timestamp still have no recorded
-- order** - the information was never written down and no migration can recover it. What this buys
-- is that the migration does not *change* any order the system had already shown, and that every
-- row written from now on has a real one.
--
-- The re-numbering is a no-op on an empty database, which is where this migration is verified.

-- DropIndex
DROP INDEX "identity"."client_mfa_factors_tenantId_clientUserId_idx";

-- DropIndex
DROP INDEX "risk"."risk_observations_tenantId_clientId_occurredAt_idx";

-- DropIndex
DROP INDEX "sales"."lead_activities_tenantId_leadId_occurredAt_idx";

-- DropIndex
DROP INDEX "vault"."vault_access_log_tenantId_documentId_idx";

-- AlterTable
ALTER TABLE "identity"."client_mfa_factors" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "risk"."risk_observations" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "sales"."lead_activities" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "vault"."vault_access_log" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- Backfill: re-number in the order each table's read already returned.
WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS rn
  FROM "identity"."client_mfa_factors"
)
UPDATE "identity"."client_mfa_factors" t
SET "seq" = ordered.rn
FROM ordered
WHERE t."id" = ordered."id";

SELECT setval(
  pg_get_serial_sequence('identity.client_mfa_factors', 'seq'),
  GREATEST((SELECT max("seq") FROM "identity"."client_mfa_factors"), 1)
);

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "occurredAt", "id") AS rn
  FROM "risk"."risk_observations"
)
UPDATE "risk"."risk_observations" t
SET "seq" = ordered.rn
FROM ordered
WHERE t."id" = ordered."id";

SELECT setval(
  pg_get_serial_sequence('risk.risk_observations', 'seq'),
  GREATEST((SELECT max("seq") FROM "risk"."risk_observations"), 1)
);

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "occurredAt", "id") AS rn
  FROM "sales"."lead_activities"
)
UPDATE "sales"."lead_activities" t
SET "seq" = ordered.rn
FROM ordered
WHERE t."id" = ordered."id";

SELECT setval(
  pg_get_serial_sequence('sales.lead_activities', 'seq'),
  GREATEST((SELECT max("seq") FROM "sales"."lead_activities"), 1)
);

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "at", "id") AS rn
  FROM "vault"."vault_access_log"
)
UPDATE "vault"."vault_access_log" t
SET "seq" = ordered.rn
FROM ordered
WHERE t."id" = ordered."id";

SELECT setval(
  pg_get_serial_sequence('vault.vault_access_log', 'seq'),
  GREATEST((SELECT max("seq") FROM "vault"."vault_access_log"), 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "client_mfa_factors_seq_key" ON "identity"."client_mfa_factors"("seq");

-- CreateIndex
CREATE INDEX "client_mfa_factors_tenantId_clientUserId_createdAt_seq_idx" ON "identity"."client_mfa_factors"("tenantId", "clientUserId", "createdAt", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "risk_observations_seq_key" ON "risk"."risk_observations"("seq");

-- CreateIndex
CREATE INDEX "risk_observations_tenantId_clientId_occurredAt_seq_idx" ON "risk"."risk_observations"("tenantId", "clientId", "occurredAt", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "lead_activities_seq_key" ON "sales"."lead_activities"("seq");

-- CreateIndex
CREATE INDEX "lead_activities_tenantId_leadId_occurredAt_seq_idx" ON "sales"."lead_activities"("tenantId", "leadId", "occurredAt", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "vault_access_log_seq_key" ON "vault"."vault_access_log"("seq");

-- CreateIndex
CREATE INDEX "vault_access_log_tenantId_documentId_at_seq_idx" ON "vault"."vault_access_log"("tenantId", "documentId", "at", "seq");
