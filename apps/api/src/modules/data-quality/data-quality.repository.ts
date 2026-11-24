import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { afterCursor } from '../../core/http/pagination.js';
import type { RecordRow, RecordTable } from '../records/record.js';
import type { FindingsQuery } from './data-quality.schemas.js';
import {
  dataQualityFindings as findings,
  dataQualityScans as scans,
} from './data-quality.tables.js';

type NewScan = typeof scans.$inferInsert;
type NewFinding = typeof findings.$inferInsert;

/**
 * Which of a subject's findings a reader sees (DataQualityService decides
 * it): on the records `readable` lets through, never on a hidden field, nor
 * of a rule that reads one, and a duplicate only when they may read one of
 * the others too.
 */
export interface FindingVisibility {
  subject: string;
  table: RecordTable;
  hiddenFields: string[];
  hiddenRules: string[];
  readable: SQL | undefined;
  duplicates: boolean;
}

/**
 * A duplicate finding's other records in SQL, for one finding of the outer
 * query: `$.duplicateOf[*]` is lax, so a single id (written before) reads
 * as one. Drizzle has no jsonpath.
 */
const duplicateIds = sql`(select (jsonb_path_query(${findings.detail}, '$.duplicateOf[*]') #>> '{}')::uuid)`;

/** The live records of a table: the recycle bin's are not checked. */
const live = (table: RecordTable) =>
  table.deletedAt ? isNull(table.deletedAt) : undefined;

