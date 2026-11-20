import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import type { Job } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { isTenantFileKey } from '../storage/storage.keys.js';
import {
  dataExportReady,
  dataFailed,
  dataImportFinished,
  dataProgress,
  transferFinished,
  type TransferFinished,
} from './data-transfer.events.js';
import {
  DATA_TRANSFERS,
  publicReason,
  shownReason,
  TransferRefused,
  transferKey,
} from './data-transfer.service.js';
import type {
  ImportRowError,
  TransferColumn,
  TransferFormat,
  TransferJob,
  TransferResult,
} from './data-transfer.types.js';
import {
  CONTENT_TYPES,
  createWriter,
  FormatError,
  readRecords,
} from './formats.js';
import { MappingError } from './import-mapping.js';
import { PrincipalNow } from './principal-now.js';
import {
  TENANT_EXPORT,
  TENANT_EXPORT_COLUMNS,
  TenantExport,
} from './tenant-export.js';
import { TRANSFER_LINK_TTL_MS } from './transfer-retention.js';
import { referenceColumns, bodyOf, importSchema } from './record-transfer.js';
import { type ImportRow, RecordTransfers } from './record-transfers.js';

type ExportJob = Extract<TransferJob, { kind: 'export' }>;
type ImportJob = Extract<TransferJob, { kind: 'import' }>;

/** An import reports its progress every this many rows. */
const PROGRESS_EVERY = 500;
/** An export tells its progress at most this often (ms). */
const PROGRESS_INTERVAL = 1000;
/** Rows written in one transaction. */
const GROUP = 200;
/** Errors kept in an import's report: past it, the import is stopped as unusable. */
const MAX_ERRORS = 10_000;

/**
 * Runs exports and imports on the workers, in the tenant the job was
 * started in (TenantWorkerHost). The principal is looked up again first: a
 * user deactivated meanwhile, or no longer a member, gets nothing. When a
 * transfer ends, `transferFinished` is published (a scheduled report mails
 * its file): on completion here, on a failure for good in `onFailed`,
 * which also hears a job BullMQ fails itself (its worker died mid-run).
 */
@Processor(DATA_TRANSFERS, { concurrency: 2 })
export class DataTransferProcessor extends TenantWorkerHost<
  TransferJob,
  TransferResult
