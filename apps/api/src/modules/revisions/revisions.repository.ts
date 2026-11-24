import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { REVISION_LIST } from './revisions.list.js';
import { revisions } from './revisions.tables.js';

type NewRevision = typeof revisions.$inferInsert;

const newer = alias(revisions, 'newer');

/**
 * The revisions' queries, in the caller's tenant and transaction
 * (`@InjectTransaction()`). `visible`, where a method takes it, is the
 * fields the reader may see: a revision is theirs when it is the first or
 * changes one of them; undefined, every revision.
 */
@Injectable()
export class RevisionsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A record's latest revision: its number and snapshot. */
  async last(subject: string, recordId: string) {
    const [last] = await this.db
      .select({ number: revisions.number, snapshot: revisions.snapshot })
      .from(revisions)
      .where(this.of(subject, recordId))
      .orderBy(desc(revisions.number))
      .limit(1);
    return last;
  }

  async insert(values: NewRevision) {
    const [row] = await this.db
      .insert(revisions)
      .values(values)
      .returning({ number: revisions.number, snapshot: revisions.snapshot });
    return row!;
  }

  /** A page of a record's revisions, newest first unless the query sorts, and the total when asked. */
  async page(
    subject: string,
    recordId: string,
    visible: string[] | undefined,
    query: ListQuery,
  ) {
    const where = and(
      this.of(subject, recordId),
      this.shown(visible),
      REVISION_LIST.where(query),
    );
    return Promise.all([
      this.db
        .select()
        .from(revisions)
        .where(and(where, this.after(subject, recordId, query)))
        .orderBy(
          ...(query.sort?.length
            ? pageOrder(revisions.id, query)
            : [desc(revisions.number)]),
        )
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, revisions, where, query),
    ]);
  }

  async findByNumber(
    subject: string,
    recordId: string,
    number: number,
    visible: string[] | undefined,
  ) {
    const [row] = await this.db
      .select()
      .from(revisions)
      .where(
        and(
          this.of(subject, recordId),
          eq(revisions.number, number),
          this.shown(visible),
        ),
      );
    return row;
  }

  async deleteForRecords(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(revisions)
      .where(
        and(
          eq(revisions.subject, subject),
          inArray(revisions.recordId, [...recordIds]),
        ),
      );
  }

  /** Who made a change becomes `by` (a person's deletion). */
  async renameChanger(from: string, to: string) {
    await this.db
      .update(revisions)
      .set({ changedBy: to })
      .where(eq(revisions.changedBy, from));
  }

  /**
   * Deletes up to `limit` revisions changed before `before` that are not
   * their record's latest (a newer revision of the same record exists,
   * within its tenant); how many went.
   */
  async deleteOlderThan(before: Date, limit: number) {
    const old = and(
      lt(revisions.changedAt, before),
      exists(
        this.db
          .select({ one: newer.id })
          .from(newer)
          .where(
            and(
              eq(newer.tenantId, revisions.tenantId),
              eq(newer.subject, revisions.subject),
              eq(newer.recordId, revisions.recordId),
              gt(newer.number, revisions.number),
            ),
          ),
      ),
    );
    const rows = await this.db
      .delete(revisions)
      .where(
        inArray(
          revisions.id,
          this.db
            .select({ id: revisions.id })
            .from(revisions)
            .where(old)
            .limit(limit),
        ),
      )
      .returning({ id: revisions.id });
    return rows.length;
  }

  private of(subject: string, recordId: string) {
    return and(
      eq(revisions.subject, subject),
      eq(revisions.recordId, recordId),
    );
  }

  private shown(visible: string[] | undefined) {
    return visible === undefined
      ? undefined
      : or(
          isNull(revisions.changes),
          // Drizzle has no jsonb `?|` (has any of these keys).
          sql`${revisions.changes} ?| ${sql.param(visible)}::text[]`,
        );
  }

  /**
   * Newest first by default: after the cursor's revision is a lower number.
   * A cursor of another record's revision is none of this one's: no rows.
   */
  private after(subject: string, recordId: string, query: ListQuery) {
    if (!query.cursor || query.sort?.length) {
      return afterCursor(revisions.id, query);
    }
    return lt(
      revisions.number,
      this.db
        .select({ number: revisions.number })
        .from(revisions)
        .where(and(this.of(subject, recordId), eq(revisions.id, query.cursor))),
    );
  }
}
