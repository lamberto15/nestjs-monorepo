import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, lt, not } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { notHeld } from '../../iam/holds/holds.tables.js';
import type { RetentionRule } from './retention.rules.js';
import { retentionPolicies } from './retention.tables.js';

/** The rows of a rule older than the cutoff, still pending. */
const due = (rule: RetentionRule, cutoff: Date) =>
  and(
    lt(rule.ageColumn, cutoff),
    rule.where,
    rule.action === 'anonymise' ? rule.anonymise!.pending : undefined,
  );

/**
 * Retention's queries: the tenant's policies, and a rule's due rows in the
 * table it declares, in the caller's tenant and transaction
 * (`@InjectTransaction()`). A row under a legal hold is never due
 * (`notHeld`).
 */
@Injectable()
export class RetentionRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  policies() {
    return this.db.select().from(retentionPolicies);
  }

  async findPolicy(rule: string) {
    const [policy] = await this.db
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.rule, rule));
    return policy;
  }

  async savePolicy(rule: string, days: number, enabled: boolean) {
    await this.db
      .insert(retentionPolicies)
      .values({ rule, days, enabled })
      .onConflictDoUpdate({
        target: [retentionPolicies.tenantId, retentionPolicies.rule],
        set: { days, enabled },
      });
  }

  /** The names of the tenant's enabled rules. */
  async enabledRules() {
    const rows = await this.db
      .select({ rule: retentionPolicies.rule })
      .from(retentionPolicies)
      .where(eq(retentionPolicies.enabled, true));
    return rows.map((row) => row.rule);
  }

  async finish(rule: string, lastCount: number) {
    await this.db
      .update(retentionPolicies)
      .set({ lastRunAt: new Date(), lastCount })
      .where(eq(retentionPolicies.rule, rule));
  }

  /** The due rows of a rule: those a run takes (`due`) and those a hold keeps (`held`). */
  async countDue(rule: RetentionRule, cutoff: Date) {
    const table: PgTable = rule.table;
    const condition = due(rule, cutoff);
    const [free, held] = await Promise.all(
      [
        notHeld(rule.subject, rule.table.id),
        not(notHeld(rule.subject, rule.table.id)),
      ].map((kept) =>
        this.db
          .select({ count: count() })
          .from(table)
          .where(and(condition, kept))
          .then((rows) => rows[0]?.count ?? 0),
      ),
    );
    return { due: free, held };
  }

  /**
   * The ids of up to `limit` due rows not held, locked (and checked for
   * holds) in the same statement; rows another batch holds are skipped.
   */
  async lockDue(rule: RetentionRule, cutoff: Date, limit: number) {
    const id = rule.table.id;
    const rows = await this.db
      .select({ id })
      .from(rule.table as PgTable)
      .where(and(due(rule, cutoff), notHeld(rule.subject, id)))
      .orderBy(asc(id))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map((row) => row.id as string);
  }

  async deleteRows(rule: RetentionRule, ids: string[]) {
    await this.db
      .delete(rule.table as PgTable)
      .where(inArray(rule.table.id, ids));
  }

  async anonymiseRows(rule: RetentionRule, ids: string[]) {
    await this.db
      .update(rule.table as PgTable)
      .set(rule.anonymise!.set as never)
      .where(inArray(rule.table.id, ids));
  }
}
