-- AlterTable
ALTER TABLE "workflow"."scheduled_workflows" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "workflow"."workflow_triggers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "playbookKey" TEXT NOT NULL,
    "condition" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."workflow_trigger_firings" (
    "id" UUID NOT NULL,
    "triggerId" UUID NOT NULL,
    "ledgerEventId" UUID NOT NULL,
    "instanceId" UUID,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_trigger_firings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."ledger_cursors" (
    "tenantId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_cursors_pkey" PRIMARY KEY ("tenantId","consumer")
);

-- CreateIndex
CREATE INDEX "workflow_triggers_tenantId_eventType_enabled_idx" ON "workflow"."workflow_triggers"("tenantId", "eventType", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_triggers_tenantId_eventType_playbookKey_key" ON "workflow"."workflow_triggers"("tenantId", "eventType", "playbookKey");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_trigger_firings_triggerId_ledgerEventId_key" ON "workflow"."workflow_trigger_firings"("triggerId", "ledgerEventId");

-- AddForeignKey
ALTER TABLE "workflow"."workflow_trigger_firings" ADD CONSTRAINT "workflow_trigger_firings_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "workflow"."workflow_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
