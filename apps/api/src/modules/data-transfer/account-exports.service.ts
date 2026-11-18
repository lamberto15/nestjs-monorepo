import { randomUUID } from 'node:crypto';
import { InjectQueue, OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import type { Job, Queue } from 'bullmq';
import { JobIndex } from '../../core/jobs/job-index.js';
import {
  type TenantEnvelope,
  TenantWorkerHost,
} from '../../core/tenancy/tenant-job.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { PersonalDataService } from '../../iam/personal-data/personal-data.service.js';
import { accountFileKey } from '../storage/storage.keys.js';
import { TRANSFER_LINK_TTL } from './data-transfer.schemas.js';
import { TRANSFER_KEPT_MS } from './data-transfer.service.js';
import type { TransferFormat } from './data-transfer.types.js';
import { CONTENT_TYPES, createWriter } from './formats.js';

/** The queue of the people's own data exports. */
export const ACCOUNT_EXPORTS = 'account-exports';

type ExportJob = TenantEnvelope & { userId: string; format: TransferFormat };
interface ExportResult {
  key: string;
  rows: number;
}

/** One row of the file: the section it comes from, the tenant (empty: the account's own), and the record as JSON. */
const COLUMNS = [
  { key: 'kind' },
  { key: 'tenantId' },
  { key: 'id' },
  { key: 'data' },
];

/**
 * A copy of everything held about a person (`POST /v1/account/export`), as a
 * file: a background job in no tenant that walks every module's
 * `@PersonalData()` section (PersonalDataService) and writes one row per
 * record. Listed and read by its person alone.
 */
@Injectable()
export class AccountExports {
  constructor(
    @InjectQueue(ACCOUNT_EXPORTS)
    private readonly queue: Queue<ExportJob, ExportResult>,
    private readonly jobs: JobIndex,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  async start(user: UserPrincipal, format: TransferFormat) {
    const id = randomUUID();
    // Listed before it is queued: an entry whose job never came is skipped.
    await this.jobs.add([ACCOUNT_EXPORTS], null, user, id);
    await this.queue.add(
      'export',
      { tenantId: null, userId: user.id, format },
      {
        jobId: id,
        attempts: 1,
        removeOnComplete: { age: TRANSFER_KEPT_MS / 1000 },
        removeOnFail: { age: TRANSFER_KEPT_MS / 1000 },
      },
    );
    // The person's own entry: in no tenant's log, as the old export wrote it.
    await this.tenancy.run(null, () =>
      this.audit.record(user, {
        action: 'data.export-started',
        targetType: 'data-transfer',
        targetId: id,
        details: { name: 'account', format },
      }),
    );
    return { id, status: 'queued' as const };
  }

  async list(user: UserPrincipal, query: { limit: number; cursor?: string }) {
    return this.jobs.page(ACCOUNT_EXPORTS, null, user, query, async (id) => {
      const job = await this.queue.getJob(id);
      return job && job.data.userId === user.id ? this.view(job) : null;
    });
  }

  async status(user: UserPrincipal, id: string) {
    const job = await this.queue.getJob(id);
    if (!job || job.data.userId !== user.id) {
      throw new NotFoundException(`Export ${id} not found.`);
    }
    return this.view(job);
  }

  private async view(read: Job<ExportJob, ExportResult>) {
    let job = read;
    const state = await job.getState();
    if (
      (state === 'completed' && job.returnvalue == null) ||
      (state === 'failed' && job.failedReason == null)
    ) {
      job = (await this.queue.getJob(read.id!)) ?? job;
    }
    const finishedAt =
      (state === 'completed' || state === 'failed') && job.finishedOn
        ? job.finishedOn
        : null;
    return {
      id: job.id!,
      format: job.data.format,
      status:
        state === 'completed'
          ? ('completed' as const)
          : state === 'failed'
            ? ('failed' as const)
            : state === 'active'
              ? ('running' as const)
              : ('queued' as const),
      createdAt: new Date(job.timestamp).toISOString(),
      finishedAt: finishedAt && new Date(finishedAt).toISOString(),
      expiresAt:
        finishedAt && new Date(finishedAt + TRANSFER_KEPT_MS).toISOString(),
      ...(state === 'failed' && { error: 'The export failed: ask again.' }),
      ...(state === 'completed' && {
        result: {
          rows: job.returnvalue.rows,
          url: await this.disk.signedUrl(job.returnvalue.key, {
            expiresIn: TRANSFER_LINK_TTL,
          }),
        },
      }),
    };
  }
}

/** Writes the file on a worker, for a person who is still active. */
@Processor(ACCOUNT_EXPORTS)
export class AccountExportProcessor extends TenantWorkerHost<
  ExportJob,
  ExportResult
> {
  private readonly logger = new Logger('AccountExport');

  constructor(
    private readonly personalData: PersonalDataService,
    private readonly users: UsersRepository,
    private readonly disk: StorageDisk,
  ) {
    super();
  }

  async handle(job: Job<ExportJob>): Promise<ExportResult> {
    const { userId, format } = job.data;
    if (!(await this.users.findActive(userId))) {
      throw new Error('The account is no longer active.');
    }
    const key = accountFileKey(userId, `exports/${job.id}.${format}`);
    const writer = createWriter(format, COLUMNS);
    const stored = this.disk.put(key, writer.output, {
      contentType: CONTENT_TYPES[format],
    });
    let rows = 0;
    try {
      await Promise.all([
        (async () => {
          await this.personalData.export(userId, async (batch) => {
            await writer.write(
              batch.rows.map((row) => ({
                kind: batch.section,
                tenantId: batch.tenantId,
                id: typeof row.id === 'string' ? row.id : null,
                data: row,
              })),
            );
            rows += batch.rows.length;
            await job.updateProgress({ processed: rows });
          });
          await writer.end();
        })(),
        stored,
      ]);
    } catch (error) {
      writer.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return { key, rows };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ExportJob> | undefined, error: Error) {
    this.logger.warn('An account export failed', {
      id: job?.id,
      error: error.message,
    });
  }
}
