/**
 * @bwc/tenancy - 11.2 Tenant / Organization Model.
 *
 * Design principle 5: multi-tenant isolation is strict. Burkham Wickmont client data lives
 * in the Burkham Wickmont tenant. Aggregation to Gardner strips PII. Cross-portfolio handoffs
 * to Collingswood require explicit per-handoff consent. No back doors.
 *
 * The isolation check lives here and is called by the middleware chain. It is not duplicated
 * into individual modules: a second implementation is a second thing to keep correct, and the
 * failure mode of getting it wrong is a cross-tenant data leak, which Specification v2
 * section 10.5 lists as a zero-tolerance metric.
 */

import { db } from '@bwc/db';
import { ok, refused, type Outcome } from '@bwc/core';

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export const findBySlug = async (slug: string): Promise<Tenant | null> =>
  db().tenant.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });

export const findById = async (id: string): Promise<Tenant | null> =>
  db().tenant.findUnique({ where: { id }, select: { id: true, slug: true, name: true } });

export const create = async (slug: string, name: string): Promise<Tenant> =>
  db().tenant.create({ data: { slug, name }, select: { id: true, slug: true, name: true } });

/**
 * The isolation check. An actor may only operate within its own tenant.
 *
 * Returns a refusal rather than throwing so the caller records it as a first-class outcome -
 * a blocked cross-tenant access is a ledger event (`tenancy.cross_tenant_access_blocked`),
 * not an unhandled exception in a log somewhere.
 *
 * The refusal reason deliberately does not disclose whether the target tenant exists.
 */
export const assertSameTenant = (
  actorTenantId: string,
  targetTenantId: string,
): Outcome<{ tenantId: string }> =>
  actorTenantId === targetTenantId
    ? ok({ tenantId: targetTenantId })
    : refused(
        'Actor may not operate outside its own tenant.',
        'Principle 5 - multi-tenant isolation is strict',
      );
