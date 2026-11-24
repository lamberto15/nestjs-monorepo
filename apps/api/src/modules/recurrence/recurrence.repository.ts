import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, lt, lte } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { RECORD_SCHEDULE_LIST } from './recurrence.lists.js';
import { recordScheduleRuns, recordSchedules } from './recurrence.tables.js';

type NewSchedule = typeof recordSchedules.$inferInsert;

/** Active, and its next run at or before `now`. */
const isDue = (now: Date) =>
  and(
    eq(recordSchedules.status, 'active'),
    lte(recordSchedules.nextRunAt, now),
  );

/**
 * The record schedules' queries and their runs', in the caller's tenant
 * and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class RecurrenceRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of an owner's schedules, and the total when asked. */
  page(owner: string, query: ListQuery) {
    const where = and(
      eq(recordSchedules.owner, owner),
      RECORD_SCHEDULE_LIST.where(query),
    );
    return Promise.all([
      this.db
        .select()
        .from(recordSchedules)
        .where(and(where, afterCursor(recordSchedules.id, query)))
        .orderBy(...pageOrder(recordSchedules.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordSchedules, where, query),
    ]);
  }

  async findOwn(owner: string, id: string) {
    const [row] = await this.db
      .select()
      .from(recordSchedules)
      .where(and(eq(recordSchedules.id, id), eq(recordSchedules.owner, owner)));
    return row;
  }

  /** A schedule locked until the commit; with `skipLocked`, undefined when another holds it. */
  async lock(id: string, { skipLocked = false } = {}) {
    const [row] = await this.db
      .select()
      .from(recordSchedules)
      .where(eq(recordSchedules.id, id))
      .for('update', skipLocked ? { skipLocked: true } : undefined);
    return row;
  }

  async insert(values: NewSchedule) {
    const [created] = await this.db
      .insert(recordSchedules)
      .values(values)
      .returning();
    return created!;
  }

  async update(id: string, values: Partial<NewSchedule>) {
    const [updated] = await this.db
      .update(recordSchedules)
      .set(values)
      .where(eq(recordSchedules.id, id))
      .returning();
    return updated!;
  }

  async delete(id: string) {
    await this.db.delete(recordSchedules).where(eq(recordSchedules.id, id));
  }

  async countActiveOf(owner: string) {
    const [row] = await this.db
      .select({ active: count() })
      .from(recordSchedules)
      .where(
        and(
          eq(recordSchedules.owner, owner),
          eq(recordSchedules.status, 'active'),
        ),
      );
    return row?.active ?? 0;
  }

  async anyDue(now: Date) {
    const [due] = await this.db
      .select({ id: recordSchedules.id })
      .from(recordSchedules)
      .where(isDue(now))
      .limit(1);
    return due !== undefined;
  }

  /** The ids of the due schedules, oldest first, at most `limit`. */
  async dueIds(now: Date, limit: number) {
    const rows = await this.db
      .select({ id: recordSchedules.id })
      .from(recordSchedules)
      .where(isDue(now))
      .orderBy(asc(recordSchedules.nextRunAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Records an occurrence's run, once per schedule and moment: false when
   * it was recorded already.
   */
  async insertRun(values: typeof recordScheduleRuns.$inferInsert) {
    const [claimed] = await this.db
      .insert(recordScheduleRuns)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: recordScheduleRuns.id });
    return claimed !== undefined;
  }

  /** Deletes up to `limit` runs of occurrences before `before`; how many went. */
  async deleteRunsBefore(before: Date, limit: number) {
    const rows = await this.db
      .delete(recordScheduleRuns)
      .where(
        inArray(
          recordScheduleRuns.id,
          this.db
            .select({ id: recordScheduleRuns.id })
            .from(recordScheduleRuns)
            .where(lt(recordScheduleRuns.occurrenceAt, before))
            .limit(limit),
        ),
      )
      .returning({ id: recordScheduleRuns.id });
    return rows.length;
  }

  async findClient(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }

  ownedBy(owner: string) {
    return this.db
      .select()
      .from(recordSchedules)
      .where(eq(recordSchedules.owner, owner));
  }

  async deleteOwnedBy(owner: string) {
    await this.db
      .delete(recordSchedules)
      .where(eq(recordSchedules.owner, owner));
  }
}
