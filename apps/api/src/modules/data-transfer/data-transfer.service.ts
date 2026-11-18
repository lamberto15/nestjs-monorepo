import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import { StorageDisk } from '@nestjs/storage';
import type { Job, Queue } from 'bullmq';
import { JobIndex, type JobPage } from '../../core/jobs/job-index.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import type { RecordRegistration } from '../records/records.service.js';
import { tenantFileKey } from '../storage/storage.keys.js';
import { dataTransferConfig } from './data-transfer.config.js';
import {
  TRANSFER_LINK_TTL,
  type TransferStatus,
  type TransfersQuery,
} from './data-transfer.schemas.js';
import {
  type ImportColumn,
  type ImportLimits as Limits,
  TRANSFER_FORMATS,
  type TransferFormat,
  type TransferJob,
  type TransferResult,
} from './data-transfer.types.js';
import {
  CONTENT_TYPES,
  createTemplate,
  type TemplateGuide,
} from './formats.js';
import { type ImportMapping, mappingProblems } from './import-mapping.js';
import { ImportLimits } from './import-limits.js';
import { RecordTransfers } from './record-transfers.js';
import { TENANT_EXPORT } from './tenant-export.js';

/** The queue of exports and imports. */
export const DATA_TRANSFERS = 'data-transfers';

/**
 * How long a finished transfer is kept (BullMQ's `removeOnComplete` and
 * `removeOnFail`): listed, found, its link given.
 */
export const TRANSFER_KEPT_MS = 7 * 24 * 3600 * 1000;

/** The JobIndex list of a principal's transfers, or of one kind of them. */
const transferList = (kind?: TransferJob['kind']) =>
  kind ? `${DATA_TRANSFERS}:${kind}` : DATA_TRANSFERS;

/** Where a tenant's transfer files live on the private disk (`tenants/<id>/transfers/…`). */
export const transferKey = (tenantId: string, name: string) =>
  tenantFileKey(tenantId, `transfers/${name}`);

/** The time zone of a file's dates: the one asked for, else the user's own, else the deployment's. */
export const readerZone = (
  principal: Principal,
  fallback: string,
  asked?: string | null,
) =>
  asked ?? (principal.kind === 'user' ? principal.timezone : null) ?? fallback;

/** A job's work, before the tenant is added (each kind's own fields). */
type TransferWork = TransferJob extends infer J
  ? J extends TransferJob
    ? Omit<J, 'tenantId'>
    : never
  : never;

/** Reasons a person can act on; anything else (a database error) stays in the logs. */
export class TransferRefused extends Error {}

const SHOWN_REASON = /^\[shown\] /;
/** A failure's message as the job keeps it: marked when it is one for people. */
export const shownReason = (message: string) => `[shown] ${message}`;
export const publicReason = (reason: string | undefined) =>
  reason && SHOWN_REASON.test(reason)
    ? reason.replace(SHOWN_REASON, '')
    : 'The transfer failed. Check the file, or ask an administrator (the transfer id is in the logs).';

const notFound = (kind: 'export' | 'import', name: string) =>
  new NotFoundException(`Nothing to ${kind} named "${name}".`);

const invalid = (
  message: string,
  errors: { path: string; message: string }[],
) => new BadRequestException({ code: 'validation_failed', message, errors });

/** Where a refusal of the list query is in the request: the `sort`, else a `filters.<field>`. */
const issuePath = (path: string) =>
  path === 'sort' || path.startsWith('sort.') ? 'sort' : `filters.${path}`;

/**
 * Starts exports and imports as jobs on the `data-transfers` queue (a worker
 * does the work, DataTransferProcessor), and tells them to the principal
 * who started them in this tenant, and to nobody else.
 */
@Injectable()
export class DataTransferService {
  constructor(
    @InjectQueue(DATA_TRANSFERS)
    private readonly queue: Queue<TransferJob, TransferResult>,
    private readonly transfers: RecordTransfers,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly disk: StorageDisk,
    private readonly jobs: JobIndex,
    private readonly limits: ImportLimits,
    private readonly i18n: I18nService,
    @Inject(dataTransferConfig.KEY)
    private readonly config: ConfigType<typeof dataTransferConfig>,
  ) {}

