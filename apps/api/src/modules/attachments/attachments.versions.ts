import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { assertUnchanged } from '../../core/http/etag.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { QuotasService } from '../quotas/quotas.service.js';
import { renditionKeys } from './attachments.renditions.js';
import { STORAGE_BYTES } from './attachments.quota.js';
import {
  AttachmentImagesQueue,
  AttachmentScanQueue,
} from './attachments.queues.js';
import type {
  AttachmentVersionView,
  AttachmentView,
} from './attachments.schemas.js';
import {
  assertOwnFile,
  attachmentKey,
  AttachmentsService,
  details,
  DOWNLOAD_LINK_TTL,
  fileName,
  type RecordRef,
  view,
} from './attachments.service.js';
import {
  type Attachment,
  attachments,
  attachmentVersions,
} from './attachments.tables.js';
import { isExtractable } from './attachments.extractor.js';

/** The most versions one attachment keeps, the current one included: the bytes of all of them count in the tenant's storage. */
export const MAX_ATTACHMENT_VERSIONS = 100;

/** The file that becomes an attachment's current version. */
interface NextVersion {
  key: string;
  name: string;
  size: number;
  contentType: string;
  note: string | null;
}

/**
 * An attachment's history. The attachment row is its current file; replacing
 * it, or restoring an earlier one, moves the file it held to
 * `attachment_versions` and puts the new one in its place under the next
 * version number, in one transaction with the audit entry. Nothing is
 * overwritten: the earlier bytes stay until the attachment itself goes. The
 * new current file goes through everything an upload does (type from its
 * bytes, size limit, quota, malware scan, image renditions); a restored
 * version is copied to a file of its own and scanned again. Not the record's
 * field revisions: these are the bytes of one file.
 */
