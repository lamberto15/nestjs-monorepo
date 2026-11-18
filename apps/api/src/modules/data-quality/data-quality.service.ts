import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
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
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { afterCursor } from '../../core/http/pagination.js';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import type { RecordRow, RecordTable } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { findProblems } from './data-quality.checks.js';
import {
  type DataQualityRegistration,
  DataQualityRegistry,
} from './data-quality.registry.js';
import type {
  DataQualityFindingView,
  DataQualityScanView,
  FindingsQuery,
} from './data-quality.schemas.js';
import {
  type DataQualityFindingRow,
  dataQualityFindings as findings,
  type DataQualityScanRow,
  dataQualityScans as scans,
  type QualitySeverity,
} from './data-quality.tables.js';

export const DATA_QUALITY_QUEUE = 'data-quality';
/** Records one job checks: a scan is many short jobs, never one long one. */
export const SCAN_BATCH = 500;
/** A scan queued or running longer than this is taken as lost (its worker gone): a new one may start. */
const SCAN_STALE_MS = 60 * 60 * 1000;

/** One batch of a scan: the subject's records after `after`, by id. */
export interface DataQualityJob extends TenantEnvelope {
  scanId: string;
  subject: string;
  after?: string;
}

/**
 * Data-quality checks over the records that declare them (README.md): a
 * scan runs on the queue in bounded batches and records its progress; it
 * adds the findings that hold and deletes those that no longer do. Nothing
 * here changes a record: a person fixes it, or dismisses the finding as
 * right as it is.
 *
 * Who may read DataQuality sees the findings on the records they may read,
 * never on a field their permissions hide (or show on some records only):
 * a finding would tell whether its value is empty or shared.
 */
