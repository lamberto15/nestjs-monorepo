import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { escapeLike } from '../../core/http/list-query.js';
import type { RecordRegistration } from '../records/records.service.js';

/**
 * The query of a record's options (GET /v1/lists/{subject}/options), over
 * the record's own table, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class ListsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * The ids of the live records among `id` (else all), whose `title`
   * column contains `q`, held to `filters`, by title then newest.
   */
  async optionIds(
    record: RecordRegistration,
    {
      id,
      q,
      title,
      filters,
      limit,
    }: {
      id?: string[];
      q?: string;
      title: string | null;
      filters: (SQL | undefined)[];
      limit: number;
    },
  ) {
    const table = record.feature.table as unknown as PgTable &
      Record<string, AnyPgColumn>;
    const column = title ? table[title] : undefined;
    // Without a title column a search has nothing to match.
    if (q && !column) return [];
    const rows = (await this.db
      .select({ id: table.id! })
      .from(table)
      .where(
        and(
          id ? inArray(table.id!, id) : undefined,
          q && column ? ilike(column, `%${escapeLike(q)}%`) : undefined,
          ...filters,
          table.deletedAt ? isNull(table.deletedAt) : undefined,
        ),
      )
      .orderBy(...(column ? [asc(column)] : []), desc(table.id!))
      .limit(id ? id.length : limit)) as { id: string }[];
    return rows.map((row) => row.id);
  }
}
