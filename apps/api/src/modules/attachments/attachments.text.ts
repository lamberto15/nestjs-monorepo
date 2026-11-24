import { TransactionHost } from '@nestjs-cls/transactional';
import { Processor } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk, StorageFileNotFoundError } from '@nestjs/storage';
import type { Job } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { Counter } from '@opentelemetry/api';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import {
  isExtractable,
  TextExtractor,
  TextRejectedError,
} from './attachments.extractor.js';
import { ATTACHMENT_TEXT_JOB } from './attachments.permissions.js';
import {
  ATTACHMENT_TEXT,
  type AttachmentJob,
  AttachmentTextQueue,
} from './attachments.queues.js';
import { AttachmentsRepository } from './attachments.repository.js';
import type { Attachment } from './attachments.tables.js';
import type { AttachmentTextStatus } from './attachments.texts.tables.js';

/**
 * How long a clean, extractable file may go without its text before
 * `retryPending()` queues it again; the retry job's period too.
 */
export const TEXT_RETRY_MS = 5 * 60 * 1000;

/** Rows per round. */
const BATCH = 1000;

/** The files `retryPending()` queues: those changed more than `TEXT_RETRY_MS` ago. */
const retriedBefore = (now: Date) => new Date(now.getTime() - TEXT_RETRY_MS);

/**
 * The text of uploaded files, for the search inside files
 * (ATTACHMENT_TEXT_SEARCH). A queue job on a worker reads a clean upload of an
 * extractable type, hands the bytes to the sandboxed TextExtractor and stores
 * the text with the key of the file it came from (`attachment_texts`). A file
 * the extractor refuses is stored `failed`, without text, and not tried
 * again. An issued document (`locked`, `fields` set) is left out: its text is the record's
 * fields, which the record's own search matches under field-level permissions.
 */
@Injectable()
export class AttachmentTextService {
  private readonly logger = new Logger('AttachmentText');

  /** `attachment_texts_extracted{result}`: ready, failed (refused), or error (a disk or database failure; tried again). */
  private readonly extracted: Counter;

  constructor(
    private readonly repository: AttachmentsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly disk: StorageDisk,
    private readonly extractor: TextExtractor,
    private readonly system: SystemContext,
    private readonly queue: AttachmentTextQueue,
    metrics: MetricsService,
  ) {
    this.extracted = metrics.counter('attachment_texts_extracted', {
      description:
        'Attachment texts extracted for search, by result (ready, failed, error).',
    });
  }

  /**
   * Extracts one attachment's text (the worker, in the job's tenant). Nothing
   * to do for one that is gone, not clean yet, issued, of another type, or
   * whose current file already has its text. Throws when the disk or the
   * database fails, so the queue tries again.
   */
  async process(job: AttachmentJob): Promise<AttachmentTextStatus | 'skipped'> {
    if (!this.queue.enabled) return 'skipped';
    return this.system.run(
      ATTACHMENT_TEXT_JOB,
      async () => {
        const row = await this.repository.find(job.attachmentId);
        if (
          !row ||
          row.scanStatus !== 'clean' ||
          row.locked ||
          row.fields !== null
        ) {
          return 'skipped';
        }
        if (
          (await this.repository.hasText(row.id, row.key)) ||
          !isExtractable(row.contentType)
        ) {
          // Nothing to extract for this file: the retry stops looking at it.
          await this.settled(row);
          return 'skipped';
        }

        let status: AttachmentTextStatus = 'ready';
        let text = '';
        try {
          if (row.size > this.extractor.maxBytes) {
            throw new TextRejectedError(
              'size',
              `The file is ${row.size} bytes; at most ${this.extractor.maxBytes} are read.`,
            );
          }
          text = await this.extractor.extract(
            await this.disk.getBuffer(row.key),
            row.contentType,
          );
        } catch (error) {
          if (
            !(error instanceof TextRejectedError) &&
            !(error instanceof StorageFileNotFoundError)
          ) {
            this.extracted.add(1, { result: 'error' });
            throw error;
          }
          status = 'failed';
          this.logger.warn('A file is not searchable: its text was refused', {
            attachment: row.id,
            reason:
              error instanceof TextRejectedError ? error.reason : 'missing',
            error: error.message,
          });
        }
        if (!(await this.store(row, status, text))) return 'skipped';
        this.extracted.add(1, { result: status });
        return status;
      },
      { transaction: false, tenantId: job.tenantId },
    );
  }

