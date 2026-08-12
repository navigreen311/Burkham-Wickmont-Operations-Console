-- AlterTable
ALTER TABLE "workflow"."workflow_tasks" ADD COLUMN     "remindDueAt" TIMESTAMP(3),
ADD COLUMN     "remindersSent" INTEGER NOT NULL DEFAULT 0;