  /** What the caller may export and import, with the import limits that apply to them. */
  async catalog(principal: Principal) {
    const exports = [];
    const imports = [];
    for (const registration of this.transfers.all()) {
      const { path: name, subject } = registration.declaration;
      if (await this.mayExport(principal, registration)) {
        exports.push({
          name,
          subject,
          columns: (await this.transfers.exportColumns(registration)).map(
            (c) => c.header ?? c.key,
          ),
          formats: [...TRANSFER_FORMATS],
        });
      }
      if (await this.transfers.mayImport(principal, registration)) {
        imports.push({
          name,
          formats: [...TRANSFER_FORMATS],
          matchKeys: (await this.access.can(principal, 'update', subject))
            ? this.transfers.matchKeys(registration)
            : [],
          columns: await this.transfers.importColumns(principal, registration),
          template: `/v1/data/imports/${name}/template`,
        });
      }
    }
    return { importLimits: await this.limits.for(principal), exports, imports };
  }

  /** Whether `name` is an export the principal may run. */
  async exportable(principal: Principal, name: string) {
    const registration = this.transfers.find(name);
    return !!registration && (await this.mayExport(principal, registration));
  }

  /** The time zone of a file of the principal's: the one asked for, else theirs, else the deployment's. */
  zone(principal: Principal, asked?: string | null) {
    return readerZone(principal, this.config.timezone, asked);
  }

  /** Whether the principal may export a record: read some of it. */
  mayExport(principal: Principal, registration: RecordRegistration) {
    return this.access.can(principal, 'read', registration.declaration.subject);
  }

  /**
   * Checks an export as `POST /v1/data/exports` does (the record, the
   * permission, its filters and sort: 400s naming them, a 403
   * `field_forbidden`) and answers its record. Scheduled reports check
   * theirs with it.
   */
  async checkExport(
    principal: Principal,
    name: string,
    filters: Record<string, string> = {},
    sort?: string | null,
  ) {
    const registration = this.transfers.find(name);
    if (!registration) throw notFound('export', name);
    if (!(await this.mayExport(principal, registration))) {
      throw new ForbiddenException();
    }
    try {
      await this.transfers.query(principal, registration, filters, sort);
    } catch (error) {
      const body =
        error instanceof BadRequestException
          ? (error.getResponse() as {
              errors?: { path: string; message: string }[];
            })
          : undefined;
      if (!body?.errors) throw error;
      throw invalid(
        'The filters are invalid.',
        body.errors.map((issue) => ({
          path: issuePath(issue.path),
          message: issue.message,
        })),
      );
    }
    return registration;
  }

  async startExport(
    principal: RequestPrincipal,
    input: {
      name: string;
      format: TransferFormat;
      filters?: Record<string, string>;
      sort?: string | null;
      timezone?: string | null;
      /** In the finished event: who asked for it in code (`report:<id>`). */
      tag?: string;
      /** The transfer's id, chosen beforehand (a scheduled report claims its run with it). */
      id?: string;
      /** Added to the `data.export-started` audit entry. */
      details?: Record<string, unknown>;
    },
  ) {
    await this.checkExport(principal, input.name, input.filters, input.sort);
    return this.enqueue(
      principal,
      {
        kind: 'export',
        name: input.name,
        format: input.format,
        filters: input.filters ?? {},
        ...(input.sort && { sort: input.sort }),
        timezone: readerZone(principal, this.config.timezone, input.timezone),
        ...(input.tag && { tag: input.tag }),
        principal,
      },
      { id: input.id, details: input.details },
    );
  }

  /**
   * Queues a tenant's export for an operator, in the operator's tenant (its
   * file and status are theirs): the route has asked for a recent sign-in
   * and the worker checks the operator again. Never reachable through
   * `startExport`, which only knows the records.
   */
  startTenantExport(
    principal: RequestPrincipal,
    tenantId: string,
    format: TransferFormat,
    details: Record<string, unknown>,
  ) {
    return this.enqueue(
      principal,
      {
        kind: 'export',
        name: TENANT_EXPORT,
        format,
        filters: { tenantId },
        timezone: 'UTC',
        principal,
      },
      { details },
    );
  }

