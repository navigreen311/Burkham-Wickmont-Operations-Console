-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "graph";

-- CreateEnum
CREATE TYPE "graph"."EntityRole" AS ENUM ('operating', 'holding', 'real_estate', 'dba', 'trust', 'other');

-- CreateEnum
CREATE TYPE "graph"."EdgeKind" AS ENUM ('ownership', 'control', 'guarantee', 'cross_guarantee', 'debt', 'intercompany_transfer');

-- CreateEnum
CREATE TYPE "graph"."NodeKind" AS ENUM ('owner', 'entity', 'external');

-- CreateTable
CREATE TABLE "graph"."entities" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "role" "graph"."EntityRole" NOT NULL,
    "stateOfFormation" TEXT,
    "formationDate" TIMESTAMP(3),
    "industry" TEXT,
    "einCiphertext" TEXT,
    "einLast4" TEXT,
    "statedAnnualRevenue" DECIMAL(14,2),
    "statedRevenueBy" TEXT,
    "statedRevenueAt" TIMESTAMP(3),
    "statedRevenueDocRef" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph"."owners" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "ssnCiphertext" TEXT,
    "ssnLast4" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph"."graph_edges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" "graph"."EdgeKind" NOT NULL,
    "fromKind" "graph"."NodeKind" NOT NULL,
    "fromId" UUID NOT NULL,
    "toKind" "graph"."NodeKind" NOT NULL,
    "toId" UUID,
    "toLabel" TEXT,
    "ownershipPercent" DECIMAL(6,3),
    "amount" DECIMAL(14,2),
    "guaranteeLimit" DECIMAL(14,2),
    "provenanceTag" TEXT NOT NULL,
    "sourceNote" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "graph_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entities_tenantId_clientId_isPrimary_idx" ON "graph"."entities"("tenantId", "clientId", "isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "entities_tenantId_clientId_legalName_key" ON "graph"."entities"("tenantId", "clientId", "legalName");

-- CreateIndex
CREATE INDEX "owners_tenantId_clientId_idx" ON "graph"."owners"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "owners_tenantId_clientId_fullName_key" ON "graph"."owners"("tenantId", "clientId", "fullName");

-- CreateIndex
CREATE INDEX "graph_edges_tenantId_clientId_kind_idx" ON "graph"."graph_edges"("tenantId", "clientId", "kind");

-- CreateIndex
CREATE INDEX "graph_edges_tenantId_clientId_fromId_idx" ON "graph"."graph_edges"("tenantId", "clientId", "fromId");

-- CreateIndex
CREATE INDEX "graph_edges_tenantId_clientId_toId_idx" ON "graph"."graph_edges"("tenantId", "clientId", "toId");
