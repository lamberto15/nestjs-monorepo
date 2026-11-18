import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { type ListQuery, queryMatches } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import {
  requireTenantId,
  TenantScopeMissingError,
} from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { LegalHoldsService } from '../../iam/holds/holds.service.js';
import { SubscriptionsService } from '../notifications/subscriptions.service.js';
import { QuotasService } from '../quotas/quotas.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import type { RenditionName } from '../images/renditions.js';
import { publicRenditions, renditionKeys } from './attachments.renditions.js';
import { Records } from '../records/records.service.js';
import { isTenantFileKey, tenantFileKey } from '../storage/storage.keys.js';
import { attachmentsConfig } from './attachments.config.js';
import { recordAttachmentsChanged } from './attachments.events.js';
import { ATTACHMENT_LIST } from './attachments.lists.js';
import { STORAGE_BYTES } from './attachments.quota.js';
import {
  AttachmentImagesQueue,
  AttachmentScanQueue,
  AttachmentTextQueue,
} from './attachments.queues.js';
import type { AttachmentView } from './attachments.schemas.js';
import {
  type Attachment,
  attachments,
  attachmentVersions,
} from './attachments.tables.js';
import { isExtractable } from './attachments.extractor.js';

/** How long a download link works. */
export const DOWNLOAD_LINK_TTL = '5m';

/**
 * The types `?inline=true` shows in the browser: PDF only, which the
 * browser's viewer renders without running the file's scripts in this
 * origin. Never HTML, SVG, XML or anything else that can script.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set(['application/pdf']);

/** The most watchers a push to open pages looks at. */
const MAX_AUDIENCE = 200;

type Action = 'added' | 'removed' | 'scanned' | 'processed';

/** A record, by its permission subject and id. */
export interface RecordRef {
  subject: string;
  recordId: string;
}

/**
 * Where an upload of `principal` goes on the private disk: under its
 * tenant's prefix, `tenants/<id>/attachments/<random><.ext>`, so a tenant's
 * files are one prefix to export or delete. The tenant is the principal's
 * (the request's), never the client's say.
 */
export function attachmentKey(principal: Principal, extension = '') {
  const tenantId =
    principal.kind === 'system' ? requireTenantId() : principal.tenantId;
  if (!tenantId) {
    throw new TenantScopeMissingError('An upload needs a tenant.');
  }
  return tenantFileKey(tenantId, `attachments/${randomUUID()}${extension}`);
}

/** A file of another tenant (or outside any) can't become this tenant's attachment. */
export function assertOwnFile(key: string) {
  if (!isTenantFileKey(requireTenantId('An attachment'), key)) {
    throw new Error(`File ${key} is not under this tenant's prefix.`);
  }
}

