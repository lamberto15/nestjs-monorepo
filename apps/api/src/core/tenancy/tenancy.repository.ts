import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { type Tenant, tenants } from './tenancy.tables.js';
import { isolation } from './tenant-isolation.js';

/**
 * The queries of the global `tenants` table, in the ambient transaction
 * (`@InjectTransaction()`). Global: readable in any scope.
 */
@Injectable()
export class TenancyRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Every tenant, oldest first. */
  all() {
    return this.db
      .select()
      .from(tenants)
      .orderBy(asc(tenants.createdAt), asc(tenants.id));
  }

  /** One page of tenants in id order: those of `among`, or those after `after`. */
  page({
    includeInactive,
    among,
    after,
    limit,
  }: {
    includeInactive: boolean;
    among?: string[];
    after?: string;
    limit: number;
  }) {
    return this.db
      .select()
      .from(tenants)
      .where(
        and(
          includeInactive ? undefined : eq(tenants.active, true),
          among
            ? inArray(tenants.id, among)
            : after
              ? gt(tenants.id, after)
              : undefined,
        ),
      )
      .orderBy(asc(tenants.id))
      .limit(limit);
  }

  async findById(id: string): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    return tenant;
  }

  /** Instances starting together: the slug's unique key keeps it one. */
  async insertDefault() {
    await this.db
      .insert(tenants)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoNothing();
  }

  async insert(values: typeof tenants.$inferInsert): Promise<Tenant> {
    const [tenant] = await this.db.insert(tenants).values(values).returning();
    return tenant!;
  }

  /** A new tenant's own storage, where the isolation mode needs one. */
  provision(tenantId: string) {
    return isolation.provision(this.db, tenantId);
  }

  async setFrozenAt(
    id: string,
    frozenAt: Date | null,
  ): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .update(tenants)
      .set({ frozenAt })
      .where(eq(tenants.id, id))
      .returning();
    return tenant;
  }
}
