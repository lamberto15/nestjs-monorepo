import { TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { onceJob } from '../../core/queues/queues.js';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import type { RecordRow } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { findProblems } from './data-quality.checks.js';
import {
  type DataQualityRegistration,
  DataQualityRegistry,
} from './data-quality.registry.js';
import {
  DataQualityRepository,
  type FindingVisibility,
} from './data-quality.repository.js';
import type {
  DataQualityFindingView,
  DataQualityScanView,
  FindingsQuery,
} from './data-quality.schemas.js';
import type {
  DataQualityFindingRow,
  DataQualityScanRow,
  QualitySeverity,
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
    private readonly repository: DataQualityRepository,
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

  /** The open and dismissed findings per subject the principal may read, and the last scan. */
  async summary(principal: Principal) {
    const last = await this.repository.lastScan();
    const subjects = [];
    for (const registration of this.registry.all()) {
      if (!(await this.access.can(principal, 'read', registration.subject))) {
        continue;
      }
      const rows = await this.repository.severityCounts(
        await this.visible(principal, registration),
      );
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
    const rows = await this.repository.findings(
      await this.visible(principal, registration),
      query,
      recordId,
    );
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
      const running = await this.repository.lockRunningScan();
      if (running) {
        if (Date.now() - running.createdAt.getTime() < SCAN_STALE_MS) {
          throw new ConflictException({
            code: 'scan_running',
            message: 'A data-quality scan is already running.',
          });
        }
        await this.repository.updateScan(running.id, {
          status: 'failed',
          finishedAt: new Date(),
        });
      }
      let total = 0;
      for (const registration of registrations) {
        total += await this.repository.countLive(this.table(registration));
      }
      const created = await this.repository.insertScan({
        total,
        status: registrations.length ? 'queued' : 'completed',
        findings: registrations.length ? null : 0,
        finishedAt: registrations.length ? null : new Date(),
        startedBy: principalKey(principal),
        // The app's clock, as the findings' checkedAt: what the last sweep compares.
        createdAt: new Date(),
      });
      await this.audit.record(principal, {
        action: 'data-quality.scan-started',
        targetType: 'dataQualityScan',
        targetId: created.id,
        details: { total },
        ip,
      });
      return created;
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
    const scan = await this.repository.findScan(job.scanId);
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
      const rows = await this.repository.liveBatch(
        this.table(registration),
        job.after,
        SCAN_BATCH,
      );
      await this.record(registration, rows, new Date());
      read = rows.length;
      last = rows.at(-1)?.id;
    }
    await this.repository.addScanned(scan.id, read);
    if (registration && read === SCAN_BATCH) {
      return { ...job, after: last };
    }
    // The subject is done: what this scan didn't find again no longer holds.
    await this.repository.deleteCheckedBefore(job.subject, scan.createdAt);
    const next = registrations[index + 1];
    if (next) {
      return { tenantId: job.tenantId, scanId: scan.id, subject: next.subject };
    }
    await this.repository.updateScan(scan.id, {
      status: 'completed',
      findings: await this.repository.countOpen(),
      finishedAt: new Date(),
    });
    return null;
  }

  /** A scan that failed for good (DataQualityProcessor). */
  async fail(scanId: string) {
    await this.repository.updateScan(scanId, {
      status: 'failed',
      finishedAt: new Date(),
    });
  }

  /**
   * Queues a scan's next batch, its id from the work (the scan, the
   * subject, where the batch starts): a batch retried after it queued its
   * next queues nothing new.
   */
  queueNext(job: DataQualityJob) {
    return this.queue.add(
      'batch',
      job,
      onceJob(
        `data-quality-${job.scanId}-${job.subject}-${job.after ?? 'start'}`,
      ),
    );
  }

  /** Dismisses a finding: right as it is. It stays dismissed while it holds. */
  async dismiss(principal: Principal, id: string, ip?: string) {
    const finding = await this.findOne(principal, id);
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository.updateFinding(id, {
        dismissedAt: new Date(),
        dismissedBy: principalKey(principal),
      });
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
      return updated;
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
    await this.repository.deleteOfRecords(subject, ids);
  }

  /** Checks one record again: its findings now (none once it is in the recycle bin). */
  private async recheckRecord(subject: string, recordId: string) {
    const registration = this.registration(subject);
    const now = new Date();
    await this.txHost.withTransaction(async () => {
      const rows = await this.repository.liveRecord(
        this.table(registration),
        recordId,
      );
      await this.record(registration, rows, now);
      await this.repository.deleteCheckedBefore(subject, now, recordId);
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
    const row = await this.repository.findFinding(id);
    const registration = row && this.registry.find(row.subject);
    if (!registration) return undefined;
    const shown = await this.repository.isVisible(
      id,
      await this.visible(principal, registration),
    );
    return shown ? row : undefined;
  }

  /** The findings of a subject the principal may see: on records they may read, on fields shown to them. */
  private async visible(
    principal: Principal,
    registration: DataQualityRegistration,
  ): Promise<FindingVisibility> {
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
    return {
      subject,
      table: this.table(registration),
      hiddenFields: hidden,
      hiddenRules: rules,
      readable: await this.access.sqlFilter(principal, subject, 'read'),
      // A duplicate names the other records and tells their value: shown
      // only when the reader may read one of them too (views() shows only
      // those).
      duplicates: registration.duplicates.length > 0,
    };
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
    const readable = new Set(
      ids.length
        ? await this.repository.allowedIds(
            this.table(registration),
            ids,
            await this.access.sqlFilter(
              principal,
              registration.subject,
              'read',
            ),
          )
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
      this.repository,
      registration,
      this.table(registration),
      rows,
    );
    if (found.length === 0) return;
    // Dismissed stays dismissed: the problem is the same one.
    await this.repository.upsertFindings(
      found.map((f) => ({
        ...f,
        subject: registration.subject,
        checkedAt: now,
      })),
      now,
    );
  }
}

/** A duplicate finding's other records (one id, as findings written before held it, or several). */
function duplicatesOf(row: DataQualityFindingRow): string[] {
  const ids = row.detail?.duplicateOf;
  return ids === undefined ? [] : [ids].flat();
}

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
