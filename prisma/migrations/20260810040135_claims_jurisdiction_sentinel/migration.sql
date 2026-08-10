/*
  Warnings:

  - Made the column `jurisdiction` on table `marketing_claims` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "claims"."marketing_claims" ALTER COLUMN "jurisdiction" SET NOT NULL,
ALTER COLUMN "jurisdiction" SET DEFAULT '*';