> {
  private readonly logger = new Logger('DataTransfer');

  constructor(
    private readonly transfers: RecordTransfers,
    private readonly tenantExport: TenantExport,
    private readonly principals: PrincipalNow,
    private readonly audit: AuditService,
    private readonly events: Events,
    private readonly disk: StorageDisk,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly realtime: Realtime,
  ) {
    super();
  }

  async handle(job: Job<TransferJob>): Promise<TransferResult> {
    let result: TransferResult;
    try {
      const { kind, id, tenantId } = job.data.principal;
      const principal =
        tenantId === job.data.tenantId && job.data.tenantId
          ? await this.principals.of(kind, id, job.data.tenantId)
          : null;
      if (!principal) {
        throw new TransferRefused(
          'The account that started this transfer is no longer active.',
        );
      }
      result =
        job.data.kind === 'export'
          ? await this.export(job as Job<ExportJob>, principal)
          : await this.import(job as Job<ImportJob>, principal);
    } catch (error) {
      // What people may read is marked; the rest stays in the logs.
      if (
        error instanceof TransferRefused ||
        error instanceof FormatError ||
        error instanceof MappingError
      ) {
        throw new Error(shownReason(error.message));
      }
      throw error;
    }
    await this.finished({
      id: job.id!,
      job: job.data,
      status: 'completed',
      result,
    });
    return result;
  }

  /** Failed for good (one attempt), or failed by BullMQ for stalling: the event says so. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<TransferJob> | undefined, error: Error) {
    if (!job) return;
    this.logger.warn('A transfer failed', { id: job.id, error: error.message });
    await inTenantOf(job.data, async () => {
      await this.finished({
        id: job.id!,
        job: job.data,
        status: 'failed',
        error: error.message,
      });
      // After the queue marked it failed, so a refetch says `failed`.
      this.realtime.toPrincipal(job.data.principal, dataFailed, {
        id: job.id!,
        name: job.data.name,
        kind: job.data.kind,
        error: publicReason(error.message),
      });
    }).catch((failure: unknown) =>
      this.logger.error('A failed transfer could not be announced', {
        id: job.id,
        error: String(failure),
      }),
    );
  }

  private finished(event: TransferFinished) {
    return this.txHost.withTransaction(() =>
      this.events.publish(transferFinished, event, { key: event.id }),
    );
  }

  private async export(
    job: Job<ExportJob>,
    principal: RequestPrincipal,
  ): Promise<TransferResult> {
    const { name, format, filters, sort, timezone } = job.data;
    let columns: readonly TransferColumn[];
    let pages: AsyncIterable<Record<string, unknown>[]>;
    if (name === TENANT_EXPORT) {
      // The operators' export of a whole tenant: checked again, the operator may have lost the right since.
      const tenantId = filters.tenantId;
      if (!tenantId || !(await this.tenantExport.allowed(principal))) {
        throw new TransferRefused('Nothing to export named "tenant".');
      }
      columns = TENANT_EXPORT_COLUMNS;
      pages = this.tenantExport.batches(tenantId);
    } else {
      const registration = this.transfers.find(name);
      if (!registration)
        throw new TransferRefused(`Nothing to export named "${name}".`);
      // Parsed again here: the job is JSON, and the permissions may have changed since.
      const listed = await this.transfers.query(
        principal,
        registration,
        filters,
        sort,
      );
      columns = await this.transfers.exportColumns(registration);
      pages = this.transfers.pages(principal, registration, listed);
    }
    const key = transferKey(job.data.tenantId!, `${job.id}.${format}`);
    let rows = 0;
    let toldAt = 0;
    await this.writeFile(
      key,
      format,
      columns,
      async (write) => {
        for await (const batch of pages) {
          await write(batch);
          rows += batch.length;
          await job.updateProgress({ processed: rows });
          if (Date.now() - toldAt >= PROGRESS_INTERVAL) {
            toldAt = Date.now();
            this.realtime.toPrincipal(principal, dataProgress, {
              id: job.id!,
              name,
              kind: 'export',
              processed: rows,
            });
          }
        }
      },
      timezone,
    );
    this.realtime.toPrincipal(principal, dataExportReady, {
      id: job.id!,
      name,
      rows,
      url: await this.disk.signedUrl(key, { expiresIn: TRANSFER_LINK_TTL_MS }),
    });
    await this.audit.record(principal, {
      action: 'data.exported',
      targetType: 'data-transfer',
      targetId: job.id,
      details: { name, format, rows },
    });
    return { kind: 'export', key, rows };
  }

  private async import(
    job: Job<ImportJob>,
    principal: RequestPrincipal,
  ): Promise<TransferResult> {
    const { name, format, key, dryRun, matchOn, mapping, limits } = job.data;
    const tenantId = job.data.tenantId!;
    // A payload naming another key (another tenant's file) is refused, neither read nor deleted.
    if (!isTenantFileKey(tenantId, key)) {
      throw new TransferRefused(
        'The upload is not one of this tenant’s files.',
      );
    }
    const registration = this.transfers.find(name);
    if (
      !registration ||
      !(await this.transfers.mayImport(principal, registration, matchOn))
    ) {
      await this.disk.delete(key).catch(() => undefined);
      throw new TransferRefused(`Nothing to import named "${name}".`);
    }
    const { declaration } = registration;
    // Read once: every row of a file is checked against the same fields.
    const columns = await this.transfers.importColumns(principal, registration);
    const allowed = new Set(columns.map((column) => column.name));
    // A reference's column (`product`) fills its field (`productId`).
    for (const { field, column } of referenceColumns(declaration)) {
      if (allowed.has(column)) allowed.add(field);
    }
    const references = this.transfers.referenceReader(principal, registration);
    const schema = importSchema(declaration);
    // What add-ons put in a row's body besides its fields (custom values).
    const addOns = await this.transfers.importReader(registration);
    // A dry run writes nothing, so the add-ons' hooks never see its rows:
    // their check runs here instead, with the same errors.
    const addOnIssues = dryRun
      ? await this.transfers.importCheck(registration)
      : undefined;
    const dateColumns = new Set(
      columns.filter((column) => column.type === 'date').map((c) => c.name),
    );
    const action = matchOn ? 'update' : 'create';
    const errors: ImportRowError[] = [];
    const group: ImportRow[] = [];
    const seen = new Set<string>();
    let rows = 0;
    let imported = 0;
    const refuse = (refused: ImportRowError[]) => {
      errors.push(...refused);
      if (errors.length > MAX_ERRORS) {
        throw new TransferRefused(
          `More than ${MAX_ERRORS} errors: check the file's format and columns.`,
        );
      }
    };
    const flush = async () => {
      if (!group.length) return;
      const { written, errors: refused } = await this.transfers.write(
        principal,
        registration,
        group.splice(0),
        matchOn,
      );
      imported += written;
      refuse(refused);
    };
    try {
      const { body } = await this.disk.get(key);
      // The job's size limit, on the bytes read (the upload was refused past it already).
      let size = 0;
      const sized = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > limits.maxBytes) {
            callback(
              new TransferRefused(
                `The file is larger than the ${limits.maxBytes} byte limit.`,
              ),
            );
          } else {
            callback(null, chunk);
          }
        },
      });
      pipeline(body, sized).catch(() => undefined);
      for await (const { row, record } of readRecords(format, sized, {
        dateColumns,
        mapping,
      })) {
        if (row > limits.maxRows) {
          throw new TransferRefused(
            `The file has more than the ${limits.maxRows} row limit.`,
          );
        }
        rows = row;
        if (row === 1 && matchOn && !Object.hasOwn(record, matchOn)) {
          throw new TransferRefused(
            `The file is missing the match column "${matchOn}".`,
          );
        }
        let match: string | undefined;
        if (matchOn) {
          const key = record[matchOn];
          match = (
            typeof key === 'string' ? key : JSON.stringify(key ?? '')
          ).trim();
          if (!match) {
            refuse([
              { row, path: matchOn, message: 'A match key is required.' },
            ]);
            continue;
          }
          if (seen.has(match)) {
            refuse([
              {
                row,
                path: matchOn,
                message: `The ${matchOn} is repeated in this file.`,
              },
            ]);
            continue;
          }
          seen.add(match);
        }
        // Each row as one POST (or PATCH) of the record: its schema, the
        // field-level permissions, then the store (its 4xx refuses the row).
        const unknownKeys = await references(record);
        if (unknownKeys.length) {
          refuse(unknownKeys.map((issue) => ({ row, ...issue })));
          continue;
        }
        const body = bodyOf(declaration, record);
        const forbidden = Object.keys(body).filter(
          (field) => !allowed.has(field),
        );
        const parsed = (matchOn ? schema.partial() : schema).safeParse(body);
        if (forbidden.length) {
          refuse(
            forbidden.map((field) => ({
              row,
              path: field,
              message: 'You may not set this field.',
            })),
          );
        } else if (!parsed.success) {
          refuse(
            parsed.error.issues.map((issue) => ({
              row,
              path: issue.path.join('.'),
              message: issue.message,
            })),
          );
        } else if (dryRun) {
          const issues = addOnIssues!(addOns(record), action);
          if (issues.length) {
            refuse(issues.map((issue) => ({ row, ...issue })));
          } else {
            imported++;
          }
        } else {
          group.push({
            row,
            body: { ...parsed.data, ...addOns(record) },
            match,
          });
          if (group.length >= GROUP) await flush();
        }
        if (row % PROGRESS_EVERY === 0) {
          await job.updateProgress({
            processed: rows,
            imported,
            failed: errors.length,
          });
          this.realtime.toPrincipal(principal, dataProgress, {
            id: job.id!,
            name,
            kind: 'import',
            processed: rows,
            imported,
            failed: errors.length,
          });
        }
      }
      await flush();
    } finally {
      // The upload was only a means: it goes, whatever happened.
      await this.disk.delete(key).catch(() => undefined);
    }
    let errorsKey: string | undefined;
    if (errors.length) {
      errorsKey = transferKey(tenantId, `${job.id}-errors.csv`);
      await this.writeFile(
        errorsKey,
        'csv',
        [{ key: 'row' }, { key: 'path', header: 'field' }, { key: 'message' }],
        (write) => write(errors as unknown as Record<string, unknown>[]),
      );
    }
    const failed = new Set(errors.map((error) => error.row)).size;
    this.realtime.toPrincipal(principal, dataImportFinished, {
      id: job.id!,
      name,
      rows,
      imported,
      failed,
    });
    await this.audit.record(principal, {
      action: dryRun ? 'data.import-checked' : 'data.imported',
      targetType: 'data-transfer',
      targetId: job.id,
      details: { name, format, rows, imported, failed, action },
    });
    return { kind: 'import', rows, imported, failed, dryRun, errorsKey };
  }

  /**
   * Streams a file onto the disk while `produce` writes its rows. A failure
   * on either side fails the whole, and the stream is destroyed, so an
   * upload in progress is aborted rather than left open.
   */
  private async writeFile(
    key: string,
    format: TransferFormat,
    columns: readonly TransferColumn[],
    produce: (
      write: (rows: Record<string, unknown>[]) => Promise<void>,
    ) => Promise<void>,
    timeZone?: string,
  ) {
    const writer = createWriter(format, columns, timeZone);
    const stored = this.disk.put(key, writer.output, {
      contentType: CONTENT_TYPES[format],
    });
    try {
      await Promise.all([
        (async () => {
          await produce(writer.write);
          await writer.end();
        })(),
        stored,
      ]);
    } catch (error) {
      writer.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