/**
 * Files attached to the records of every record type that imports
 * `AttachmentsModule.forRecord()`. The bytes go to the private disk as they
 * arrive (the upload interceptor), the row here with its audit entry in one
 * transaction; downloads are short-lived signed links. Who may see a
 * record's attachments, and who may add them, is the record's policy: read
 * the record to see them, change it (`update`) to attach; an uploader may
 * always remove their own, and anyone who may change the record may remove
 * any.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger('Attachments');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly disk: StorageDisk,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly holds: LegalHoldsService,
    private readonly quotas: QuotasService,
    private readonly users: UsersRepository,
    private readonly subscriptions: SubscriptionsService,
    private readonly realtime: Realtime,
    private readonly scans: AttachmentScanQueue,
    private readonly images: AttachmentImagesQueue,
    private readonly texts: AttachmentTextQueue,
    @Inject(attachmentsConfig.KEY)
    readonly config: ConfigType<typeof attachmentsConfig>,
  ) {}

  /** What a client may send: the largest file and the types (also in a record's list description). */
  get limits() {
    return {
      maxBytes: this.config.maxBytes,
      maxMb: this.config.maxMb,
      types: [...this.config.types],
    };
  }

  /** The record, once the principal may read it: else a 404 (missing, unreadable, or of a type that takes no attachments). */
  async readableRecord(principal: Principal, record: RecordRef) {
    const registration = this.records.find(record.subject);
    if (!registration) {
      throw new NotFoundException(
        `${record.subject} ${record.recordId} not found.`,
      );
    }
    return registration.store.findOne(record.recordId, {
      visibleTo: principal,
    });
  }

  /**
   * Whether the principal may read the record and, when given, every one of
   * `fields` of it (an issued document's: field-level permissions, a field
   * hidden on this record counts as hidden).
   */
  private async canRead(
    principal: Principal,
    record: RecordRef,
    fields?: readonly string[] | null,
  ) {
    try {
      const row = await this.readableRecord(principal, record);
      if (!fields?.length) return true;
      return this.showsFields(principal, record.subject, row, fields);
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  /** Whether reading the record shows the principal every one of `fields` (those it has: a name it lacks is no field). */
  async showsFields(
    principal: Principal,
    subject: string,
    row: Record<string, unknown>,
    fields: readonly string[],
  ) {
    const shown = await this.access.redact(principal, 'read', subject, row);
    return fields.every((field) => !(field in row) || field in shown);
  }

  private async canWrite(principal: Principal, record: RecordRef) {
    return this.access.can(
      principal,
      'update',
      record.subject,
      await this.readableRecord(principal, record),
    );
  }

  /** A 404 unless the principal may read the record, a 403 unless they may change it. */
  async assertCanUpload(principal: Principal, record: RecordRef) {
    if (!(await this.canWrite(principal, record))) {
      throw new ForbiddenException(
        `You may not attach files to ${record.subject} ${record.recordId}.`,
      );
    }
  }

  /** One attachment, as the API shows it: whoever may read its record, else a 404. */
  async get(principal: Principal, id: string): Promise<AttachmentView> {
    return view(await this.findReadable(principal, id));
  }

  /** A page of the record's attachments, newest first. */
  async list(principal: Principal, record: RecordRef, query: ListQuery) {
    const found = await this.readableRecord(principal, record);
    // An issued document stays listed (as the old list did), but its name is
    // made from its record's fields: who may not read them all (as get()
    // requires) sees a neutral name, and a filter or sort by name never
    // matches the real one.
    const withheld = await this.withheldNames(principal, record, found);
    const where = and(
      eq(attachments.subject, record.subject),
      eq(attachments.recordId, record.recordId),
      ATTACHMENT_LIST.where(query),
      withheld.size && queryMatches(query).includes('name')
        ? notInArray(attachments.id, [...withheld])
        : undefined,
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(attachments)
        .where(and(where, afterCursor(attachments.id, query)))
        .orderBy(...pageOrder(attachments.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, attachments, where, query),
    ]);
    const page = toPage(rows, query, total);
    const noun = this.records.find(record.subject)!.declaration.noun;
    return {
      ...page,
      items: page.items.map((row) =>
        withheld.has(row.id)
          ? {
              ...view(row),
              name: t('attachments.withheldName', {
                args: { noun, extension: extname(row.name) },
              }),
            }
          : view(row),
      ),
    };
  }

  /** The record's issued documents whose fields the principal may not all read: their names are withheld. */
  private async withheldNames(
    principal: Principal,
    record: RecordRef,
    row: Record<string, unknown>,
  ) {
    const issued = await this.db
      .select({ id: attachments.id, fields: attachments.fields })
      .from(attachments)
      .where(
        and(
          eq(attachments.subject, record.subject),
          eq(attachments.recordId, record.recordId),
          isNotNull(attachments.fields),
        ),
      );
    const withheld = new Set<string>();
    for (const { id, fields } of issued) {
      if (
        fields?.length &&
        !(await this.showsFields(principal, record.subject, row, fields))
      ) {
        withheld.add(id);
      }
    }
    return withheld;
  }

  /**
   * Records a file the upload stored (`file.key`) as the record's
   * attachment, audited `attachment.added`. Refused or failed, the file is
   * deleted from the disk. The one way an uploaded file becomes an
   * attachment: the quota, the tenant, the audit entry, the malware scan and
   * the image renditions are this method's.
   */
  async upload(
    principal: Principal,
    record: RecordRef,
    file: Pick<StoredUpload, 'key' | 'originalname' | 'size' | 'contentType'>,
    ip?: string,
    {
      within,
    }: {
      /** More work for the attachment's transaction (a completed upload is marked done with it, or not at all). */
      within?: () => Promise<unknown>;
    } = {},
  ): Promise<AttachmentView> {
    try {
      await this.assertCanUpload(principal, record);
      assertOwnFile(file.key);
      const row = await this.txHost.withTransaction(async () => {
        // 422 `quota_exceeded` past the tenant's storage; the catch below deletes the file.
        await this.quotas.assertRoom(STORAGE_BYTES, file.size);
        const [row] = await this.db
          .insert(attachments)
          .values({
            ...record,
            key: file.key,
            // The client's name, for showing and downloading: never a path.
            name: fileName(file.originalname),
            size: file.size,
            contentType: file.contentType,
            uploadedBy: principalKey(principal),
            // Off (the default): clean at once. Otherwise it waits for its scan.
            scanStatus: this.scans.enabled ? 'pending' : 'clean',
            // An image waits for its renditions (once it is clean); anything else has none.
            renditionStatus: this.images.wants(file.contentType)
              ? 'pending'
              : null,
            textPending: isExtractable(file.contentType),
          })
          .returning();
        await this.audit.record(principal, {
          action: 'attachment.added',
          targetType: 'attachment',
          targetId: row!.id,
          details: details(row!),
          ip,
        });
        await within?.();
        return row!;
      });
      if (row.scanStatus === 'pending') {
        // The scan queues the image job when it finds the file clean.
        await this.scans.enqueue(row.id);
      } else if (row.renditionStatus === 'pending') {
        await this.images.enqueue(row.id);
      }
      this.changed(principal, row, row.id, 'added');
      return view(row);
    } catch (error) {
      await this.disk.delete(file.key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Records a file the app wrote to the disk itself (`key`) as the record's
   * attachment, audited `attachment.added`, in the caller's transaction: a
   * generated document is linked to its record in the transaction that
   * completes its job, or the file has no row (and the caller deletes it).
   * `locked`: an issued document, which nobody removes. `fields`: the
   * record's fields it shows; only who may read all of them sees it. Call `changed()`
   * after the commit.
   */
  async attachStored(
    principal: Principal,
    record: RecordRef,
    file: { key: string; name: string; size: number; contentType: string },
    {
      locked = false,
      fields = null,
    }: { locked?: boolean; fields?: string[] | null } = {},
  ): Promise<AttachmentView> {
    assertOwnFile(file.key);
    await this.quotas.assertRoom(STORAGE_BYTES, file.size);
    const [row] = await this.db
      .insert(attachments)
      .values({
        ...record,
        key: file.key,
        name: fileName(file.name),
        size: file.size,
        contentType: file.contentType,
        uploadedBy: principalKey(principal),
        locked,
        fields,
      })
      .returning();
    await this.audit.record(principal, {
      action: 'attachment.added',
      targetType: 'attachment',
      targetId: row!.id,
      details: { ...details(row!), locked, fields },
    });
    return view(row!);
  }

  /**
   * A signed link to the file (DOWNLOAD_LINK_TTL), downloading under its
   * name. `inline`: shown in the browser instead, for a PDF only; any other
   * type stays an attachment. The disposition is part of what the link
   * signs, so a client can't turn one link into the other. `rendition`: the
   * link to the image's `thumb` or `preview` instead (a WebP, inline), a 404
   * when it has none.
   */
  async download(
    principal: Principal,
    id: string,
    {
      inline = false,
      rendition,
    }: { inline?: boolean; rendition?: RenditionName } = {},
  ) {
    const row = await this.findReadable(principal, id);
    if (row.scanStatus === 'pending') {
      throw new ConflictException({
        code: 'attachment_scan_pending',
        message:
          'This file is still being scanned for malware: try again in a moment.',
      });
    }
    if (rendition) {
      const file = row.renditions[rendition];
      if (!file) {
        throw new NotFoundException({
          code: 'attachment_rendition_not_found',
          message:
            row.renditionStatus === 'pending'
              ? `The ${rendition} of attachment ${id} is not made yet: try again in a moment.`
              : `Attachment ${id} has no ${rendition}.`,
        });
      }
      // Our own WebP, always safe to show: the renditions are for <img>s and previews.
      return {
        url: await this.disk.signedUrl(file.key, {
          expiresIn: DOWNLOAD_LINK_TTL,
          filename: renditionName(row.name, rendition),
          disposition: 'inline',
        }),
      };
    }
    return {
      url: await this.disk.signedUrl(row.key, {
        expiresIn: DOWNLOAD_LINK_TTL,
        filename: row.name,
        disposition:
          inline && INLINE_TYPES.has(row.contentType) ? 'inline' : 'attachment',
      }),
    };
  }

  /**
   * Removes an attachment, row and files (the renditions too), audited
   * `attachment.removed`: the uploader's own, or any by whoever may change
   * the record. Never an issued document (`locked`: 409), nor one of a
   * record under a legal hold (409).
   */
  async remove(principal: Principal, id: string, ip?: string) {
    const row = await this.findReadable(principal, id);
    if (row.locked) {
      throw new ConflictException({
        code: 'attachment_locked',
        message:
          'An issued document cannot be removed: it stays with its record.',
      });
    }
    if (
      row.uploadedBy !== principalKey(principal) &&
      !(await this.canWrite(principal, row))
    ) {
      throw new ForbiddenException('You may not remove this attachment.');
    }
    let versionKeys: string[] = [];
    const removed = await this.txHost.withTransaction(async () => {
      // A held record keeps its files, every version of them (409 `legal_hold`).
      await this.holds.assertNotHeld(row.subject, [row.recordId]);
      versionKeys = await this.versionKeys([row.id]);
      const [gone] = await this.db
        .delete(attachments)
        .where(and(eq(attachments.id, row.id), eq(attachments.locked, false)))
        .returning();
      if (!gone) throw new NotFoundException(`Attachment ${id} not found.`);
      await this.audit.record(principal, {
        action: 'attachment.removed',
        targetType: 'attachment',
        targetId: row.id,
        details: details(row),
        ip,
      });
      return gone;
    });
    this.changed(principal, row, row.id, 'removed');
    // The files of the row that was deleted, not of the one read above: an
    // image job may have replaced the original and added renditions since.
    await this.deleteFiles([
      removed.key,
      ...renditionKeys(removed.renditions),
      ...versionKeys,
    ]);
  }

  /**
   * Records gone for good (a purge, a delete without bin): their attachments
   * go too, row and files, in the delete's transaction (the files are
   * deleted at once; a failure leaves an orphan, never a row without its file).
   */
  /** A merge: the duplicate's files move to the survivor (their keys stay). */
  async merge(subject: string, from: string, to: string) {
    await this.db
      .update(attachments)
      .set({ recordId: to })
      .where(
        and(eq(attachments.subject, subject), eq(attachments.recordId, from)),
      );
  }

  async forget(subject: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    const earlier = await this.db
      .select({ key: attachmentVersions.key })
      .from(attachmentVersions)
      .innerJoin(
        attachments,
        eq(attachments.id, attachmentVersions.attachmentId),
      )
      .where(
        and(
          eq(attachments.subject, subject),
          inArray(attachments.recordId, [...ids]),
        ),
      );
    const gone = await this.db
      .delete(attachments)
      .where(
        and(
          eq(attachments.subject, subject),
          inArray(attachments.recordId, [...ids]),
        ),
      )
      .returning();
    await this.deleteFiles([
      ...gone.flatMap((row) => [row.key, ...renditionKeys(row.renditions)]),
      ...earlier.map((version) => version.key),
    ]);
  }

  /** The files of the earlier versions of these attachments. */
  private async versionKeys(ids: string[]) {
    const rows = await this.db
      .select({ key: attachmentVersions.key })
      .from(attachmentVersions)
      .where(inArray(attachmentVersions.attachmentId, ids));
    return rows.map((version) => version.key);
  }

  /**
   * After the commit of an attachment's change: `record.attachments.changed`
   * to the record's watchers and `by`'s other tabs who may read it. Not
   * awaited: the answer doesn't wait for the permission checks, and a
   * failure is logged.
   */
  changed(
    by: Principal,
    record: RecordRef,
    attachmentId: string,
    action: Action,
    fields?: readonly string[] | null,
  ) {
    // The text of a file that may be served is extracted (the job skips what is not clean yet).
    if (action !== 'removed') {
      void this.texts.enqueue(attachmentId, `${action}-${randomUUID()}`);
    }
    void (async () => {
      const keys = [
        ...new Set([
          principalKey(by),
          ...(await this.subscriptions.watchers(record)),
        ]),
      ].slice(0, MAX_AUDIENCE);
      const audience: { kind: 'user'; id: string }[] = [];
      const tenantId = requireTenantId('A push');
      for (const key of keys) {
        const [kind, id] = key.split(':') as [string, string];
        if (kind !== 'user') continue;
        const reader = await this.users.inTenant(id, tenantId);
        if (reader && (await this.canRead(reader, record, fields))) {
          audience.push({ kind: 'user', id });
        }
      }
      this.realtime.toPrincipals(audience, recordAttachmentsChanged, {
        subject: record.subject,
        recordId: record.recordId,
        attachmentId,
        action,
      });
    })().catch((error: unknown) =>
      this.logger.warn('An attachment change was not pushed live', {
        error: String(error),
      }),
    );
  }

  /**
   * A shared record's files (modules/shares), as `principal` (the link's
   * maker) may read them: scanned, oldest first. An issued document is
   * listed only when the link's `fields` cover every field it shows, and
   * its maker may still read them all.
   */
  async sharedFiles(
    principal: Principal,
    record: RecordRef,
    fields: readonly string[],
  ) {
    const row = await this.readableRecord(principal, record);
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.subject, record.subject),
          eq(attachments.recordId, record.recordId),
          eq(attachments.scanStatus, 'clean'),
        ),
      )
      .orderBy(attachments.id);
    const covered = rows.filter((file) =>
      (file.fields ?? []).every((field) => fields.includes(field)),
    );
    const files: Attachment[] = [];
    for (const file of covered) {
      if (
        !file.fields?.length ||
        (await this.showsFields(principal, record.subject, row, file.fields))
      ) {
        files.push(file);
      }
    }
    return files.map(({ id, name, size, contentType }) => ({
      id,
      name,
      size,
      contentType,
    }));
  }

  /** The download link of one of `sharedFiles()`, or a 404 for any other file. */
  async sharedDownload(
    principal: Principal,
    record: RecordRef,
    fields: readonly string[],
    id: string,
  ) {
    const files = await this.sharedFiles(principal, record, fields);
    if (!files.some((file) => file.id === id)) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    return this.download(principal, id);
  }

  /** An attachment of a record the principal may read, or a 404. */
  async findReadable(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, id));
    if (!row) throw new NotFoundException(`Attachment ${id} not found.`);
    if (!(await this.canRead(principal, row, row.fields))) {
      throw new NotFoundException(`Attachment ${id} not found.`);
    }
    return row;
  }

  /** Deletes files nothing points at; a failure leaves an orphan, never a failed request. */
  async deleteFiles(keys: string[]) {
    if (keys.length === 0) return;
    await this.disk.delete(keys).catch((error: unknown) =>
      this.logger.warn('An attachment file was not deleted', {
        keys,
        error: String(error),
      }),
    );
  }
}

/** An attachment as the API shows it: without its storage key. */
export const view = ({
  key: _key,
  fields: _fields,
  renditions,
  ...row
}: Attachment): AttachmentView => ({
  ...row,
  renditions: publicRenditions(renditions),
  versionedAt: row.versionedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const details = (row: Attachment) => ({
  subject: row.subject,
  recordId: row.recordId,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
});

/** The last segment of a client's file name, without control characters, at most 255 characters. */
export function fileName(original: string | undefined) {
  const name = (original ?? '')
    .split(/[/\\]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F"]/g, '')
    .trim()
    .slice(0, 255);
  return name || 'file';
}

/** The download name of a rendition: `photo.jpg`'s thumb is `photo.thumb.webp`. */
function renditionName(name: string, rendition: RenditionName) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${rendition}.webp`;
}
