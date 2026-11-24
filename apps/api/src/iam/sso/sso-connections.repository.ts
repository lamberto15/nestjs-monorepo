import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { ssoConnections, ssoRoleMappings } from './sso.tables.js';

type SsoConnection = typeof ssoConnections.$inferSelect;
type ConnectionValues = typeof ssoConnections.$inferInsert;

/**
 * The queries of SSO connections and their role mappings, in the
 * request's tenant and the ambient transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SsoConnectionsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  list() {
    return this.db
      .select()
      .from(ssoConnections)
      .orderBy(asc(ssoConnections.name));
  }

  async findById(id: string): Promise<SsoConnection | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    return row;
  }

  async findEnabled(id: string): Promise<SsoConnection | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoConnections)
      .where(and(eq(ssoConnections.id, id), eq(ssoConnections.enabled, true)));
    return row;
  }

  /** How many enabled connections the tenant has. */
  async countEnabled(tenantId: string) {
    const [row] = await this.db
      .select({ enabled: count() })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.tenantId, tenantId),
          eq(ssoConnections.enabled, true),
        ),
      );
    return row?.enabled ?? 0;
  }

  /** Whether `id` is an enabled connection of the tenant. */
  async isEnabledIn(tenantId: string, id: string) {
    const [row] = await this.db
      .select({ id: ssoConnections.id })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.tenantId, tenantId),
          eq(ssoConnections.id, id),
          eq(ssoConnections.enabled, true),
        ),
      );
    return !!row;
  }

  /** The tenant's oldest enabled connection, its id and tenant only. */
  async oldestEnabled(tenantId: string) {
    const [row] = await this.db
      .select({ id: ssoConnections.id, tenantId: ssoConnections.tenantId })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.tenantId, tenantId),
          eq(ssoConnections.enabled, true),
        ),
      )
      .orderBy(asc(ssoConnections.createdAt), asc(ssoConnections.id))
      .limit(1);
    return row;
  }

  async insert(values: ConnectionValues) {
    const [row] = await this.db
      .insert(ssoConnections)
      .values(values)
      .returning();
    return row!;
  }

  async update(id: string, values: Partial<ConnectionValues>) {
    const [row] = await this.db
      .update(ssoConnections)
      .set(values)
      .where(eq(ssoConnections.id, id))
      .returning();
    return row!;
  }

  async delete(id: string): Promise<SsoConnection | undefined> {
    const [row] = await this.db
      .delete(ssoConnections)
      .where(eq(ssoConnections.id, id))
      .returning();
    return row;
  }

  /** Stores what discovery found, only while the issuer is still `issuer`. */
  async storeDiscovery(
    id: string,
    issuer: string,
    values: Pick<
      Partial<ConnectionValues>,
      'oidcMetadata' | 'metadataFetchedAt' | 'metadataError'
    >,
  ) {
    await this.db
      .update(ssoConnections)
      .set(values)
      .where(and(eq(ssoConnections.id, id), eq(ssoConnections.issuer, issuer)));
  }

  /** Sets the SP key pair of a connection that has none; undefined when it had one. */
  async setSpKeysIfNone(
    id: string,
    keys: { spPrivateKey: string; spCertificate: string },
  ): Promise<SsoConnection | undefined> {
    const [row] = await this.db
      .update(ssoConnections)
      .set(keys)
      .where(
        and(eq(ssoConnections.id, id), isNull(ssoConnections.spCertificate)),
      )
      .returning();
    return row;
  }

  roleMappingsOf(connectionId: string) {
    return this.db
      .select({ group: ssoRoleMappings.group, roleId: ssoRoleMappings.roleId })
      .from(ssoRoleMappings)
      .where(eq(ssoRoleMappings.connectionId, connectionId));
  }

  /** The role mappings of these connections, by group then age. */
  roleMappingsOfAll(connectionIds: string[]) {
    return this.db
      .select()
      .from(ssoRoleMappings)
      .where(inArray(ssoRoleMappings.connectionId, connectionIds))
      .orderBy(asc(ssoRoleMappings.group), asc(ssoRoleMappings.createdAt));
  }

  /** Deletes a connection's group mappings (`groups`) or its default roles. */
  async deleteRoleMappings(connectionId: string, groups: boolean) {
    await this.db
      .delete(ssoRoleMappings)
      .where(
        and(
          eq(ssoRoleMappings.connectionId, connectionId),
          groups
            ? isNotNull(ssoRoleMappings.group)
            : isNull(ssoRoleMappings.group),
        ),
      );
  }

  async insertRoleMappings(
    connectionId: string,
    rows: { group: string | null; roleId: string }[],
  ) {
    await this.db
      .insert(ssoRoleMappings)
      .values(rows.map((row) => ({ ...row, connectionId })))
      .onConflictDoNothing();
  }
}
