import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import {
  type TenantDomain,
  tenantDomainRoutes,
  tenantDomains,
} from './tenants.tables.js';

/**
 * The queries of a tenant's domains (in the current tenant) and of the
 * routes of verified hostnames (global: each query says the tenant), in
 * the ambient transaction.
 */
@Injectable()
export class TenantDomainsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  list() {
    return this.db
      .select()
      .from(tenantDomains)
      .orderBy(asc(tenantDomains.hostname));
  }

  async findById(id: string): Promise<TenantDomain | undefined> {
    const [row] = await this.db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.id, id));
    return row;
  }

  /** The domain's verification, locked until the transaction ends. */
  async lockVerification(id: string) {
    const [current] = await this.db
      .select({ verifiedAt: tenantDomains.verifiedAt })
      .from(tenantDomains)
      .where(eq(tenantDomains.id, id))
      .for('update');
    return current;
  }

  async insert(values: { hostname: string; verificationToken: string }) {
    const [created] = await this.db
      .insert(tenantDomains)
      .values(values)
      .returning();
    return created!;
  }

  async delete(id: string) {
    const [row] = await this.db
      .delete(tenantDomains)
      .where(eq(tenantDomains.id, id))
      .returning();
    return row;
  }

  async recordCheck(
    id: string,
    values: {
      lastCheckedAt: Date;
      lastError: string | null;
      verifiedAt: Date | null;
    },
  ) {
    await this.db
      .update(tenantDomains)
      .set(values)
      .where(eq(tenantDomains.id, id));
  }

  /** The current tenant's verified domains. */
  async verifiedIds() {
    const rows = await this.db
      .select({ id: tenantDomains.id })
      .from(tenantDomains)
      .where(isNotNull(tenantDomains.verifiedAt));
    return rows.map((row) => row.id);
  }

  /** Routes the hostname to the tenant unless another tenant routes it; the tenant it routes to. */
  async route(hostname: string, tenantId: string) {
    await this.db
      .insert(tenantDomainRoutes)
      .values({ hostname, tenantId })
      .onConflictDoNothing();
    const [route] = await this.db
      .select({ tenantId: tenantDomainRoutes.tenantId })
      .from(tenantDomainRoutes)
      .where(eq(tenantDomainRoutes.hostname, hostname));
    return route?.tenantId;
  }

  async unroute(hostname: string, tenantId: string) {
    await this.db
      .delete(tenantDomainRoutes)
      .where(
        and(
          eq(tenantDomainRoutes.hostname, hostname),
          eq(tenantDomainRoutes.tenantId, tenantId),
        ),
      );
  }

  /** The tenants that route a hostname. */
  async routedTenantIds() {
    const rows = await this.db
      .selectDistinct({ tenantId: tenantDomainRoutes.tenantId })
      .from(tenantDomainRoutes);
    return rows.map((row) => row.tenantId);
  }

  /** The active tenant the hostname routes to. */
  async activeTenantOf(hostname: string) {
    const [route] = await this.db
      .select({ tenantId: tenantDomainRoutes.tenantId })
      .from(tenantDomainRoutes)
      .innerJoin(tenants, eq(tenants.id, tenantDomainRoutes.tenantId))
      .where(
        and(
          eq(tenantDomainRoutes.hostname, hostname),
          eq(tenants.active, true),
        ),
      );
    return route?.tenantId;
  }
}