  /**
   * What the best-effort enqueue and the queue's retries don't cover, for the
   * current tenant: the clean, extractable files changed more than
   * `TEXT_RETRY_MS` ago that have no text for their current file (a lost job,
   * a replaced file, the files stored before ATTACHMENT_TEXT_SEARCH was
   * switched on; `BATCH` a round). Returns how many it queued.
   */
  async retryPending(now = new Date()): Promise<number> {
    if (!this.queue.enabled) return 0;
    return this.system.run(
      ATTACHMENT_TEXT_JOB,
      async () => {
        const stale = await this.repository.pendingTexts(
          retriedBefore(now),
          BATCH,
        );
        const period = String(Math.floor(now.getTime() / TEXT_RETRY_MS));
        for (const { id } of stale) await this.queue.enqueue(id, period);
        return stale.length;
      },
      { transaction: false },
    );
  }

  /** The tenants `retryPending()` has work in, read across every tenant (the retry job, in `acrossTenants()`). */
  async pendingTenants(now: Date) {
    if (!this.queue.enabled) return [];
    return this.repository.pendingTextTenants(retriedBefore(now));
  }

  /**
   * Stores the text of the file at `row.key`, replacing what an earlier file
   * of the attachment had. Only while the attachment still has that file
   * (locked against its removal until the commit); else nothing (false).
   */
  private store(row: Attachment, status: AttachmentTextStatus, text: string) {
    return this.txHost.withTransaction(async () => {
      if (!(await this.repository.shareLockFile(row.id, row.key))) return false;
      await this.repository.saveText(row.id, row.key, status, text);
      await this.settled(row);
      return true;
    });
  }

  /** The file at `row.key` needs no more extraction (if it is still the attachment's). */
  private async settled(row: Attachment) {
    await this.repository.settleText(row.id, row.key);
  }
}

/**
 * Extracts the text of the files queued for it, on the workers, in the
 * upload's tenant. One file at a time: each extraction is a thread with its
 * own heap limit. A file the extractor refuses ends `failed` without a retry;
 * a disk or database error is tried again with backoff, and past the last
 * attempt the retry job queues it again.
 */
@Processor(ATTACHMENT_TEXT, { concurrency: 1 })
export class AttachmentTextProcessor extends TenantWorkerHost<AttachmentJob> {
  private readonly logger = new Logger('AttachmentText');

  constructor(private readonly texts: AttachmentTextService) {
    super();
  }

  async handle(job: Job<AttachmentJob>) {
    const outcome = await this.texts.process(job.data);
    this.logger.log('Attachment text extracted', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }
}

/**
 * Queues the text extraction of the clean, extractable files that have no
 * text for their current file, every five minutes on one instance, in the
 * tenants that have one (found across every tenant). `run(now)` lets a test choose the moment; it returns how many it
 * queued.
 */
@Injectable()
export class AttachmentTextRetryJob {
  constructor(
    private readonly texts: AttachmentTextService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', { name: 'attachment-text-retry', timeZone: 'UTC' })
  @OnOneInstance({ key: 'attachments:text-retry' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    // Only the tenants with a file waiting: one indexed read across them, not a visit to each.
    const pending = await this.tenancy.acrossTenants(
      'attachment-text-retry',
      () => this.texts.pendingTenants(now),
    );
    const handled = await this.tenancy.forEachTenant(
      'attachment-text-retry',
      () => this.texts.retryPending(now),
      { tenantIds: pending },
    );
    return [...handled.values()].reduce((sum, count) => sum + count, 0);
  }
}
