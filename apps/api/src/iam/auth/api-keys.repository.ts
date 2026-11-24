import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { apiClients, apiKeys } from './auth.tables.js';

/**
 * The API key sign-in's queries. On the pool, not the request's
 * transaction: a key is read before any tenant scope opens one.
 */
@Injectable()
export class ApiKeysRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The key (a global table) and whether its tenant is active. */
  async findKey(keyId: string) {
    const [row] = await this.db
      .select({ key: apiKeys, tenantActive: tenants.active })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(eq(apiKeys.keyId, keyId));
    return row;
  }

  /** The client, a tenant table: in that tenant's scope. */
  async findClient(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }

  /** Records the use unless one later than `before` is already recorded. */
  async touch(keyId: string, now: Date, before: Date) {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, before)),
        ),
      );
  }
}
