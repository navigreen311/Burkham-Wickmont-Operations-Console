-- AlterTable
ALTER TABLE "identity"."client_mfa_factors" ADD COLUMN     "discoverable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "identity"."client_users" ADD COLUMN     "passwordSignInDisabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "identity"."client_webauthn_challenges" ALTER COLUMN "clientUserId" DROP NOT NULL;

