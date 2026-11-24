import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  getColumns,
  inArray,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  type AnyPgColumn,
  getTableConfig,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { afterKey, pagingKey } from '../../core/tenancy/table-paging.js';
import { apiClients, memberships, users } from '../../iam/auth/auth.tables.js';
import { organizationalUnits } from '../../iam/organization/organization.tables.js';
import type { RecordKey } from '../records/record-relations.js';
import { importMappings } from './import-mappings.tables.js';

type NewImportMapping = typeof importMappings.$inferInsert;
/** A record's table, as a transfer reads it: its columns by property. */
type AnyTable = Record<string, AnyPgColumn | undefined>;

/**
 * The transfers' queries: saved mappings, the records a file names by
 * their key, the people and units it names, a job's API client, and a
 * tenant's tables for its export. In the caller's transaction and tenant;
 * `allowed` is the principal's permission as SQL (`access.sqlFilter()`).
 */
@Injectable()
export class DataTransferRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async mappings(importer: string) {
    return this.db
      .select()
      .from(importMappings)
      .where(eq(importMappings.importer, importer))
      .orderBy(asc(importMappings.name));
  }

  async countMappings(importer: string) {
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(importMappings)
      .where(eq(importMappings.importer, importer));
    return total;
  }

  async insertMapping(values: NewImportMapping) {
    const [row] = await this.db
      .insert(importMappings)
      .values(values)
      .returning();
    return row!;
  }

  /** Deletes an import's mapping, and returns it. */
  async deleteMapping(importer: string, id: string) {
    const [row] = await this.db
      .delete(importMappings)
      .where(
        and(eq(importMappings.id, id), eq(importMappings.importer, importer)),
      )
      .returning();
    return row;
  }

  async findClient(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }

  /** The key (and the parent's id, for a path) of each of these ids that `allowed` lets through. */
  async keyRows(key: RecordKey, ids: string[], allowed: SQL | undefined) {
    const { table, parent } = key;
    return (await this.db
      .select({
        id: table.id!,
        key: table[key.field]!,
        ...(parent && { parent: table[parent.field]! }),
      })
      .from(table as unknown as PgTable)
      .where(and(inArray(table.id!, ids), allowed))) as {
      id: string;
      key: string | number | null;
      parent?: unknown;
    }[];
  }

  /** The live record whose key is `value` (under `parentId`, for a path) that `allowed` lets through. */
  async idOfKey(
    key: RecordKey,
    value: string | number,
    parentId: string | undefined,
    allowed: SQL | undefined,
  ) {
    const { table, parent } = key;
    const [row] = await this.db
      .select({ id: table.id! })
      .from(table as unknown as PgTable)
      .where(
        and(
          eq(table[key.field]!, value),
          parent ? eq(table[parent.field]!, parentId!) : undefined,
          table.deletedAt ? isNull(table.deletedAt) : undefined,
          allowed,
        ),
      )
      .limit(1);
    return row?.id as string | undefined;
  }

  /** The live record whose `column` is `value` that `allowed` lets through. */
  async idWhere(
    table: AnyTable,
    column: string,
    value: string,
    allowed: SQL | undefined,
  ) {
    const [row] = await this.db
      .select({ id: table.id! })
      .from(table as unknown as PgTable)
      .where(
        and(
          eq(table[column]!, value),
          table.deletedAt ? isNull(table.deletedAt) : undefined,
          allowed,
        ),
      )
      .limit(1);
    return row as { id: string } | undefined;
  }

  /**
   * Up to two of the tenant's active members whose email is `value` (any
   * case) or, without an `@`, whose name is exactly it.
   */
  async membersNamed(tenantId: string, value: string) {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
        ),
      )
      .where(
        value.includes('@')
          ? eq(sql`lower(${users.email})`, value.trim().toLowerCase())
          : eq(users.name, value.trim()),
      )
      .limit(2);
    return rows.map((row) => row.id);
  }

  async unitNames(ids: string[]) {
    return this.db
      .select({ id: organizationalUnits.id, name: organizationalUnits.name })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, ids));
  }

  /** A tenant's members' accounts (id, address, name), by id. */
  async members(tenantId: string) {
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(asc(users.id));
  }

  /** The columns a table's rows are paged by (none when it has no key to page by). */
  pageKeys(table: PgTable) {
    return pagingKey(getTableConfig(table));
  }

  /** A page of the tenant's rows of a table, in key order, after `after` (the last page's key). */
  async tablePage(
    table: PgTable,
    keys: PgColumn[],
    tenantId: string,
    after: unknown[] | undefined,
    limit: number,
  ) {
    const tenantColumn = getColumns(table).tenantId as PgColumn;
    return (await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(tenantColumn, tenantId),
          after ? afterKey(keys, after) : undefined,
        ),
      )
      .orderBy(...keys.map((column) => asc(column)))
      .limit(limit)) as Record<string, unknown>[];
  }

  /** A row's values of `keys`: where the next page starts. */
  keyOf(table: PgTable, keys: PgColumn[], row: Record<string, unknown>) {
    const properties = Object.entries(getColumns(table));
    return keys.map(
      (column) =>
        row[properties.find(([, candidate]) => candidate === column)![0]],
    );
  }
}
