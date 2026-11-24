import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { RecordRow } from '../records/record.js';
import type { RecordRelation } from '../records/record-relations.js';

type Table = RecordRelation['table'];

/** One field of a duplicate rule and the value it must equal; `text`: without case or surrounding spaces. */
export interface MatchTerm {
  field: string;
  value: unknown;
  text: boolean;
}

/**
 * The merge's queries over a record's table and the tables that refer to
 * it, in the caller's tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class MergeRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * The live rows held to `filter` that match any of `rules` (each term of
   * a rule equal), newest first.
   */
  async matching(
    table: Table,
    {
      rules,
      filter,
      excludeId,
      limit,
    }: {
      rules: MatchTerm[][];
      filter: SQL | undefined;
      excludeId?: string;
      limit: number;
    },
  ) {
    return (await this.db
      .select()
      .from(table as unknown as PgTable)
      .where(
        and(
          filter,
          isNull(table.deletedAt!),
          or(
            ...rules.map((rule) =>
              and(
                ...rule.map(({ field, value, text }) =>
                  text
                    ? // The builder has no case-insensitive trimmed equality.
                      eq(sql`lower(trim(${table[field]!}))`, value)
                    : eq(table[field]!, value),
                ),
              ),
            ),
          ),
          excludeId ? ne(table.id, excludeId) : undefined,
        ),
      )
      .orderBy(desc(table.id))
      .limit(limit)) as RecordRow[];
  }

  /** Locks these rows until the commit, in id order (two merges of the same pair can't deadlock). */
  async lock(table: Table, ids: string[]) {
    await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(inArray(table.id, ids))
      .orderBy(asc(table.id))
      .for('update');
  }

  /**
   * How many records refer to `id` through the relation, in the recycle
   * bin or not (`deleted`, for a record that has one), held to `filter`.
   */
  async countReferring(
    relation: RecordRelation,
    id: string,
    deleted: boolean | undefined,
    filter?: SQL,
  ) {
    const { table } = relation;
    const state =
      deleted === undefined
        ? undefined
        : deleted
          ? isNotNull(table.deletedAt!)
          : isNull(table.deletedAt!);
    const [row] = await this.db
      .select({ n: count() })
      .from(table as unknown as PgTable)
      .where(and(eq(relation.column, id), state, filter));
    return row?.n ?? 0;
  }

  /** Repoints the relation's references from `from` to `to`; the ids of the records changed. */
  async moveReferences(relation: RecordRelation, from: string, to: string) {
    const rows = await this.db
      .update(relation.table as unknown as PgTable)
      .set({ [relation.field]: to })
      .where(eq(relation.column, from))
      .returning({ id: relation.table.id });
    return rows.map((row) => row.id as string);
  }
}