@Injectable()
export class DataQualityService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly registry: DataQualityRegistry,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @InjectQueue(DATA_QUALITY_QUEUE)
    private readonly queue: Queue<DataQualityJob>,
  ) {}

  private table(registration: DataQualityRegistration) {
    return this.records.of(registration.subject).feature.table;
  }

  /** The live records of a table: the recycle bin's are not checked. */
  private live(table: RecordTable) {
    return table.deletedAt ? isNull(table.deletedAt) : undefined;
  }

  /** The open and dismissed findings per subject the principal may read, and the last scan. */
  async summary(principal: Principal) {
    const [last] = await this.db
      .select()
      .from(scans)
      .orderBy(desc(scans.createdAt), desc(scans.id))
      .limit(1);
    const subjects = [];
    for (const registration of this.registry.all()) {
      if (!(await this.access.can(principal, 'read', registration.subject))) {
        continue;
      }
      const rows = await this.db
        .select({
          severity: findings.severity,
          total: count(),
          dismissed: count(findings.dismissedAt),
        })
        .from(findings)
        .innerJoin(
          this.table(registration) as unknown as PgTable,
          eq(this.table(registration).id, findings.recordId),
        )
        .where(await this.visible(principal, registration))
        .groupBy(findings.severity);
      const open = (severity: QualitySeverity) => {
        const row = rows.find((r) => r.severity === severity);
        return row ? row.total - row.dismissed : 0;
      };
      subjects.push({
        subject: registration.subject,
        errors: open('error'),
        suggestions: open('suggestion'),
        dismissed: rows.reduce((sum, r) => sum + r.dismissed, 0),
      });
    }
    return { lastScan: last ? scanView(last) : null, subjects };
  }

  /** A page of a subject's findings the principal may see (of one record with `recordId`), newest first. */
  async findings(
    principal: Principal,
    subject: string,
    query: FindingsQuery,
    recordId?: string,
  ) {
    const registration = this.registration(subject);
    const t = this.table(registration);
    const rows = await this.db
      .select(getColumns(findings))
      .from(findings)
      .innerJoin(t as unknown as PgTable, eq(t.id, findings.recordId))
      .where(
        and(
          await this.visible(principal, registration),
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
    const items = rows.slice(0, query.limit);
    return {
      items: await this.views(principal, registration, items),
      nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
    };
  }

  /** Starts a scan of every registered record: one at a time per tenant (409 `scan_running`). */
  async startScan(principal: Principal, ip?: string) {
    const registrations = this.registry.all();
    const scan = await this.txHost.withTransaction(async () => {
      const [running] = await this.db
        .select()
        .from(scans)
        .where(inArray(scans.status, ['queued', 'running']))
        .orderBy(desc(scans.createdAt))
        .limit(1)
        .for('update');
      if (running) {
        if (Date.now() - running.createdAt.getTime() < SCAN_STALE_MS) {
          throw new ConflictException({
            code: 'scan_running',
            message: 'A data-quality scan is already running.',
          });
        }
        await this.db
          .update(scans)
          .set({ status: 'failed', finishedAt: new Date() })
          .where(eq(scans.id, running.id));
      }
      let total = 0;
      for (const registration of registrations) {
        const t = this.table(registration);
        const [row] = await this.db
          .select({ n: count() })
          .from(t as unknown as PgTable)
          .where(this.live(t));
        total += row!.n;
      }
      const [created] = await this.db
        .insert(scans)
        .values({
          total,
          status: registrations.length ? 'queued' : 'completed',
          findings: registrations.length ? null : 0,
          finishedAt: registrations.length ? null : new Date(),
          startedBy: principalKey(principal),
          // The app's clock, as the findings' checkedAt: what the last sweep compares.
          createdAt: new Date(),
        })
        .returning();
      await this.audit.record(principal, {
        action: 'data-quality.scan-started',
        targetType: 'dataQualityScan',
        targetId: created!.id,
        details: { total },
        ip,
      });
      return created!;
    });
    if (registrations[0]) {
      try {
        await this.queue.add(
          'batch',
          withTenant({ scanId: scan.id, subject: registrations[0].subject }),
        );
      } catch (error) {
        await this.fail(scan.id);
        throw error;
      }
    }
    return scanView(scan);
  }

  /**
   * One batch of a scan (DataQualityProcessor): checks the next SCAN_BATCH
   * records of the job's subject and records the progress. Answers the next
   * job, or null when the scan is done (or gone).
   */
  async batch(job: DataQualityJob): Promise<DataQualityJob | null> {
    const [scan] = await this.db
      .select()
      .from(scans)
      .where(eq(scans.id, job.scanId));
    if (!scan || scan.status === 'failed' || scan.status === 'completed') {
      return null;
    }
    const registrations = this.registry.all();
    const index = registrations.findIndex((r) => r.subject === job.subject);
    const registration = registrations[index];
    let read = 0;
    let last: string | undefined;
    if (registration) {
      // The scan reads every live record as the system, in the job's tenant
      // (row-level security); who sees a finding is decided when it is read.
      const t = this.table(registration);
      const rows = (await this.db
        .select()
        .from(t as unknown as PgTable)
        .where(and(this.live(t), job.after ? gt(t.id, job.after) : undefined))
        .orderBy(asc(t.id))
        .limit(SCAN_BATCH)) as RecordRow[];
      await this.record(registration, rows, new Date());
      read = rows.length;
      last = rows.at(-1)?.id;
    }
    await this.db
      .update(scans)
      .set({ status: 'running', scanned: sql`${scans.scanned} + ${read}` })
      .where(eq(scans.id, scan.id));
    if (registration && read === SCAN_BATCH) {
      return { ...job, after: last };
    }
    // The subject is done: what this scan didn't find again no longer holds.
    await this.db
      .delete(findings)
      .where(
        and(
          eq(findings.subject, job.subject),
          lt(findings.checkedAt, scan.createdAt),
        ),
      );
    const next = registrations[index + 1];
    if (next) {
      return { tenantId: job.tenantId, scanId: scan.id, subject: next.subject };
    }
    const [open] = await this.db
      .select({ n: count() })
      .from(findings)
      .where(isNull(findings.dismissedAt));
    await this.db
      .update(scans)
      .set({ status: 'completed', findings: open!.n, finishedAt: new Date() })
      .where(eq(scans.id, scan.id));
    return null;
  }

  /** A scan that failed for good (DataQualityProcessor). */
  async fail(scanId: string) {
    await this.db
      .update(scans)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(eq(scans.id, scanId));
  }

  /** Queues a scan's next batch. */
  queueNext(job: DataQualityJob) {
    return this.queue.add('batch', job);
  }

  /** Dismisses a finding: right as it is. It stays dismissed while it holds. */
  async dismiss(principal: Principal, id: string, ip?: string) {
    const finding = await this.findOne(principal, id);
    const row = await this.txHost.withTransaction(async () => {
      const [updated] = await this.db
        .update(findings)
        .set({ dismissedAt: new Date(), dismissedBy: principalKey(principal) })
        .where(eq(findings.id, id))
        .returning();
      await this.audit.record(principal, {
        action: 'data-quality.finding-dismissed',
        targetType: 'dataQualityFinding',
        targetId: id,
        details: {
          subject: finding.subject,
          recordId: finding.recordId,
          check: finding.check,
          field: finding.field,
        },
        ip,
      });
      return updated!;
    });
    const [view] = await this.views(principal, this.registration(row.subject), [
      row,
    ]);
    return view!;
  }

  /** Checks a finding's record again now: the finding if it still holds. */
  async recheck(principal: Principal, id: string) {
    const finding = await this.findOne(principal, id);
    await this.recheckRecord(finding.subject, finding.recordId);
    // As the caller may see it now: it may name another duplicate.
    const still = await this.seen(principal, id);
    const [view] = still
      ? await this.views(principal, this.registration(still.subject), [still])
      : [];
    return { resolved: !still, finding: view ?? null };
  }

  /** Forgets the findings of records deleted for good (DataQualityExtension). */
  async forget(subject: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    await this.db
      .delete(findings)
      .where(
        and(
          eq(findings.subject, subject),
          inArray(findings.recordId, [...ids]),
        ),
      );
  }

  /** Checks one record again: its findings now (none once it is in the recycle bin). */
  private async recheckRecord(subject: string, recordId: string) {
    const registration = this.registration(subject);
    const t = this.table(registration);
    const now = new Date();
    await this.txHost.withTransaction(async () => {
      const rows = (await this.db
        .select()
        .from(t as unknown as PgTable)
        .where(and(eq(t.id, recordId), this.live(t)))) as RecordRow[];
      await this.record(registration, rows, now);
      await this.db
        .delete(findings)
        .where(
          and(
            eq(findings.subject, subject),
            eq(findings.recordId, recordId),
            lt(findings.checkedAt, now),
          ),
        );
    });
  }

  /** A finding the principal may see, or a 404 (the same for one they may not). */
  private async findOne(principal: Principal, id: string) {
    const row = await this.seen(principal, id);
    if (row) return row;
    throw new NotFoundException({
      code: 'finding_not_found',
      message: `No data-quality finding ${id} that you may see.`,
    });
  }

  /** A finding, if the principal may see it. */
  private async seen(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(findings)
      .where(eq(findings.id, id));
    const registration = row && this.registry.find(row.subject);
    if (!registration) return undefined;
    const t = this.table(registration);
    const [shown] = await this.db
      .select({ id: findings.id })
      .from(findings)
      .innerJoin(t as unknown as PgTable, eq(t.id, findings.recordId))
      .where(
        and(eq(findings.id, id), await this.visible(principal, registration)),
      );
    return shown ? row : undefined;
  }

  /** The findings of a subject the principal may see: on records they may read, on fields shown to them. */
  private async visible(
    principal: Principal,
    registration: DataQualityRegistration,
  ): Promise<SQL | undefined> {
    const { subject } = registration;
    const hidden = [
      ...(await this.access.deniedFields(principal, 'read', subject)),
      ...(await this.access.conditionalFields(principal, 'read', subject)),
    ];
    // A rule that reads a hidden field tells its value as well as the field does.
    const rules = registration.rules
      .filter((rule) =>
        rule.compiled.reads.some((name) => hidden.includes(name)),
      )
      .map((rule) => rule.name);
    const readable = await this.access.sqlFilter(principal, subject, 'read');
    const t = this.table(registration);
    return and(
      eq(findings.subject, subject),
      hidden.length
        ? or(eq(findings.check, 'rule'), notInArray(findings.field, hidden))
        : undefined,
      rules.length
        ? or(ne(findings.check, 'rule'), notInArray(findings.field, rules))
        : undefined,
      readable,
      // A duplicate names the other records and tells their value: shown
      // only when the reader may read one of them too (views() shows only
      // those). The subquery's own table shadows the outer one, so the read
      // filter applies to the other records.
      registration.duplicates.length && readable
        ? or(
            ne(findings.check, 'duplicate'),
            exists(
              this.db
                .select({ id: t.id })
                .from(t as unknown as PgTable)
                .where(and(inArray(t.id, duplicateIds), readable)),
            ),
          )
        : undefined,
    );
  }

  /** Findings as the API shows them to `principal`: a duplicate names only the records they may read. */
  private async views(
    principal: Principal,
    registration: DataQualityRegistration,
    rows: DataQualityFindingRow[],
  ): Promise<DataQualityFindingView[]> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.check === 'duplicate' ? duplicatesOf(row) : [],
        ),
      ),
    ];
    const t = this.table(registration);
    const readable = new Set(
      ids.length
        ? (
            await this.db
              .select({ id: t.id })
              .from(t as unknown as PgTable)
              .where(
                and(
                  inArray(t.id, ids),
                  await this.access.sqlFilter(
                    principal,
                    registration.subject,
                    'read',
                  ),
                ),
              )
          ).map((row) => row.id as string)
        : [],
    );
    return rows.map((row) => {
      const view = findingView(row);
      if (row.check !== 'duplicate' || !view.detail) return view;
      return {
        ...view,
        detail: {
          ...view.detail,
          duplicateOf: duplicatesOf(row).filter((id) => readable.has(id)),
        },
      };
    });
  }

  private registration(subject: string) {
    const registration = this.registry.find(subject);
    if (!registration) {
      throw new NotFoundException({
        code: 'subject_not_found',
        message: `No data-quality checks for "${subject}".`,
      });
    }
    return registration;
  }

  /** Runs the checks on these records and writes what holds, found at `now`. */
  private async record(
    registration: DataQualityRegistration,
    rows: RecordRow[],
    now: Date,
  ) {
    if (rows.length === 0) return;
    const found = await findProblems(
      this.db,
      registration,
      this.table(registration),
      rows,
    );
    if (found.length === 0) return;
    await this.db
      .insert(findings)
      .values(
        found.map((f) => ({
          ...f,
          subject: registration.subject,
          checkedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          findings.tenantId,
          findings.subject,
          findings.recordId,
          findings.check,
          findings.field,
        ],
        // Dismissed stays dismissed: the problem is the same one. `excluded` is the row proposed.
        set: {
          severity: sql`excluded.severity`,
          detail: sql`excluded.detail`,
          checkedAt: now,
        },
      });
  }
}

/** A duplicate finding's other records (one id, as findings written before held it, or several). */
function duplicatesOf(row: DataQualityFindingRow): string[] {
  const ids = row.detail?.duplicateOf;
  return ids === undefined ? [] : [ids].flat();
}

/**
 * The same ids in SQL, for one finding of the outer query: `$.duplicateOf[*]`
 * is lax, so a single id (written before) reads as one. Drizzle has no jsonpath.
 */
const duplicateIds = sql`(select (jsonb_path_query(${findings.detail}, '$.duplicateOf[*]') #>> '{}')::uuid)`;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function scanView(row: DataQualityScanRow): DataQualityScanView {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    scanned: row.scanned,
    findings: row.findings,
    startedBy: row.startedBy,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

function findingView(row: DataQualityFindingRow): DataQualityFindingView {
  return {
    id: row.id,
    subject: row.subject,
    recordId: row.recordId,
    check: row.check,
    field: row.field,
    severity: row.severity,
    detail: row.detail ?? null,
    checkedAt: row.checkedAt.toISOString(),
    dismissedAt: iso(row.dismissedAt),
    dismissedBy: row.dismissedBy,
  };
}
