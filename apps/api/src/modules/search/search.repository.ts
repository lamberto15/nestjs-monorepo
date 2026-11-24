import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, getColumns, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import {
  headline,
  matches,
  rank,
  rankedMatches,
} from '../records/full-text.js';
import type { RecordRegistration } from '../records/records.service.js';

/** The prefix of a snippet's column in a hit's row. */
export const SNIPPET = '__snippet_';

/**
 * The search's query over a record's table, in the caller's tenant and
 * transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SearchRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * The rows matching `q` in `vector` and `filter`, best first, each with its
   * `score` and a `${SNIPPET}<field>` headline for each of `snippets`.
   */
  async matches(
    table: RecordRegistration['feature']['table'],
    {
      vector,
      q,
      filter,
      snippets,
      limit,
    }: {
      vector: Parameters<typeof matches>[0];
      q: string;
      filter: SQL | undefined;
      snippets: readonly string[];
      limit: number;
    },
  ) {
    const where = and(filter, matches(vector, q));
    const score = rank(vector, q);
    const pg = table as unknown as PgTable;
    return (
      (await this.db
        // The whole row: the permission conditions (`mine`) read it.
        .select({
          ...getColumns(pg),
          score,
          ...Object.fromEntries(
            snippets.map((name) => [
              `${SNIPPET}${name}`,
              headline(table[name]!, q),
            ]),
          ),
        })
        .from(pg)
        // The best of the newest RANK_CAP matches: ranking reads every row it ranks.
        .where(and(where, await rankedMatches(this.db, pg, table.id, where)))
        .orderBy(desc(score), desc(table.id))
        .limit(limit)) as Record<string, unknown>[]
    );
  }
}
