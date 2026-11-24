import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { Counter } from '@opentelemetry/api';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { SystemPrincipal } from '../../iam/auth/principal.js';
import { renditionKeys } from './attachments.renditions.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ATTACHMENT_SCAN_JOB } from './attachments.permissions.js';
import {
  type AttachmentJob,
  AttachmentImagesQueue,
  AttachmentScanQueue,
} from './attachments.queues.js';
import { MalwareScanner } from './attachments.scanner.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentVersionsService } from './attachments.versions.js';
import { AttachmentsRepository } from './attachments.repository.js';
import type { Attachment } from './attachments.tables.js';

/** How a scan ended, as `attachments_scanned{result}` counts it. */
export type ScanOutcome = 'clean' | 'infected' | 'error';

/**
 * How long an upload may stay pending before `retryPending()` queues its
 * scan again, and the retry job's period. The queue's own retries end about
 * 75 s after the upload with the defaults (MALWARE_SCAN_ATTEMPTS 5, backoff
 * from 5 s).
 */
export const RETRY_MS = 5 * 60 * 1000;

/** Rows per round. */
const BATCH = 1000;

/**
 * The malware scan of uploads (MALWARE_SCANNER). An upload is `pending` until
 * a queue job (on a worker) streams its file to the scanner: clean, it
 * becomes `clean`; infected, the attachment is deleted (row and file),
 * audited `attachment.rejected` by `system:attachment-scan`, and the uploader
 * is notified. A scanner that fails leaves it pending and the job is tried
 * again; a file is never clean without a scan, unless scanning is switched
 * off (MALWARE_SCANNER=off), which releases what is pending.
 */
@Injectable()
export class AttachmentScanService {
  private readonly logger = new Logger('AttachmentScan');

  /** `attachments_scanned{result}`: clean, infected, or error (the scan failed; it is tried again). */
  private readonly scanned: Counter;

  constructor(
    private readonly repository: AttachmentsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly scanner: MalwareScanner,
    private readonly disk: StorageDisk,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly attachments: AttachmentsService,
    private readonly queue: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    private readonly versions: AttachmentVersionsService,
    metrics: MetricsService,
  ) {
    this.scanned = metrics.counter('attachments_scanned', {
      description:
        'Uploads scanned for malware, by result (clean, infected, error).',
    });
  }

  /**
   * Scans one attachment (the worker, in the job's tenant). Nothing to do
   * for one that is gone or already clean. Throws when the scanner fails,
   * so the queue tries again.
   */
  async scan(job: AttachmentJob): Promise<ScanOutcome | 'skipped'> {
    // Switched off after the upload: retryPending() releases what is pending.
    if (!this.scanner.enabled) return 'skipped';
    return this.system.run(
      ATTACHMENT_SCAN_JOB,
      async (system) => {
        const row = await this.repository.find(job.attachmentId);
        if (!row || row.scanStatus !== 'pending') return 'skipped';
        let verdict;
        try {
          const file = await this.disk.get(row.key);
          verdict = await this.scanner.scan(file.body);
        } catch (error) {
          this.scanned.add(1, { result: 'error' });
          throw error;
        }
        if (!verdict.infected) {
          if (await this.repository.markClean(row.id)) {
            this.scanned.add(1, { result: 'clean' });
            this.attachments.changed(system, row, row.id, 'scanned');
            // An image is processed only once it may be served.
            if (row.renditionStatus === 'pending') {
              await this.images.enqueue(row.id, `v${row.version}`);
            }
          }
          return 'clean';
        }
        await this.reject(row, verdict.signature, system);
        this.scanned.add(1, { result: 'infected' });
        return 'infected';
      },
      { transaction: false, tenantId: job.tenantId },
    );
  }