  /** Queues an uploaded file's import; the upload goes when the import is refused. */
  async startImport(
    principal: RequestPrincipal,
    input: {
      name: string;
      key: string;
      format: TransferFormat;
      dryRun: boolean;
      matchOn?: string;
      mapping?: ImportMapping;
      limits: Limits;
    },
  ) {
    try {
      const registration = this.transfers.find(input.name);
      if (!registration) throw notFound('import', input.name);
      if (
        !(await this.transfers.mayImport(
          principal,
          registration,
          input.matchOn,
        ))
      ) {
        throw new ForbiddenException();
      }
      if (
        input.matchOn &&
        !this.transfers.matchKeys(registration).includes(input.matchOn)
      ) {
        throw new BadRequestException(`Unknown match key "${input.matchOn}".`);
      }
      if (input.mapping) {
        const problems = mappingProblems(
          input.mapping,
          await this.transfers.importColumns(principal, registration),
        );
        if (problems.length) throw new BadRequestException(problems.join(' '));
      }
    } catch (error) {
      await this.disk.delete(input.key).catch(() => undefined);
      throw error;
    }
    return this.enqueue(principal, { kind: 'import', ...input, principal });
  }

  /**
   * The columns the principal may fill when importing `name` (the
   * template's), or a 404 for someone who may not import it: what a saved
   * mapping is checked against.
   */
  async mappableColumns(principal: Principal, name: string) {
    const registration = this.transfers.find(name);
    if (
      !registration ||
      !(await this.transfers.mayImport(principal, registration))
    ) {
      throw notFound('import', name);
    }
    return this.transfers.importColumns(principal, registration);
  }

  /** A file to fill for an import: its columns and an example row, and (Excel) a guide in the reader's language. */
  async template(
    principal: Principal,
    name: string,
    { format, timezone }: { format: TransferFormat; timezone?: string },
  ) {
    const columns = await this.mappableColumns(principal, name);
    const zone = readerZone(principal, this.config.timezone, timezone);
    return {
      file: await createTemplate(format, columns, zone, this.guide(zone)),
      type: CONTENT_TYPES[format],
      filename: `${name}-template.${format}`,
    };
  }

  /** The guide's texts (`dataTransfer.template.*`), in the request's language. */
  private guide(zone: string): TemplateGuide {
    const t = (key: string, args: Record<string, unknown> = {}) =>
      this.i18n.translate(`dataTransfer.template.${key}`, { args });
    const format = ({ type, min, max, options }: ImportColumn) => {
      const choices = options?.join(', ');
      switch (type) {
        case 'text':
          if (choices) return t('format.options', { options: choices });
          if (min !== undefined && max !== undefined) {
            return t('format.textRange', { min, max });
          }
          if (max !== undefined) return t('format.textMax', { max });
          return min !== undefined ? t('format.textMin', { min }) : '';
        case 'number':
          if (min !== undefined && max !== undefined) {
            return t('format.numberRange', { min, max });
          }
          if (min !== undefined) return t('format.numberMin', { min });
          if (max !== undefined) return t('format.numberMax', { max });
          return t('format.number');
        case 'list':
          return choices
            ? t('format.listOptions', { options: choices })
            : t('format.list');
        case 'datetime':
          return t('format.datetime', { zone });
        default:
          return t(`format.${type}`);
      }
    };
    const shown = (example: unknown) =>
      example === undefined || example === null
        ? ''
        : Array.isArray(example)
          ? example.join(', ')
          : typeof example === 'object'
            ? JSON.stringify(example)
            : String(example as string | number | boolean);
    return {
      sheets: { data: t('sheets.data'), columns: t('sheets.columns') },
      headers: [
        'column',
        'required',
        'type',
        'format',
        'example',
        'description',
      ].map((key) => t(`headers.${key}`)),
      line: (column) => [
        column.type === 'datetime' ? `${column.name} (${zone})` : column.name,
        t(column.required ? 'yes' : 'no'),
        t(`types.${column.type}`),
        format(column),
        shown(column.example),
        column.description ?? '',
      ],
      note: t('note'),
    };
  }

  /**
   * A transfer of this principal in this tenant: its state, progress and
   * result (with links). Another's, or another tenant's (even the same
   * person's), is a 404.
   */
  async status(principal: Principal, id: string) {
    const job = await this.queue.getJob(id);
    if (!job || !this.isOwn(principal, job)) {
      throw new NotFoundException(`Transfer ${id} not found.`);
    }
    return this.view(job);
  }

