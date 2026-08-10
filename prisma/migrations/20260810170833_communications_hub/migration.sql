-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "comms";

-- CreateEnum
CREATE TYPE "comms"."CommsChannel" AS ENUM ('email', 'sms', 'voice');

-- CreateEnum
CREATE TYPE "comms"."CommsDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "comms"."CommsStatus" AS ENUM ('approved_to_send', 'blocked', 'received');

-- CreateTable
CREATE TABLE "comms"."notification_preferences" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "emailAllowed" BOOLEAN NOT NULL DEFAULT false,
    "smsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "voiceAllowed" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "preferredChannel" "comms"."CommsChannel",
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "doNotCallSetOn" TIMESTAMP(3),
    "doNotCallReason" TEXT,
    "urgentRouting" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comms"."message_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "channel" "comms"."CommsChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comms"."communications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "direction" "comms"."CommsDirection" NOT NULL,
    "channel" "comms"."CommsChannel" NOT NULL,
    "status" "comms"."CommsStatus" NOT NULL,
    "templateKey" TEXT,
    "templateVersion" INTEGER,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "blockedReason" TEXT,
    "urgentReroute" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenantId_clientId_key" ON "comms"."notification_preferences"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "message_templates_tenantId_key_supersededAt_idx" ON "comms"."message_templates"("tenantId", "key", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenantId_key_version_key" ON "comms"."message_templates"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "communications_tenantId_clientId_occurredAt_idx" ON "comms"."communications"("tenantId", "clientId", "occurredAt");

-- CreateIndex
CREATE INDEX "communications_tenantId_status_idx" ON "comms"."communications"("tenantId", "status");
