/**
 * @bwc/db - the only package that talks to Postgres directly.
 *
 * Specification v2 section 5.1: no service reaches into another service's database.
 * Each module owns a Postgres schema (see prisma/schema.prisma) and reaches it through
 * its own repository. This package owns the client instance those repositories share;
 * it deliberately exports no queries of its own.
 */

import { PrismaClient } from '@prisma/client';

export { PrismaClient };
export type {
  Tenant,
  Actor,
  ActorKind,
  LedgerEvent as LedgerEventRow,
  Client as ClientRow,
  ComplianceFinding as ComplianceFindingRow,
  ComplianceState as ComplianceStateRow,
  Consent as ConsentRow,
  ConsentKind,
  ClientFirewallState as ClientFirewallStateRow,
  FirewallState as FirewallStateRow,
  Prisma,
} from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * Process-wide singleton. Repeated `new PrismaClient()` exhausts the connection pool
 * under a dev server that reloads, which surfaces as intermittent timeouts rather than
 * as an obvious leak.
 */
export const db = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

/** For tests and shutdown hooks. */
export const disconnect = async (): Promise<void> => {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
};