  /** The transfers this principal started in this tenant, newest first, by cursor. */
  list(
    principal: RequestPrincipal,
    query: TransfersQuery,
  ): Promise<JobPage<TransferStatus>> {
    return this.jobs.page(
      transferList(query.kind),
      requireTenantId('A transfer'),
      principal,
      query,
      async (id) => {
        const job = await this.queue.getJob(id);
        return job && this.isOwn(principal, job) ? this.view(job) : null;
      },
      // Only those in this state: skipped, not forgotten.
      (transfer) =>
        query.status === undefined || transfer.status === query.status,
    );
  }

  private isOwn(principal: Principal, job: Job<TransferJob, TransferResult>) {
    return (
      job.data.tenantId === requireTenantId('A transfer') &&
      principalKey(job.data.principal) === principalKey(principal)
    );
  }

  private async view(
    read: Job<TransferJob, TransferResult>,
  ): Promise<TransferStatus> {
    let job = read;
    const state = await job.getState();
    if (
      (state === 'completed' && job.returnvalue == null) ||
      (state === 'failed' && job.failedReason == null)
    ) {
      // It finished between the two reads: read it again, with its result.
      job = (await this.queue.getJob(read.id!)) ?? job;
    }
    const finishedAt =
      (state === 'completed' || state === 'failed') && job.finishedOn
        ? job.finishedOn
        : null;
    const base = {
      id: job.id!,
      kind: job.data.kind,
      name: job.data.name,
      format: job.data.format,
      createdAt: new Date(job.timestamp).toISOString(),
      finishedAt:
        finishedAt === null ? null : new Date(finishedAt).toISOString(),
      expiresAt:
        finishedAt === null
          ? null
          : new Date(finishedAt + TRANSFER_KEPT_MS).toISOString(),
      status:
        state === 'completed'
          ? ('completed' as const)
          : state === 'failed'
            ? ('failed' as const)
            : state === 'active'
              ? ('running' as const)
              : ('queued' as const),
      progress:
        typeof job.progress === 'object'
          ? (job.progress as Record<string, number>)
          : { processed: 0 },
    };
    if (state === 'failed') {
      return { ...base, error: publicReason(job.failedReason) };
    }
    if (state !== 'completed') return base;
    const result = job.returnvalue;
    const link = (key: string) =>
      this.disk.signedUrl(key, { expiresIn: TRANSFER_LINK_TTL });
    return result.kind === 'export'
      ? { ...base, result: { rows: result.rows, url: await link(result.key) } }
      : {
          ...base,
          result: {
            rows: result.rows,
            imported: result.imported,
            failed: result.failed,
            dryRun: result.dryRun,
            ...(result.errorsKey && {
              errorsUrl: await link(result.errorsKey),
            }),
          },
        };
  }

  private async enqueue(
    principal: RequestPrincipal,
    work: TransferWork,
    { id, details }: { id?: string; details?: Record<string, unknown> } = {},
  ) {
    const job = withTenant(work) as TransferJob;
    if (!job.tenantId || job.principal.tenantId !== job.tenantId) {
      // A bug, never a caller's choice: the job would run in another tenant.
      throw new Error("A transfer is queued in its principal's tenant only.");
    }
    const jobId = id ?? randomUUID();
    // Listed for its principal before it is queued (an entry whose job never came is skipped).
    await this.jobs.add(
      [transferList(), transferList(job.kind)],
      job.tenantId,
      job.principal,
      jobId,
    );
    await this.queue.add(job.kind, job, {
      jobId,
      // Never retried blindly: an import could write a group twice.
      attempts: 1,
      removeOnComplete: { age: TRANSFER_KEPT_MS / 1000 },
      removeOnFail: { age: TRANSFER_KEPT_MS / 1000 },
    });
    await this.audit.record(principal, {
      action: `data.${job.kind}-started`,
      targetType: 'data-transfer',
      targetId: jobId,
      details: {
        name: job.name,
        format: job.format,
        ...(job.kind === 'import' && { dryRun: job.dryRun }),
        ...details,
      },
    });
    return { id: jobId, status: 'queued' as const };
  }
}
