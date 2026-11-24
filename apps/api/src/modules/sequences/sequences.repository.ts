import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getColumns, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { NAMING_SERIES_LIST } from './naming-series.list.js';
import { namingSeries, sequences } from './sequences.tables.js';

type NewSeries = typeof namingSeries.$inferInsert;

/**
 * The counters' and the naming series' queries, in the caller's tenant and
 * transaction (`@InjectTransaction()`): a counter's row stays locked until
 * that transaction commits, which is what makes the numbers gapless.
 */
@Injectable()
export class SequencesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * Moves a counter on by one (its first row holds `initial`, 1 unless
   * given), locking its row: the value taken.
   */
  async increment(name: string, scope: string, initial?: number) {
    const [row] = await this.db
      .insert(sequences)
      .values({ name, scope, value: initial ?? 1 })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value: sql`${sequences.value} + 1` },
      })
      .returning({ value: sequences.value });
    return Number(row!.value);
  }

  /**
   * `increment()` of a counter whose first value continues another's
   * (`from`, the scope of the same name): 1 past it, or 1 without it.
   */
  async incrementFrom(name: string, scope: string, from: string) {
    // Params of an untyped sum would not resolve: the subquery is the expression.
    const initial = sql`1 + coalesce((select ${sequences.value} from ${sequences} where ${and(eq(sequences.name, name), eq(sequences.scope, from))}), 0)`;
    const [row] = await this.db
      .insert(sequences)
      .values({ name, scope, value: initial })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value: sql`${sequences.value} + 1` },
      })
      .returning({ value: sequences.value });
    return Number(row!.value);
  }

  /** A counter's last value, if it has a row. */
  async valueOf(name: string, scope: string) {
    const [row] = await this.db
      .select({ value: sequences.value })
      .from(sequences)
      .where(and(eq(sequences.name, name), eq(sequences.scope, scope)));
    return row?.value;
  }

  /** The counters of these names and scopes that have a row. */
  values(wanted: readonly { name: string; scope: string }[]) {
    return wanted.length
      ? this.db
          .select({
            name: sequences.name,
            scope: sequences.scope,
            value: sequences.value,
          })
          .from(sequences)
          .where(
            or(
              ...wanted.map(({ name, scope }) =>
                and(eq(sequences.name, name), eq(sequences.scope, scope)),
              ),
            ),
          )
      : Promise.resolve([]);
  }

  /** A counter's row, locked until the commit: its value, if it has one. */
  async lockValue(name: string, scope: string) {
    const [row] = await this.db
      .select({ value: sequences.value })
      .from(sequences)
      .where(and(eq(sequences.name, name), eq(sequences.scope, scope)))
      .for('update');
    return row === undefined ? undefined : Number(row.value);
  }

  /** Sets a counter to `value`, unless it already went past it: whether it was set. */
  async setIfNotPast(name: string, scope: string, value: number) {
    const [row] = await this.db
      .insert(sequences)
      .values({ name, scope, value })
      .onConflictDoUpdate({
        target: [sequences.tenantId, sequences.name, sequences.scope],
        set: { value },
        // Taken by a write that committed between the lock and this statement.
        setWhere: sql`${sequences.value} <= ${value}`,
      })
      .returning({ value: sequences.value });
    return row !== undefined;
  }

  /** A page of series and the total, as NAMING_SERIES_LIST reads the query. */
  seriesPage(query: ListQuery) {
    const where = NAMING_SERIES_LIST.where(query);
    return Promise.all([
      this.db
        .select({
          ...getColumns(namingSeries),
          ...NAMING_SERIES_LIST.sortSelect(query),
        })
        .from(namingSeries)
        .where(and(where, afterCursor(namingSeries.id, query)))
        .orderBy(...pageOrder(namingSeries.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, namingSeries, where, query),
    ]);
  }

  async findSeries(id: string) {
    const [series] = await this.db
      .select()
      .from(namingSeries)
      .where(eq(namingSeries.id, id));
    return series;
  }

  async findSeriesOf(subject: string, id: string) {
    const [series] = await this.db
      .select()
      .from(namingSeries)
      .where(and(eq(namingSeries.subject, subject), eq(namingSeries.id, id)));
    return series;
  }

  /** Whether the subject has a series. */
  async hasSeries(subject: string) {
    const [existing] = await this.db
      .select({ id: namingSeries.id })
      .from(namingSeries)
      .where(eq(namingSeries.subject, subject))
      .limit(1);
    return existing !== undefined;
  }

  /** A subject's series, by priority, then the oldest first. */
  seriesOf(subject: string) {
    return this.db
      .select()
      .from(namingSeries)
      .where(eq(namingSeries.subject, subject))
      .orderBy(
        desc(namingSeries.priority),
        asc(namingSeries.createdAt),
        asc(namingSeries.id),
      );
  }

  /** A subject's oldest series' id, if it has one. */
  async oldestSeriesId(subject: string) {
    const [oldest] = await this.db
      .select({ id: namingSeries.id })
      .from(namingSeries)
      .where(eq(namingSeries.subject, subject))
      .orderBy(asc(namingSeries.createdAt), asc(namingSeries.id))
      .limit(1);
    return oldest?.id;
  }

  async insertSeries(values: NewSeries) {
    const [created] = await this.db
      .insert(namingSeries)
      .values(values)
      .returning();
    return created!;
  }

  async updateSeries(id: string, values: Partial<NewSeries>) {
    const [updated] = await this.db
      .update(namingSeries)
      .set(values)
      .where(eq(namingSeries.id, id))
      .returning();
    return updated!;
  }

  async deleteSeries(id: string) {
    await this.db.delete(namingSeries).where(eq(namingSeries.id, id));
  }

  /** No series of the subject is the default any more (but `except`). */
  async clearDefault(subject: string, except?: string) {
    await this.db
      .update(namingSeries)
      .set({ isDefault: false })
      .where(
        and(
          eq(namingSeries.subject, subject),
          eq(namingSeries.isDefault, true),
          except ? ne(namingSeries.id, except) : undefined,
        ),
      );
  }
}
