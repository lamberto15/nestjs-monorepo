import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { apiClientQuotas, apiUsage } from './usage.tables.js';

/**
 * The usage queries: the rolled-up rows and the clients' quotas, in the
 * caller's tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class UsageRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async quotaOf(clientId: string) {
    const [row] = await this.db
      .select({ dailyQuota: apiClientQuotas.dailyQuota })
      .from(apiClientQuotas)
      .where(eq(apiClientQuotas.clientId, clientId));
    return row?.dailyQuota;
  }

  async saveQuota(clientId: string, dailyQuota: number) {
    await this.db
      .insert(apiClientQuotas)
      .values({ clientId, dailyQuota })
      .onConflictDoUpdate({
        target: [apiClientQuotas.tenantId, apiClientQuotas.clientId],
        set: { dailyQuota },
      });
  }

  async deleteQuota(clientId: string) {
    await this.db
      .delete(apiClientQuotas)
      .where(eq(apiClientQuotas.clientId, clientId));
  }

  async clientExists(clientId: string) {
    const [client] = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(eq(apiClients.id, clientId));
    return client !== undefined;
  }

  /** The ids among `ids` of clients that still exist. */
  async existingClients(ids: string[]) {
    const rows = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(inArray(apiClients.id, ids));
    return new Set(rows.map((client) => client.id));
  }

  /** A client's rolled-up rows from `from` to `to`, both included. */
  rows(clientId: string, from: string, to: string) {
    return this.db
      .select({
        day: apiUsage.day,
        route: apiUsage.route,
        count: apiUsage.count,
      })
      .from(apiUsage)
      .where(
        and(
          eq(apiUsage.clientId, clientId),
          gte(apiUsage.day, from),
          lte(apiUsage.day, to),
        ),
      );
  }

  /** Writes these rows, each set to its count (in batches: a parameter list has its limits). */
  async upsertRows(
    rows: { clientId: string; day: string; route: string; count: number }[],
  ) {
    for (let start = 0; start < rows.length; start += 1000) {
      await this.db
        .insert(apiUsage)
        .values(rows.slice(start, start + 1000))
        .onConflictDoUpdate({
          target: [
            apiUsage.tenantId,
            apiUsage.clientId,
            apiUsage.day,
            apiUsage.route,
          ],
          set: { count: sql`excluded.count`, updatedAt: new Date() },
        });
    }
  }

  async deleteBefore(day: string) {
    await this.db.delete(apiUsage).where(lt(apiUsage.day, day));
  }
}
