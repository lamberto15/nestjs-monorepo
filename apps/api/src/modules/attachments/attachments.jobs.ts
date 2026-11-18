import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import type { Job } from 'bullmq';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { AttachmentImagesService } from './attachments.images.js';
import {
  ATTACHMENT_IMAGES,
  ATTACHMENT_SCAN,
  type AttachmentJob,
} from './attachments.queues.js';
import { AttachmentScanService } from './attachments.scan.js';

/** What BullMQ fails a job with when its worker died on it more than `maxStalledCount` times. */
const STALLED_REASON = 'job stalled more than allowable limit';

/**
 * Scans the uploads queued for it, on the workers, in the upload's tenant. A
 * failed scan (clamd away) is tried again with backoff; after the last
 * attempt the attachment stays `pending` and the retry job queues it again
 * within minutes.
 */
@Processor(ATTACHMENT_SCAN, { concurrency: 4 })
export class AttachmentScanProcessor extends TenantWorkerHost<AttachmentJob> {
  private readonly logger = new Logger('AttachmentScan');

  constructor(private readonly scans: AttachmentScanService) {
    super();
  }

  async handle(job: Job<AttachmentJob>) {
    const outcome = await this.scans.scan(job.data);
    this.logger.log('Upload scanned', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }
}

/**
 * Processes the uploaded images queued for it, on the workers, in the
 * upload's tenant. One image at a time: libvips works outside the V8 heap
 * (about 4 bytes per pixel at its peak); more throughput is more worker
 * replicas. A file that cannot be processed ends the job as `failed` without
 * a retry (the same bytes fail again); a disk or database error is tried
 * again with backoff, and past the last attempt the image stays `pending` for
 * the retry job. An image the worker dies on (twice) ends `failed`.
 */
@Processor(ATTACHMENT_IMAGES, { concurrency: 1 })
export class AttachmentImagesProcessor extends TenantWorkerHost<AttachmentJob> {
  private readonly logger = new Logger('AttachmentImages');

  constructor(private readonly images: AttachmentImagesService) {
    super();
  }

  async handle(job: Job<AttachmentJob>) {
    const outcome = await this.images.process(job.data);
    this.logger.log('Image processed', {
      attachment: job.data.attachmentId,
      outcome,
    });
    return outcome;
  }

  /**
   * A worker that dies while converting leaves its job stalled: BullMQ runs it
   * once more, and when that run dies too the next worker fails the job
   * without calling `process()`. Then the image is `failed`, as uploaded.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AttachmentJob> | undefined, error: Error) {
    if (!job || error.message !== STALLED_REASON) return;
    this.logger.warn('An image stalled its worker twice and was failed', {
      attachment: job.data.attachmentId,
    });
    await this.images.stalled(job.data).catch((failure: unknown) =>
      this.logger.error('A stalled image could not be marked failed', {
        attachment: job.data.attachmentId,
        error: String(failure),
      }),
    );
  }
}

/**
 * Gets the uploads stuck `pending` scanned (or released) again, and the
 * images stuck `pending` processed again, every five minutes on one
 * instance, one tenant at a time (deactivated ones too, so nothing stays
 * pending for good). `run(now)` lets a test choose the moment; it returns how
 * many files and images it handled.
 */
@Injectable()
export class AttachmentRetryJob {
  constructor(
    private readonly scans: AttachmentScanService,
    private readonly images: AttachmentImagesService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', { name: 'attachment-retry', timeZone: 'UTC' })
  @OnOneInstance({ key: 'attachments:retry' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const handled = await this.tenancy.forEachTenant(
      'attachment-retry',
      async () => ({
        scans: await this.scans.retryPending(now),
        images: await this.images.retryPending(now),
      }),
      { includeInactive: true },
    );
    return [...handled.values()].reduce(
      (total, { scans, images }) => ({
        scans: total.scans + scans,
        images: total.images + images,
      }),
      { scans: 0, images: 0 },
    );
  }
}
