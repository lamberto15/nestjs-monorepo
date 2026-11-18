import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { isProcessable } from '../images/renditions.js';
import { attachmentsConfig } from './attachments.config.js';
import { MalwareScanner } from './attachments.scanner.js';

/** The queue of uploads to scan. */
export const ATTACHMENT_SCAN = 'attachment-scan';
/** The queue of uploaded images to process (thumbnails, previews, metadata stripping). */
export const ATTACHMENT_IMAGES = 'attachment-images';
/** The queue of files whose text to extract (the search inside files). */
export const ATTACHMENT_TEXT = 'attachment-text';

/** What a queued job carries: the attachment, and its tenant (`withTenant`). */
export interface AttachmentJob extends TenantEnvelope {
  attachmentId: string;
}

async function enqueue(
  queue: Queue<AttachmentJob>,
  logger: Logger,
  name: string,
  attachmentId: string,
  again: string | undefined,
  options: { attempts?: number } = {},
) {
  try {
    await queue.add(name, withTenant({ attachmentId }), {
      // `again`: a name for the job when a retry job queues one that never
      // finished (a job id is queued once, and a finished job is kept for a while).
      jobId: again ? `${attachmentId}-${again}` : attachmentId,
      ...options,
      backoff: { type: 'exponential', delay: 5000 },
      // The retry job queues a stuck file again every few minutes: keep the failures bounded.
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
  } catch (error) {
    // The file stays pending and the retry job queues it again within minutes.
    logger.error(
      `A ${name} job could not be queued; the retry job will queue it`,
      {
        attachmentId,
        error: String(error),
      },
    );
  }
}

/**
 * Queues the malware scans of uploads (MALWARE_SCANNER). Apart from the scan
 * service, which reads the attachments, so that the attachments service can
 * queue a scan without depending on it.
 */
@Injectable()
export class AttachmentScanQueue {
  private readonly logger = new Logger('AttachmentScan');

  constructor(
    @InjectQueue(ATTACHMENT_SCAN) private readonly queue: Queue<AttachmentJob>,
    private readonly scanner: MalwareScanner,
    @Inject(attachmentsConfig.KEY)
    private readonly config: ConfigType<typeof attachmentsConfig>,
  ) {}

  /** Whether uploads are scanned: MALWARE_SCANNER is not `off`. */
  get enabled() {
    return this.scanner.enabled;
  }

  /** Queues the scan of an attachment (in the current tenant's scope), after the transaction that stored it committed. */
  enqueue(attachmentId: string, again?: string) {
    return enqueue(this.queue, this.logger, 'scan', attachmentId, again, {
      attempts: this.config.scanAttempts,
    });
  }
}

/**
 * Queues the processing of uploaded images (IMAGE_PROCESSING). A job is
 * queued once the file may be served (`scanStatus` `clean`): when the upload
 * is stored with the scanner off, or when the scan finds it clean.
 */
@Injectable()
export class AttachmentImagesQueue {
  private readonly logger = new Logger('AttachmentImages');

  constructor(
    @InjectQueue(ATTACHMENT_IMAGES)
    private readonly queue: Queue<AttachmentJob>,
    @Inject(attachmentsConfig.KEY)
    private readonly config: ConfigType<typeof attachmentsConfig>,
  ) {}

  /** Whether uploaded images are processed: IMAGE_PROCESSING is not `off`. */
  get enabled() {
    return this.config.imageProcessing;
  }

  /** Whether an upload of this (detected) content type gets processed. */
  wants(contentType: string) {
    return this.enabled && isProcessable(contentType);
  }

  enqueue(attachmentId: string, again?: string) {
    return enqueue(this.queue, this.logger, 'process', attachmentId, again);
  }
}

/**
 * Queues text extractions (ATTACHMENT_TEXT_SEARCH). Apart from the text
 * service so that the attachments service can queue one without depending on
 * it: after a file is stored and after its scan finds it clean; the job
 * itself decides whether there is anything to extract.
 */
@Injectable()
export class AttachmentTextQueue {
  private readonly logger = new Logger('AttachmentText');

  constructor(
    @InjectQueue(ATTACHMENT_TEXT) private readonly queue: Queue<AttachmentJob>,
    @Inject(attachmentsConfig.KEY)
    private readonly config: ConfigType<typeof attachmentsConfig>,
  ) {}

  /** Whether files are searched by their text: ATTACHMENT_TEXT_SEARCH is `on`. */
  get enabled() {
    return this.config.textSearch;
  }

  /**
   * Queues the extraction of an attachment's text (in the current tenant's
   * scope). `name` makes the job id unique (a job id is queued once, and a
   * finished job is kept for a while). A failure is logged, not thrown: the
   * retry job queues what has no text within minutes.
   */
  async enqueue(attachmentId: string, name: string) {
    if (!this.enabled) return;
    try {
      await this.queue.add('extract', withTenant({ attachmentId }), {
        jobId: `${attachmentId}-${name}`,
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (error) {
      this.logger.error(
        'A text extraction could not be queued; the retry job will queue it',
        { attachmentId, error: String(error) },
      );
    }
  }
}
