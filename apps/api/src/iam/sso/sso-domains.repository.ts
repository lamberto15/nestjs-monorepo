import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { ssoDomainRoutes, ssoDomains } from './sso.tables.js';

type Domain = typeof ssoDomains.$inferSelect;

/**
 * The queries of a tenant's domains, in the request's tenant and the
 * ambient transaction (`@InjectTransaction()`), and of their routes:
 * `sso_domain_routes` is global (no row-level security), so its writes
 * say the tenant themselves.
 */
@Injectable()
export class SsoDomainsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  list() {
    return this.db.select().from(ssoDomains).orderBy(asc(ssoDomains.domain));
  }

  async findById(id: string): Promise<Domain | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id));
    return row;
  }

  /** The domain's verification, its row locked until the transaction ends. */
  async lockVerification(id: string) {
    const [row] = await this.db
      .select({ verifiedAt: ssoDomains.verifiedAt })
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id))
      .for('update');
    return row;
  }

  async insert(values: { domain: string; verificationToken: string }) {
    const [row] = await this.db.insert(ssoDomains).values(values).returning();
    return row!;
  }

  async update(
    id: string,
    values: Pick<
      Partial<typeof ssoDomains.$inferInsert>,
      'lastCheckedAt' | 'lastError' | 'verifiedAt'
    >,
  ) {
    await this.db.update(ssoDomains).set(values).where(eq(ssoDomains.id, id));
  }

  async delete(id: string): Promise<Domain | undefined> {
    const [row] = await this.db
      .delete(ssoDomains)
      .where(eq(ssoDomains.id, id))
      .returning();
    return row;
  }

  async verifiedIds() {
    const rows = await this.db
      .select({ id: ssoDomains.id })
      .from(ssoDomains)
      .where(isNotNull(ssoDomains.verifiedAt));
    return rows.map((row) => row.id);
  }

  async findVerified(domain: string) {
    const [row] = await this.db
      .select({ id: ssoDomains.id })
      .from(ssoDomains)
      .where(
        and(eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt)),
      );
    return row;
  }

  async insertRoute(route: { domain: string; tenantId: string }) {
    await this.db.insert(ssoDomainRoutes).values(route).onConflictDoNothing();
  }

  async deleteRoute(route: { domain: string; tenantId: string }) {
    await this.db
      .delete(ssoDomainRoutes)
      .where(
        and(
          eq(ssoDomainRoutes.domain, route.domain),
          eq(ssoDomainRoutes.tenantId, route.tenantId),
        ),
      );
  }

  /** The tenants that route any domain. */
  async routedTenants() {
    const rows = await this.db
      .selectDistinct({ tenantId: ssoDomainRoutes.tenantId })
      .from(ssoDomainRoutes);
    return rows.map((row) => row.tenantId);
  }

  /** The tenants that route `domain`, the first to verify it first. */
  routesOf(domain: string, limit: number) {
    return this.db
      .select({ tenantId: ssoDomainRoutes.tenantId })
      .from(ssoDomainRoutes)
      .where(eq(ssoDomainRoutes.domain, domain))
      .orderBy(asc(ssoDomainRoutes.createdAt), asc(ssoDomainRoutes.tenantId))
      .limit(limit);
  }
}
