import { BadRequestException } from '@nestjs/common';
import { type AnyColumn, desc, inArray, type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  customType,
  type PgTable,
} from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { FilterField, ListQuery } from '../../core/http/list-query.js';
import type { SortBy } from '../../core/http/list-sort.js';
import { countPage } from '../../core/http/pagination.js';

/**
 * Full-text search with PostgreSQL's own: a `tsvector` column generated
 * from a record's `.searchable()` fields, a GIN index, and
 * `websearch_to_tsquery` for what people type (`fast "dark mode" -legacy`).
 * The `simple` configuration: every language, no stemming (a template can't
 * know the language of its data). The record's table (record.ts), its list's
 * `?q=` (record.list.ts) and the global search (modules/search) use it.
 */

/** The column type: a text search vector. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/** A vector the database keeps from `columns` (their SQL names), for a table's declaration. */
export const searchVector = (name: string, columns: readonly string[]) =>
  tsvector(name).generatedAlwaysAs(
    (): SQL =>
      sql`to_tsvector('simple'::regconfig, ${sql.join(
        columns.map(
          (column) => sql`coalesce(${sql.identifier(column)}::text, '')`,
        ),
        sql` || ' ' || `,
      )})`,
  );

/** What people typed, as a query: words, "phrases", -exclusions, or. */
const searchQuery = (q: string) =>
  sql`websearch_to_tsquery('simple'::regconfig, ${q})`;

/** The rows whose vector matches `q`. */
export const matches = (vector: AnyColumn | SQL, q: string) =>
  sql`${vector} @@ ${searchQuery(q)}`;

/** How well a row matches `q`: 0 to 1, more is better. */
export const rank = (vector: AnyColumn | SQL, q: string) =>
  sql<number>`ts_rank(${vector}, ${searchQuery(q)})`;

/** A snippet of `text` around the matches of `q`, the matches in <b>…</b>. */
export const headline = (text: AnyColumn | SQL, q: string) =>
  sql<string>`ts_headline('simple'::regconfig, ${text}, ${searchQuery(q)}, 'MaxFragments=2, MaxWords=14, MinWords=6, StartSel=<b>, StopSel=</b>')`;

/**
 * A vector of `columns` made now, for a search that must not match the
 * stored vector's other fields (one the caller may not read): the same
 * text, without the index.
 */
export const vectorOf = (columns: readonly (AnyColumn | SQL)[]) =>
  sql`to_tsvector('simple'::regconfig, concat_ws(' ', ${sql.join(
    columns.map((column) => sql`${column}::text`),
    sql`, `,
  )}))`;

/**
 * The list fields of a searchable table: `q` (`?q=words`, matching the
 * vector) and `rank` (`?sort=-rank`: the best match first; without a `q`
 * every rank is 0 and the id orders). `fields`: the record fields the
 * vector is made of, so field-level permissions refuse `q` to whoever may
 * read one of them on no record.
 */
export const searchFilters = (
  vector: AnyPgColumn,
  fields: readonly string[],
): Record<'q' | 'rank', FilterField> => ({
  q: {
    column: vector,
    type: 'string',
    ops: ['eq'],
    conditions: { eq: (value) => matches(vector, String(value)) },
    reads: fields,
  },
  rank: {
    column: (query) =>
      typeof query.q === 'string'
        ? rank(vector, query.q)
        : sql<number>`0::real`,
    type: 'number',
    ops: [],
    sortable: true,
    reads: fields,
  },
});

/**
 * The most matches a rank sort or the global search ranks: ranking reads
 * every row it ranks (a GIN index holds no rank), so past this the caller
 * narrows `q`.
 */
export const RANK_CAP = 1_000;

type Reader = Pick<Database, 'select'>;

/**
 * Which of `where`'s matches a search ranks: all of them (no further
 * condition) when at most `cap` match, else the newest `cap`. Counting
 * first lets the planner find a rare term's rows by the GIN index.
 */
export async function rankedMatches(
  db: Reader,
  table: PgTable,
  id: AnyPgColumn,
  where: SQL | undefined,
  cap = RANK_CAP,
): Promise<SQL | undefined> {
  const total = await countPage(
    db,
    table,
    where,
    { limit: cap, count: true },
    cap,
  );
  if (!total?.totalCapped) return undefined;
  return inArray(
    id,
    db.select({ id }).from(table).where(where).orderBy(desc(id)).limit(cap),
  );
}

/**
 * A 400 `search_too_broad` when `?sort=` ranks a `q` that matches more
 * than `cap` records (`where` without the cursor: the same answer on
 * every page). No query unless the sort ranks and there is a `q`.
 */
export async function refuseBroadRank(
  db: Reader,
  table: PgTable,
  where: SQL | undefined,
  query: ListQuery,
  cap = RANK_CAP,
): Promise<void> {
  const sort = query.sort as SortBy[] | undefined;
  if (
    !sort?.some((item) => item.name === 'rank') ||
    typeof query.q !== 'string' ||
    query.q === ''
  ) {
    return;
  }
  const total = await countPage(
    db,
    table,
    where,
    { ...query, count: true },
    cap,
  );
  if (total?.totalCapped) {
    throw new BadRequestException({
      code: 'search_too_broad',
      message: `More than ${cap} records match: narrow q to sort by rank.`,
    });
  }
}
