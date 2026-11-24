import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { REPORT_LIST } from './reports.lists.js';
import { reportSchedules } from './reports.tables.js';

type NewReport = typeof reportSchedules.$inferInsert;

/** A report the runner starts at `now`: written once for the tenant's due reports and the tenants that have one. */
const isDue = (now: Date) =>
  and(eq(reportSchedules.active, true), lte(reportSchedules.nextRunAt, now));

/**
 * The report schedules' queries, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class ReportsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of an owner's reports, and the total when asked. */
  page(owner: string, query: ListQuery) {
    const where = and(
      eq(reportSchedules.owner, owner),
      REPORT_LIST.where(query),
    );
    return Promise.all([
      this.db
        .select()
        .from(reportSchedules)
        .where(and(where, afterCursor(reportSchedules.id, query)))
        .orderBy(...pageOrder(reportSchedules.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, reportSchedules, where, query),
    ]);
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, id));
    return row;
  }

  async findOwn(owner: string, id: string) {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.owner, owner)));
    return row;
  }

  /** A report, locked until the commit. */
  async lock(id: string) {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, id))
      .for('update');
    return row;
  }

  async insert(values: NewReport) {
    const [created] = await this.db
      .insert(reportSchedules)
      .values(values)
      .returning();
    return created!;
  }

  async update(id: string, values: Partial<NewReport>) {
    const [updated] = await this.db
      .update(reportSchedules)
      .set(values)
      .where(eq(reportSchedules.id, id))
      .returning();
    return updated!;
  }

  /** Sets these values while `transferId` is still the report's last run (a later run supersedes it). */
  async updateIfLastRun(
    id: string,
    transferId: string,
    values: Partial<NewReport>,
  ) {
    await this.db
      .update(reportSchedules)
      .set(values)
      .where(
        and(
          eq(reportSchedules.id, id),
          eq(reportSchedules.lastTransferId, transferId),
        ),
      );
  }

  async delete(id: string) {
    await this.db.delete(reportSchedules).where(eq(reportSchedules.id, id));
  }

  async countActiveOf(owner: string) {
    const [row] = await this.db
      .select({ active: count() })
      .from(reportSchedules)
      .where(
        and(eq(reportSchedules.owner, owner), eq(reportSchedules.active, true)),
      );
    return row?.active ?? 0;
  }

  /** The tenant's due reports, soonest first, at most `limit`. */
  due(now: Date, limit: number) {
    return this.db
      .select()
      .from(reportSchedules)
      .where(isDue(now))
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(limit);
  }

  /** The tenants with a report due (read across every tenant). */
  async dueTenants(now: Date) {
    const rows = await this.db
      .selectDistinct({ tenantId: reportSchedules.tenantId })
      .from(reportSchedules)
      .where(isDue(now));
    return rows.map((row) => row.tenantId);
  }

  ownedBy(owner: string) {
    return this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.owner, owner));
  }

  async deleteOwnedBy(owner: string) {
    await this.db
      .delete(reportSchedules)
      .where(eq(reportSchedules.owner, owner));
  }
}
