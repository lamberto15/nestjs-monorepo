import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, lt, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOrder,
} from '../../core/http/pagination.js';
import type { RecordRow, RecordTable } from '../records/record.js';
import {
  AUTOMATION_RULE_LIST,
  AUTOMATION_RUN_LIST,
} from './automations.lists.js';
import { automationRules, automationRuns } from './automations.tables.js';

type NewRule = typeof automationRules.$inferInsert;
type NewRun = typeof automationRuns.$inferInsert;

/** The automation rules' and runs' queries, in the caller's transaction and tenant. */
@Injectable()
export class AutomationsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of rules (one row more than the limit), and the total. */
  async page(query: ListQuery) {
    const where = AUTOMATION_RULE_LIST.where(query);
    return Promise.all([
      this.db
        .select()
        .from(automationRules)
        .where(and(where, afterCursor(automationRules.id, query)))
        .orderBy(...pageOrder(automationRules.id, query))
        .limit(query.limit + 1),
      countPage(this.db, automationRules, where, query),
    ]);
  }

  async findById(id: string) {
    const [rule] = await this.db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, id));
    return rule;
  }

  /** A page of a rule's runs (one row more than the limit). */
  async runs(ruleId: string, query: ListQuery) {
    const where = and(
      eq(automationRuns.ruleId, ruleId),
      AUTOMATION_RUN_LIST.where(query),
    );
    return this.db
      .select()
      .from(automationRuns)
      .where(and(where, afterCursor(automationRuns.id, query)))
      .orderBy(...pageOrder(automationRuns.id, query))
      .limit(query.limit + 1);
  }

  async insert(values: NewRule) {
    const [row] = await this.db
      .insert(automationRules)
      .values(values)
      .returning();
    return row!;
  }

  async update(id: string, values: Partial<NewRule>) {
    const [row] = await this.db
      .update(automationRules)
      .set(values)
      .where(eq(automationRules.id, id))
      .returning();
    return row!;
  }

  async delete(id: string) {
    await this.db.delete(automationRules).where(eq(automationRules.id, id));
  }

  async countActive() {
    const [row] = await this.db
      .select({ active: count() })
      .from(automationRules)
      .where(eq(automationRules.status, 'active'));
    return row?.active ?? 0;
  }

  /** The active rules of a subject on a trigger, at most `limit`. */
  async activeRules(
    subject: string,
    trigger: NewRule['trigger'],
    limit: number,
  ) {
    return this.db
      .select({
        id: automationRules.id,
        version: automationRules.version,
        field: automationRules.field,
      })
      .from(automationRules)
      .where(
        and(
          eq(automationRules.subject, subject),
          eq(automationRules.status, 'active'),
          eq(automationRules.trigger, trigger),
        ),
      )
      .limit(limit);
  }

  /**
   * Rows of a record's table that `allowed` lets through, the most recently
   * changed first, at most `limit` (with `ids`: only those).
   */
  async records(
    table: RecordTable,
    allowed: SQL | undefined,
    { ids, limit }: { ids?: readonly string[]; limit: number },
  ) {
    return (await this.db
      .select()
      .from(table as unknown as PgTable)
      .where(and(allowed, ids ? inArray(table.id, [...ids]) : undefined))
      .orderBy(desc(table.updatedAt!), desc(table.id))
      .limit(limit)) as RecordRow[];
  }

  /** How many runs a rule had since `since`. */
  async countRunsSince(ruleId: string, since: Date) {
    const [row] = await this.db
      .select({ runs: count() })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.ruleId, ruleId),
          gt(automationRuns.createdAt, since),
        ),
      );
    return row?.runs ?? 0;
  }

  async insertRun(values: NewRun) {
    await this.db.insert(automationRuns).values(values);
  }

  /** Deletes up to `limit` runs created before `before`; how many went. */
  async deleteRunsBefore(before: Date, limit: number) {
    const rows = await this.db
      .delete(automationRuns)
      .where(
        inArray(
          automationRuns.id,
          this.db
            .select({ id: automationRuns.id })
            .from(automationRuns)
            .where(lt(automationRuns.createdAt, before))
            .limit(limit),
        ),
      )
      .returning({ id: automationRuns.id });
    return rows.length;
  }
}
