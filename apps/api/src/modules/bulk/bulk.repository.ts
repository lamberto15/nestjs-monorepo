import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import type { RecordRow, RecordTable } from '../records/record.js';

/** Which rows of a record's table a run may touch. */
export interface BulkScope {
  table: RecordTable;
  /** The principal's permission, as SQL (`access.sqlFilter()`). */
  allowed: SQL | undefined;
  /** Whether the table soft-deletes, and whether the run is on the deleted ones. */
  softDelete: boolean;
  deleted: boolean;
}

const whereOf = ({ table, allowed, softDelete, deleted }: BulkScope) =>
  and(
    allowed,
    softDelete
      ? deleted
        ? isNotNull(table.deletedAt!)
        : isNull(table.deletedAt!)
      : undefined,
  );

/**
 * The bulk runs' queries: the records of a feature's table a run selects
 * (the store then does each item), and an API client checked again on the
 * worker. In the caller's transaction and tenant.
 */
@Injectable()
export class BulkRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The rows in scope among these ids. */
  async byIds(scope: BulkScope, ids: string[]) {
    return (await this.db
      .select()
      .from(scope.table as unknown as PgTable)
      .where(and(whereOf(scope), inArray(scope.table.id, ids)))) as RecordRow[];
  }

  /** A batch of the rows in scope that the list's own filter matches. */
  async page(
    scope: BulkScope,
    filter: SQL | undefined,
    {
      after,
      orderBy,
      limit,
    }: { after: SQL | undefined; orderBy: SQL[]; limit: number },
  ) {
    return this.db
      .select()
      .from(scope.table as unknown as PgTable)
      .where(and(whereOf(scope), filter, after))
      .orderBy(...orderBy)
      .limit(limit) as unknown as Promise<RecordRow[]>;
  }

  /** An API client of the current tenant (row-level security: another tenant's is none). */
  async findClient(id: string) {
    const [client] = await this.db
      .select({ active: apiClients.active, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }
}
