import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { StorageDisk } from '@nestjs/storage';
import { asc, inArray, lt } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { ATTACHMENT_SWEEP_JOB } from './attachments.permissions.js';
import { attachments, attachmentUploads } from './attachments.tables.js';
import { UPLOAD_GRACE_MS, uploadObjects } from './attachments.uploads.js';

/** Uploads looked at per round. */
const BATCH = 1000;

/**
 * Deletes the objects of uploads that were announced and never completed
 * (`attachment_uploads`: signed URLs and resumable sessions, with their
 * parts): an hour after their URL or session expired, with their rows and an
 * `attachments.uploads-swept` audit entry. The rows of completed uploads go
 * the same way, without an entry, with whatever was PUT to their URL after the
 * completion (the attachment is a copy on another key). An object an
 * attachment has as its file is never deleted here. Every night at 04:05 UTC
 * on one instance, one tenant at a time, as `system:attachment-sweep`. (The
 * files of records deleted for good go with them: `AttachmentsService.forget()`.)
 */
@Injectable()
export class AttachmentSweepJob {
  private readonly logger = new Logger('AttachmentSweep');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly disk: StorageDisk,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('5 4 * * *', { name: 'attachment-sweep', timeZone: 'UTC' })
  @OnOneInstance({ key: 'attachments:sweep' })
  @WithoutOverlapping()
  async run() {
    // Deactivated tenants too: their abandoned objects still go.
    const swept = await this.tenancy.forEachTenant(
      'attachment-sweep',
      (tenant) => this.sweep(tenant.id),
      { includeInactive: true },
    );
    return [...swept.values()].reduce((sum, deleted) => sum + deleted, 0);
  }

  /** One tenant's expired uploads (run in its scope): how many nobody completed. */
  private sweep(tenantId: string) {
    return this.system.run(
      ATTACHMENT_SWEEP_JOB,
      async (system) => {
        let deleted = 0;
        for (;;) {
          const expired = await this.db
            .select({
              id: attachmentUploads.id,
              key: attachmentUploads.key,
              resumable: attachmentUploads.resumable,
              completedAt: attachmentUploads.completedAt,
            })
            .from(attachmentUploads)
            .where(
              lt(
                attachmentUploads.expiresAt,
                new Date(Date.now() - UPLOAD_GRACE_MS),
              ),
            )
            .orderBy(asc(attachmentUploads.id))
            .limit(BATCH);
          if (expired.length === 0) break;
          // A key that became an attachment's file is not an orphan: keep its object.
          const used = new Set(
            (
              await this.db
                .select({ key: attachments.key })
                .from(attachments)
                .where(
                  inArray(
                    attachments.key,
                    expired.map((row) => row.key),
                  ),
                )
            ).map((row) => row.key),
          );
          const abandoned = expired.filter((row) => !row.completedAt);
          // The objects first: a failure leaves the rows, and the next night tries again.
          await this.disk.delete(
            (
              await Promise.all(
                expired.map((row) => uploadObjects(this.disk, row)),
              )
            )
              .flat()
              .filter((key) => !used.has(key)),
          );
          await this.txHost.withTransaction(async () => {
            await this.db.delete(attachmentUploads).where(
              inArray(
                attachmentUploads.id,
                expired.map((row) => row.id),
              ),
            );
            if (abandoned.length > 0) {
              await this.audit.record(system, {
                action: 'attachments.uploads-swept',
                targetType: 'attachment',
                details: { uploads: abandoned.map((row) => row.id) },
              });
            }
          });
          deleted += abandoned.length;
        }
        if (deleted > 0) {
          this.logger.log('Uploads never completed removed', {
            tenant: tenantId,
            deleted,
          });
        }
        return deleted;
      },
      { transaction: false },
    );
  }
}
