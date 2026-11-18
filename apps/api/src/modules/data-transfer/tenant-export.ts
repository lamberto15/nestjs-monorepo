import { InjectTransaction } from '@nestjs-cls/transactional';
import { secretColumnsOf } from '../../core/database/secret-columns.js';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, getColumns } from 'drizzle-orm';
import { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { afterKey, pagingKey } from '../../core/tenancy/table-paging.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type TenantTableEntry,
  tenantTables,
} from '../../core/tenancy/tenant-tables.js';
import { AccessService } from '../../iam/access/access.service.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import { OperatorGuard } from '../../iam/auth/operator-only.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { TransferColumn } from './data-transfer.types.js';

/** The reserved export name of a tenant's export: never in the catalog, started only by its own route. */
export const TENANT_EXPORT = 'tenant';

/** One record of the archive: its table, its id, and all of it as JSON text. */
export interface TenantRow extends Record<string, unknown> {
  kind: string;
  id: string | null;
  data: string;
}

export const TENANT_EXPORT_COLUMNS: readonly TransferColumn[] = [
  { key: 'kind' },
  { key: 'id' },
  { key: 'data' },
];

/** Rows read per page of a table. */
const PAGE = 1000;

/**
 * Every record of one tenant, for the operators' export
 * (`POST /v1/tenants/{id}/export`): first the tenant itself, then its
 * members' accounts (`member`: id, address, name), then every table that
 * names the tenant (`tenantTables()`, a module's own included), keyset-paged
 * by its primary key. One row per record: `kind` (its table), `id`, `data`
 * (all of it, as JSON). Left out: the columns its table declares secret
 * (secretColumns(): credentials' hashes, secrets), and every encrypted
 * column (and blind index); stored files are not in it, their
 * rows are (names, sizes, keys).
 *
 * Each page is read in that tenant's scope (as any request of it) and
 * filtered by its `tenant_id` too: never another tenant's row.
 */
@Injectable()
export class TenantExport {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    private readonly access: AccessService,
    private readonly operators: OperatorGuard,
    private readonly encryption: EncryptionService,
  ) {}

  /** The operators only: a user (never impersonating) acting in the operators' tenant with `Access.exportTenants`. */
  async allowed(principal: Principal) {
    return (
      principal.kind === 'user' &&
      !principal.impersonator &&
      (await this.operators.actsAsOperator(principal)) &&
      (await this.access.can(principal, 'exportTenants', 'Access'))
    );
  }

  async *batches(tenantId: string): AsyncIterable<TenantRow[]> {
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant) {
      throw new Error('The tenant to export no longer exists.');
    }
    const hidden = this.encryption.properties();
    yield [this.row('tenant', tenant, hidden)];
    const members = await this.tenancy.run(null, () =>
      this.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, tenantId))
        .orderBy(asc(users.id)),
    );
    if (members.length > 0) {
      yield members.map((member) => this.row('member', member, hidden));
    }
    for (const entry of tenantTables()) {
      yield* this.tableRows(tenantId, entry, hidden);
    }
  }

  /** One table's rows of the tenant, a page at a time, after the last page's key. */
  private async *tableRows(
    tenantId: string,
    { name, table }: TenantTableEntry,
    hidden: ReadonlySet<string>,
  ): AsyncIterable<TenantRow[]> {
    const config = getTableConfig(table);
    const properties = Object.entries(getColumns(table)) as [
      string,
      PgColumn,
    ][];
    const propertyOf = (column: PgColumn) =>
      properties.find(([, candidate]) => candidate === column)![0];
    const keys = pagingKey(config);
    if (keys.length === 0) {
      throw new Error(
        `${name} has a tenant_id but no primary key nor unique index on plain columns: a tenant's export pages by one.`,
      );
    }
    const tenantColumn = properties.find(
      ([property]) => property === 'tenantId',
    )![1];
    let after: unknown[] | undefined;
    for (;;) {
      const rows = (await this.tenancy.run(tenantId, () =>
        this.db
          .select()
          .from(table)
          .where(
            and(
              eq(tenantColumn, tenantId),
              after ? afterKey(keys, after) : undefined,
            ),
          )
          .orderBy(...keys.map((column) => asc(column)))
          .limit(PAGE),
      )) as Record<string, unknown>[];
      if (rows.length === 0) return;
      const left = new Set([...hidden, ...secretColumnsOf(table)]);
      yield rows.map((record) => this.row(name, record, left));
      if (rows.length < PAGE) return;
      const last = rows[rows.length - 1]!;
      after = keys.map((column) => last[propertyOf(column)]);
    }
  }

  private row(
    kind: string,
    record: object,
    hidden: ReadonlySet<string>,
  ): TenantRow {
    const kept = Object.fromEntries(
      Object.entries(record).filter(([property]) => !hidden.has(property)),
    );
    return {
      kind,
      id: typeof kept.id === 'string' ? kept.id : null,
      data: JSON.stringify(kept, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    };
  }
}
