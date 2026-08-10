-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notifications";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "workflow";

-- CreateEnum
CREATE TYPE "workflow"."PlaybookStatus" AS ENUM ('draft', 'review', 'active', 'retired');

-- CreateEnum
CREATE TYPE "workflow"."InstanceStatus" AS ENUM ('running', 'waiting', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "workflow"."TaskStatus" AS ENUM ('pending', 'running', 'waiting', 'succeeded', 'failed', 'dead_letter', 'cancelled');

-- CreateEnum
CREATE TYPE "workflow"."TaskKind" AS ENUM ('agent_task', 'human_checkpoint', 'decision', 'wait', 'terminal');

-- CreateEnum
CREATE TYPE "notifications"."NotificationStatus" AS ENUM ('open', 'acknowledged', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "workflow"."playbooks" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "phase" INTEGER NOT NULL,
    "status" "workflow"."PlaybookStatus" NOT NULL DEFAULT 'draft',
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."workflow_instances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID,
    "playbookKey" TEXT NOT NULL,
    "playbookVersion" INTEGER NOT NULL,
    "status" "workflow"."InstanceStatus" NOT NULL DEFAULT 'running',
    "currentNodeKey" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."workflow_tasks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "kind" "workflow"."TaskKind" NOT NULL,
    "status" "workflow"."TaskStatus" NOT NULL DEFAULT 'pending',
    "department" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "backoffSeconds" INTEGER NOT NULL DEFAULT 30,
    "leaseExpiresAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."scheduled_workflows" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "playbookKey" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."task_notifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "workflowTaskId" UUID,
    "clientId" UUID,
    "assignedTo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "notifications"."NotificationStatus" NOT NULL DEFAULT 'open',
    "slaDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "task_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playbooks_key_status_idx" ON "workflow"."playbooks"("key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "playbooks_key_version_key" ON "workflow"."playbooks"("key", "version");

-- CreateIndex
CREATE INDEX "workflow_instances_tenantId_status_idx" ON "workflow"."workflow_instances"("tenantId", "status");

-- CreateIndex
CREATE INDEX "workflow_instances_tenantId_clientId_idx" ON "workflow"."workflow_instances"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "workflow_tasks_status_runAt_priority_idx" ON "workflow"."workflow_tasks"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "workflow_tasks_tenantId_instanceId_idx" ON "workflow"."workflow_tasks"("tenantId", "instanceId");

-- CreateIndex
CREATE INDEX "scheduled_workflows_enabled_nextRunAt_idx" ON "workflow"."scheduled_workflows"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_workflows_tenantId_key_key" ON "workflow"."scheduled_workflows"("tenantId", "key");

-- CreateIndex
CREATE INDEX "task_notifications_tenantId_assignedTo_status_idx" ON "notifications"."task_notifications"("tenantId", "assignedTo", "status");

-- CreateIndex
CREATE INDEX "task_notifications_tenantId_workflowTaskId_idx" ON "notifications"."task_notifications"("tenantId", "workflowTaskId");

-- AddForeignKey
ALTER TABLE "workflow"."workflow_tasks" ADD CONSTRAINT "workflow_tasks_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow"."workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
