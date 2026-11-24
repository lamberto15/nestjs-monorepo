import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { StockQuota } from './quota.js';
import { quotaLocks, quotaPlans, tenantQuotas } from './quotas.tables.js';

/**
 * The quotas' queries: the plans, a tenant's own limits and the stock
 * quotas' locks, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class QuotasRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async tenantLimits(tenantId: string) {
    const [own] = await this.db
      .select({ plan: tenantQuotas.plan, limits: tenantQuotas.limits })
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId));
    return own;
  }

  /** A tenant's row, locked until the commit. */
  async lockTenantLimits(tenantId: string) {
    const [current] = await this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId))
      .for('update');
    return current;
  }

  async saveTenantLimits(
    tenantId: string,
    plan: string | null,
    limits: Record<string, number>,
  ) {
    await this.db
      .insert(tenantQuotas)
      .values({ tenantId, plan, limits })
      .onConflictDoUpdate({
        target: tenantQuotas.tenantId,
        set: { plan, limits },
      });
  }

  async deleteTenantLimits(tenantId: string) {
    await this.db
      .delete(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId));
  }

  plansNamed(names: string[]) {
    return this.db
      .select({ name: quotaPlans.name, limits: quotaPlans.limits })
      .from(quotaPlans)
      .where(inArray(quotaPlans.name, names));
  }

  plans() {
    return this.db
      .select({ name: quotaPlans.name, limits: quotaPlans.limits })
      .from(quotaPlans)
      .orderBy(quotaPlans.name);
  }

  async planExists(name: string) {
    const [plan] = await this.db
      .select({ name: quotaPlans.name })
      .from(quotaPlans)
      .where(eq(quotaPlans.name, name));
    return plan !== undefined;
  }

  async savePlan(name: string, limits: Record<string, number>) {
    await this.db
      .insert(quotaPlans)
      .values({ name, limits })
      .onConflictDoUpdate({ target: quotaPlans.name, set: { limits } });
  }

  /** Deletes a plan; true when there was one. */
  async deletePlan(name: string) {
    const deleted = await this.db
      .delete(quotaPlans)
      .where(eq(quotaPlans.name, name))
      .returning({ name: quotaPlans.name });
    return deleted.length > 0;
  }

  /**
   * Locks the tenant's row of a quota until the commit. One statement,
   * race-free on the first check too: the insert, or the no-op update of
   * the row already there, locks it.
   */
  async lock(key: string) {
    await this.db
      .insert(quotaLocks)
      .values({ key })
      .onConflictDoUpdate({
        target: [quotaLocks.tenantId, quotaLocks.key],
        set: { key },
      });
  }

  /** What the tenant has of a stock quota, counted by the quota's owner. */
  count(quota: StockQuota, tenantId: string) {
    return quota.count(this.db, tenantId);
  }
}