/** The data-quality scans' and findings' queries, in the caller's transaction and tenant. */
@Injectable()
export class DataQualityRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  private visible(v: FindingVisibility) {
    const t = v.table;
    return and(
      eq(findings.subject, v.subject),
      v.hiddenFields.length
        ? or(
            eq(findings.check, 'rule'),
            notInArray(findings.field, v.hiddenFields),
          )
        : undefined,
      v.hiddenRules.length
        ? or(
            ne(findings.check, 'rule'),
            notInArray(findings.field, v.hiddenRules),
          )
        : undefined,
      v.readable,
      // The subquery's own table shadows the outer one, so the read filter
      // applies to the other records.
      v.duplicates && v.readable
        ? or(
            ne(findings.check, 'duplicate'),
            exists(
              this.db
                .select({ id: t.id })
                .from(t as unknown as PgTable)
                .where(and(inArray(t.id, duplicateIds), v.readable)),
            ),
          )
        : undefined,
    );
  }

  async lastScan() {
    const [row] = await this.db
      .select()
      .from(scans)
      .orderBy(desc(scans.createdAt), desc(scans.id))
      .limit(1);
    return row;
  }

  /** The visible findings by severity: how many, and how many dismissed. */
  async severityCounts(v: FindingVisibility) {
    return this.db
      .select({
        severity: findings.severity,
        total: count(),
        dismissed: count(findings.dismissedAt),
      })
      .from(findings)
      .innerJoin(
        v.table as unknown as PgTable,
        eq(v.table.id, findings.recordId),
      )
      .where(this.visible(v))
      .groupBy(findings.severity);
  }

  /** A page of visible findings, newest first (one row more than the limit). */
  async findings(
    v: FindingVisibility,
    query: FindingsQuery,
    recordId?: string,
  ) {
    return this.db
      .select(getColumns(findings))
      .from(findings)
      .innerJoin(
        v.table as unknown as PgTable,
        eq(v.table.id, findings.recordId),
      )
      .where(
        and(
          this.visible(v),
          recordId ? eq(findings.recordId, recordId) : undefined,
          query.dismissed
            ? isNotNull(findings.dismissedAt)
            : isNull(findings.dismissedAt),
          query.severity ? eq(findings.severity, query.severity) : undefined,
          query.check ? eq(findings.check, query.check) : undefined,
          afterCursor(findings.id, query),
        ),
      )
      .orderBy(desc(findings.id))
      .limit(query.limit + 1);
  }

  /** The latest queued or running scan, locked until the transaction ends. */
  async lockRunningScan() {
    const [row] = await this.db
      .select()
      .from(scans)
      .where(inArray(scans.status, ['queued', 'running']))
      .orderBy(desc(scans.createdAt))
      .limit(1)
      .for('update');
    return row;
  }

  async findScan(id: string) {
    const [row] = await this.db.select().from(scans).where(eq(scans.id, id));
    return row;
  }

  async insertScan(values: NewScan) {
    const [row] = await this.db.insert(scans).values(values).returning();
    return row!;
  }

  async updateScan(id: string, values: Partial<NewScan>) {
    await this.db.update(scans).set(values).where(eq(scans.id, id));
  }

  /** A batch read: the scan runs, `read` more records checked. */
  async addScanned(id: string, read: number) {
    await this.db
      .update(scans)
      .set({ status: 'running', scanned: sql`${scans.scanned} + ${read}` })
      .where(eq(scans.id, id));
  }

  async countLive(table: RecordTable) {
    const [row] = await this.db
      .select({ n: count() })
      .from(table as unknown as PgTable)
      .where(live(table));
    return row!.n;
  }

  /** The next live records of a table after `after`, by id. */
  async liveBatch(
    table: RecordTable,
    after: string | undefined,
    limit: number,
  ) {
    return (await this.db
      .select()
      .from(table as unknown as PgTable)
      .where(and(live(table), after ? gt(table.id, after) : undefined))
      .orderBy(asc(table.id))
      .limit(limit)) as RecordRow[];
  }

  /** The record, while it is live. */
  async liveRecord(table: RecordTable, id: string) {
    return (await this.db
      .select()
      .from(table as unknown as PgTable)
      .where(and(eq(table.id, id), live(table)))) as RecordRow[];
  }

  /** Deletes a subject's findings (of one record, when given) last checked before `before`. */
  async deleteCheckedBefore(subject: string, before: Date, recordId?: string) {
    await this.db
      .delete(findings)
      .where(
        and(
          eq(findings.subject, subject),
          recordId ? eq(findings.recordId, recordId) : undefined,
          lt(findings.checkedAt, before),
        ),
      );
  }

  async countOpen() {
    const [row] = await this.db
      .select({ n: count() })
      .from(findings)
      .where(isNull(findings.dismissedAt));
    return row!.n;
  }

  async findFinding(id: string) {
    const [row] = await this.db
      .select()
      .from(findings)
      .where(eq(findings.id, id));
    return row;
  }

  /** Whether the finding is one `v` shows. */
  async isVisible(id: string, v: FindingVisibility) {
    const [shown] = await this.db
      .select({ id: findings.id })
      .from(findings)
      .innerJoin(
        v.table as unknown as PgTable,
        eq(v.table.id, findings.recordId),
      )
      .where(and(eq(findings.id, id), this.visible(v)));
    return !!shown;
  }

  async updateFinding(id: string, values: Partial<NewFinding>) {
    const [row] = await this.db
      .update(findings)
      .set(values)
      .where(eq(findings.id, id))
      .returning();
    return row!;
  }

  async deleteOfRecords(subject: string, ids: readonly string[]) {
    await this.db
      .delete(findings)
      .where(
        and(
          eq(findings.subject, subject),
          inArray(findings.recordId, [...ids]),
        ),
      );
  }

  /** Writes the findings found at `now`; one already there keeps its dismissal. */
  async upsertFindings(rows: NewFinding[], now: Date) {
    await this.db
      .insert(findings)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          findings.tenantId,
          findings.subject,
          findings.recordId,
          findings.check,
          findings.field,
        ],
        // `excluded` is the row proposed.
        set: {
          severity: sql`excluded.severity`,
          detail: sql`excluded.detail`,
          checkedAt: now,
        },
      });
  }

  /** Which of these ids of a table `allowed` lets through. */
  async allowedIds(
    table: RecordTable,
    ids: string[],
    allowed: SQL | undefined,
  ) {
    const rows = await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(and(inArray(table.id, ids), allowed));
    return rows.map((row) => row.id as string);
  }

  /** Which of these ids of a table are in its recycle bin. */
  async binnedIds(table: RecordTable, ids: string[]) {
    const rows = await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(and(inArray(table.id, ids), isNotNull(table.deletedAt!)));
    return rows.map((row) => row.id as string);
  }

  /** The live records whose `field`, trimmed and case-folded, is one of `keys`, by id. */
  async withKeys(table: RecordTable, field: string, keys: string[]) {
    // Drizzle has no lower() or trim(): the key is a case-folded, trimmed value.
    const key = sql<string>`lower(trim(${table[field]!}))`;
    return (await this.db
      .select({ id: table.id, key })
      .from(table as unknown as PgTable)
      .where(and(live(table), inArray(key, keys)))
      .orderBy(asc(table.id))) as { id: string; key: string }[];
  }

  /** Deletes up to `limit` findings checked before `before`; how many went. */
  async deleteFindingsBefore(before: Date, limit: number) {
    const rows = await this.db
      .delete(findings)
      .where(
        inArray(
          findings.id,
          this.db
            .select({ id: findings.id })
            .from(findings)
            .where(lt(findings.checkedAt, before))
            .limit(limit),
        ),
      )
      .returning({ id: findings.id });
    return rows.length;
  }
}
