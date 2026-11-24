import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { apiClientRoles } from '../access/access.tables.js';
import { liveGrant } from '../access/roles.service.js';
import { apiClients, apiKeys } from '../auth/auth.tables.js';

export type ApiClient = typeof apiClients.$inferSelect;

/**
 * The queries of API clients, their keys and their role grants, in the
 * request's tenant and the ambient transaction (`@InjectTransaction()`).
 * `api_keys` is global (a key is found by its id before the tenant is
 * known), so its queries say the tenant themselves.
 */
@Injectable()
export class ApiClientsRepository {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
  ) {}

  list() {
    return this.db.select().from(apiClients).orderBy(asc(apiClients.name));
  }

  async findById(id: string): Promise<ApiClient | undefined> {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }

  async insert(values: { name: string; allowedCidrs: string[] }) {
    const [client] = await this.db
      .insert(apiClients)
      .values(values)
      .returning();
    return client!;
  }

  async update(
    id: string,
    values: { active: boolean } | { allowedCidrs: string[] },
  ) {
    await this.db.update(apiClients).set(values).where(eq(apiClients.id, id));
  }

  async delete(id: string) {
    await this.db.delete(apiClients).where(eq(apiClients.id, id));
  }

  /** Every role the client was granted, ended grants too. */
  async roleIdsOf(clientId: string) {
    const rows = await this.db
      .select({ roleId: apiClientRoles.roleId })
      .from(apiClientRoles)
      .where(eq(apiClientRoles.clientId, clientId));
    return rows.map((row) => row.roleId);
  }

  /** The grants of these clients still running. */
  liveGrantsOf(clientIds: string[]) {
    return this.db
      .select()
      .from(apiClientRoles)
      .where(
        and(
          inArray(apiClientRoles.clientId, clientIds),
          liveGrant(apiClientRoles),
        ),
      );
  }

  async insertGrants(
    rows: { clientId: string; roleId: string; expiresAt: Date | null }[],
  ) {
    await this.db.insert(apiClientRoles).values(rows);
  }

  async deleteGrants(clientId: string) {
    await this.db
      .delete(apiClientRoles)
      .where(eq(apiClientRoles.clientId, clientId));
  }

  /** The keys of these clients, oldest first. */
  keysOf(clientIds: string[]) {
    return this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, this.tenancy.tenantId()),
          inArray(apiKeys.clientId, clientIds),
        ),
      )
      .orderBy(asc(apiKeys.createdAt));
  }

  async insertKey(values: {
    clientId: string;
    keyId: string;
    keyHash: string;
    expiresAt: Date | null;
  }) {
    // The client's tenant: a key is found by its id before any tenant.
    await this.db
      .insert(apiKeys)
      .values({ tenantId: this.tenancy.tenantId(), ...values });
  }

  /**
   * Ends the client's current keys (`ending`) unless they end before
   * `until` anyway; returns their public ids.
   */
  async endKeys(
    clientId: string,
    ending: { revokedAt: Date } | { expiresAt: Date },
    until: Date,
  ) {
    const rows = await this.db
      .update(apiKeys)
      .set(ending)
      .where(
        and(
          eq(apiKeys.tenantId, this.tenancy.tenantId()),
          eq(apiKeys.clientId, clientId),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, until)),
        ),
      )
      .returning({ keyId: apiKeys.keyId });
    return rows.map((row) => row.keyId);
  }

  /** Revokes one live key now; undefined when there is none. */
  async revokeKey(clientId: string, id: string) {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.tenantId, this.tenancy.tenantId()),
          eq(apiKeys.clientId, clientId),
          eq(apiKeys.id, id),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ keyId: apiKeys.keyId });
    return row;
  }
}