@Injectable()
export class AttachmentVersionsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly scans: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    private readonly quotas: QuotasService,
  ) {}

  /** The attachment's versions, the current one (`current: true`) first, then newest first. Whoever may read its record. */
  async list(
    principal: Principal,
    id: string,
  ): Promise<{ items: AttachmentVersionView[] }> {
    const current = await this.attachments.findReadable(principal, id);
    const earlier = await this.db
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, id))
      .orderBy(desc(attachmentVersions.version));
    return {
      items: [
        {
          version: current.version,
          current: true,
          name: current.name,
          size: current.size,
          contentType: current.contentType,
          uploadedBy: current.uploadedBy,
          note: current.revisionNote,
          uploadedAt: current.versionedAt.toISOString(),
        },
        ...earlier.map((row) => ({
          version: row.version,
          current: false,
          name: row.name,
          size: row.size,
          contentType: row.contentType,
          uploadedBy: row.uploadedBy,
          note: row.note,
          uploadedAt: row.uploadedAt.toISOString(),
        })),
      ],
    };
  }

  /** A signed link to the file of one version, always as a download: whoever may read its record. */
  async download(principal: Principal, id: string, version: number) {
    const current = await this.attachments.findReadable(principal, id);
    if (version === current.version) {
      return this.attachments.download(principal, id);
    }
    const row = await this.earlier(id, version);
    // Clean when it was archived (a file is replaced only once scanned).
    const url = await this.disk.signedUrl(row.key, {
      expiresIn: DOWNLOAD_LINK_TTL,
      filename: row.name,
      disposition: 'attachment',
    });
    return { url };
  }

  /**
   * Replaces the attachment's file by `file` (already on the disk, checked by
   * the upload interceptor like any upload), keeping the old one as the
   * previous version. Who may change the record. `ifMatch` is the
   * attachment's ETag as read: 412 when it changed since, which also settles
   * two replacements racing. 409 `attachment_busy` while the current file is
   * being scanned or made into renditions, `attachment_locked` for an issued
   * document, `attachment_versions_limit` past MAX_ATTACHMENT_VERSIONS; 422
   * `quota_exceeded` when the tenant has no room for both files.
   */
  async replace(
    principal: Principal,
    record: RecordRef,
    id: string,
    file: Pick<StoredUpload, 'key' | 'originalname' | 'size' | 'contentType'>,
    options: { ifMatch?: string; note?: string; ip?: string },
  ): Promise<AttachmentView> {
    try {
      assertOwnFile(file.key);
      await this.attachments.assertCanUpload(principal, record);
      const current = await this.own(principal, record, id, options.ifMatch);
      return await this.swap(
        principal,
        current,
        {
          key: file.key,
          name: fileName(file.originalname),
          size: file.size,
          contentType: file.contentType,
          note: options.note?.trim() || null,
        },
        'attachment.replaced',
        {},
        options.ip,
      );
    } catch (error) {
      await this.disk.delete(file.key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Makes an earlier version the current file again, as a new version (the
   * history only grows): its bytes are copied to a file of their own and
   * scanned again. Who may change the record. 404 for a version that does not
   * exist, 400 for the current one; the other errors are `replace()`'s.
   */
  async restore(
    principal: Principal,
    id: string,
    version: number,
    options: { ifMatch?: string; note?: string; ip?: string },
  ): Promise<AttachmentView> {
    const found = await this.attachments.findReadable(principal, id);
    await this.attachments.assertCanUpload(principal, found);
    const current = await this.own(principal, found, id, options.ifMatch);
    if (version === current.version) {
      throw new BadRequestException({
        code: 'attachment_version_current',
        message: 'This is the current version: nothing to restore.',
      });
    }
    const earlier = await this.earlier(id, version);
    // A copy of its own: the version stays what it was, whatever happens to the new current file.
    const key = attachmentKey(principal);
    await this.disk.copy(earlier.key, key);
    try {
      return await this.swap(
        principal,
        current,
        {
          key,
          name: earlier.name,
          size: earlier.size,
          contentType: earlier.contentType,
          note: options.note?.trim() || `Restored from version ${version}`,
        },
        'attachment.version-restored',
        { restoredVersion: version },
        options.ip,
      );
    } catch (error) {
      await this.disk.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The infected current file of an attachment that has earlier versions is
   * dropped and the latest earlier version becomes the current one again,
   * instead of the attachment (and its history) being deleted. Called in the
   * scan job's transaction; returns the row now current, or null when there
   * is no earlier version (the attachment is deleted) or the file was no
   * longer pending.
   */
  async revertRejected(rejected: Attachment): Promise<Attachment | null> {
    const [previous] = await this.db
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, rejected.id))
      .orderBy(desc(attachmentVersions.version))
      .limit(1);
    if (!previous) return null;
    const [reverted] = await this.db
      .update(attachments)
      .set({
        key: previous.key,
        name: previous.name,
        size: previous.size,
        contentType: previous.contentType,
        uploadedBy: previous.uploadedBy,
        revisionNote: previous.note,
        version: previous.version,
        versionedAt: previous.uploadedAt,
        // It was clean when archived.
        scanStatus: 'clean',
        renditionStatus: this.images.wants(previous.contentType)
          ? 'pending'
          : null,
        textPending: isExtractable(previous.contentType),
        renditions: {},
      })
      .where(
        and(
          eq(attachments.id, rejected.id),
          eq(attachments.scanStatus, 'pending'),
        ),
      )
      .returning();
    if (!reverted) return null;
    await this.db
      .delete(attachmentVersions)
      .where(eq(attachmentVersions.id, previous.id));
    return reverted;
  }

  private async earlier(id: string, version: number) {
    const [row] = await this.db
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.attachmentId, id),
          eq(attachmentVersions.version, version),
        ),
      );
    if (!row) {
      throw new NotFoundException({
        code: 'attachment_version_not_found',
        message: `Attachment ${id} has no version ${version}.`,
      });
    }
    return row;
  }

  /** The attachment of this record, or a 404; never an issued document (409). */
  private async own(
    principal: Principal,
    record: RecordRef,
    id: string,
    ifMatch: string | undefined,
  ) {
    const current = await this.attachments.findReadable(principal, id);
    if (
      current.subject !== record.subject ||
      current.recordId !== record.recordId
    ) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    if (current.locked) {
      throw new ConflictException({
        code: 'attachment_locked',
        message: 'An issued document never changes: it has no versions.',
      });
    }
    // A stale ETag first: what another change did since is that change's, not a reason of this one.
    assertUnchanged(ifMatch, view(current));
    if (
      current.scanStatus === 'pending' ||
      current.renditionStatus === 'pending'
    ) {
      throw new ConflictException({
        code: 'attachment_busy',
        message:
          'This file is still being scanned or processed: try again in a moment.',
      });
    }
    if (current.version >= MAX_ATTACHMENT_VERSIONS) {
      throw new ConflictException({
        code: 'attachment_versions_limit',
        message: `An attachment keeps at most ${MAX_ATTACHMENT_VERSIONS} versions: remove it, or upload the file as a new attachment.`,
      });
    }
    return current;
  }

  /**
   * The one place a new current file is put in: the quota, the row's change
   * (only if still the version, and still idle, that the caller read), the
   * earlier file archived and the audit entry, in one transaction; then the
   * scan or the renditions queued and the superseded renditions deleted.
   */
  private async swap(
    principal: Principal,
    current: Attachment,
    next: NextVersion,
    action: string,
    extra: Record<string, unknown>,
    ip: string | undefined,
  ): Promise<AttachmentView> {
    const row = await this.txHost.withTransaction(async () => {
      await this.quotas.assertRoom(STORAGE_BYTES, next.size);
      const [updated] = await this.db
        .update(attachments)
        .set({
          key: next.key,
          name: next.name,
          size: next.size,
          contentType: next.contentType,
          uploadedBy: principalKey(principal),
          revisionNote: next.note,
          version: current.version + 1,
          versionedAt: new Date(),
          scanStatus: this.scans.enabled ? 'pending' : 'clean',
          renditionStatus: this.images.wants(next.contentType)
            ? 'pending'
            : null,
          textPending: isExtractable(next.contentType),
          renditions: {},
        })
        .where(
          and(
            eq(attachments.id, current.id),
            eq(attachments.version, current.version),
            eq(attachments.locked, false),
            eq(attachments.scanStatus, 'clean'),
            or(
              isNull(attachments.renditionStatus),
              ne(attachments.renditionStatus, 'pending'),
            ),
          ),
        )
        .returning();
      if (!updated) {
        throw new PreconditionFailedException({
          code: 'precondition_failed',
          message:
            'The attachment changed since you read it: read it again, then retry with its ETag.',
        });
      }
      await this.db.insert(attachmentVersions).values({
        attachmentId: current.id,
        version: current.version,
        key: current.key,
        name: current.name,
        size: current.size,
        contentType: current.contentType,
        uploadedBy: current.uploadedBy,
        note: current.revisionNote,
        uploadedAt: current.versionedAt,
      });
      await this.audit.record(principal, {
        action,
        targetType: 'attachment',
        targetId: current.id,
        details: {
          ...details(updated),
          previousVersion: current.version,
          version: updated.version,
          note: next.note,
          ...extra,
        },
        ip,
      });
      return updated;
    });
    // A job id is queued once: the version names this one.
    const again = `v${row.version}`;
    if (row.scanStatus === 'pending') {
      await this.scans.enqueue(row.id, again);
    } else if (row.renditionStatus === 'pending') {
      await this.images.enqueue(row.id, again);
    }
    this.attachments.changed(principal, row, row.id, 'processed');
    // The superseded file's renditions are derived: only the file itself is history.
    await this.attachments.deleteFiles(renditionKeys(current.renditions));
    return view(row);
  }
}