  /**
   * What the queue's own retries and the best-effort enqueue after an upload
   * don't cover, for the current tenant (the retry job runs it in each
   * tenant's scope). Returns how many files it handled.
   * - Scanning on: queues again the scans of uploads still pending after
   *   `RETRY_MS` (clamd restarting, a lost or exhausted job).
   * - Scanning off (MALWARE_SCANNER switched back to `off` while uploads
   *   were pending): they are released as `clean` and audited.
   */
  async retryPending(now = new Date()): Promise<number> {
    return this.system.run(
      ATTACHMENT_SCAN_JOB,
      async (system) => {
        if (!this.scanner.enabled) return this.release(system);
        const stale = await this.repository.pendingScans(
          this.retriedBefore(now),
          BATCH,
        );
        const period = String(Math.floor(now.getTime() / RETRY_MS));
        for (const { id } of stale) await this.queue.enqueue(id, period);
        return stale.length;
      },
      { transaction: false },
    );
  }

  /** The tenants `retryPending()` has work in, read across every tenant (the retry job, in `acrossTenants()`). */
  async pendingTenants(now: Date) {
    return this.repository.pendingScanTenants(this.retriedBefore(now));
  }

  /** What `retryPending()` handles: with scanning on the uploads pending past `RETRY_MS`, off every pending one (released). */
  private retriedBefore(now: Date) {
    return this.scanner.enabled
      ? new Date(now.getTime() - RETRY_MS)
      : undefined;
  }

  /** Scanning is off: the pending files become `clean` (a round of `BATCH` at a time), audited. */
  private async release(system: SystemPrincipal) {
    let released = 0;
    for (;;) {
      const rows = await this.txHost.withTransaction(async () => {
        const done = await this.repository.releasePendingScans(BATCH);
        if (done.length > 0) {
          await this.audit.record(system, {
            action: 'attachments.released',
            targetType: 'attachment',
            details: {
              reason: 'scanner_off',
              attachments: done.map((row) => row.id),
            },
          });
        }
        return done;
      });
      for (const row of rows) {
        this.attachments.changed(system, row, row.id, 'scanned');
        if (row.renditionStatus === 'pending')
          await this.images.enqueue(row.id, `v${row.version}`);
      }
      released += rows.length;
      if (rows.length < BATCH) return released;
    }
  }

  private async reject(
    row: Attachment,
    signature: string,
    system: SystemPrincipal,
  ) {
    let reverted: Attachment | null = null;
    const removed = await this.txHost.withTransaction(async () => {
      // A replacement that is infected is dropped and the file before it is
      // current again, rather than the history going; only a first file is deleted.
      reverted =
        row.version > 1 ? await this.versions.revertRejected(row) : null;
      const gone = reverted
        ? true
        : await this.repository.deletePending(row.id);
      if (!gone) return false; // removed by its uploader meanwhile: nothing to audit
      await this.audit.record(system, {
        action: 'attachment.rejected',
        targetType: 'attachment',
        targetId: row.id,
        details: {
          subject: row.subject,
          recordId: row.recordId,
          name: row.name,
          size: row.size,
          contentType: row.contentType,
          uploadedBy: row.uploadedBy,
          signature,
        },
      });
      if (/^(user|client):/.test(row.uploadedBy)) {
        await this.notifications.notify({
          type: 'attachment.rejected',
          to: row.uploadedBy,
          data: { name: row.name, subject: row.subject, signature },
        });
      }
      return true;
    });
    // After the commit, as remove() does: a failed delete leaves a file nothing points at.
    await this.attachments.deleteFiles([
      row.key,
      ...renditionKeys(row.renditions),
    ]);
    if (removed) {
      this.logger.warn('An upload was rejected as malware', {
        attachment: row.id,
        signature,
      });
      const back = reverted as Attachment | null;
      this.attachments.changed(
        system,
        row,
        row.id,
        back ? 'processed' : 'removed',
      );
      if (back?.renditionStatus === 'pending') {
        await this.images.enqueue(back.id, `v${back.version}-back`);
      }
    }
  }
}
