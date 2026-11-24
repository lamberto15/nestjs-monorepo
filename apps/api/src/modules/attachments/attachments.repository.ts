import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import {
  headline,
  matches,
  rank,
  rankedMatches,
} from '../records/full-text.js';
import type { RecordTable } from '../records/record.js';
import { ATTACHMENT_LIST } from './attachments.lists.js';
import {
  type Attachment,
  attachments,
  attachmentUploads,
  attachmentVersions,
} from './attachments.tables.js';
import {
  type AttachmentTextStatus,
  attachmentTexts,
} from './attachments.texts.tables.js';

type NewAttachment = typeof attachments.$inferInsert;
type NewUpload = typeof attachmentUploads.$inferInsert;
type NewVersion = typeof attachmentVersions.$inferInsert;

/** A record's attachments: its subject and id. */
interface RecordRef {
  subject: string;
  recordId: string;
}

const ofRecord = (record: RecordRef) =>
  and(
    eq(attachments.subject, record.subject),
    eq(attachments.recordId, record.recordId),
  );

const ofRecords = (subject: string, ids: readonly string[]) =>
  and(
    eq(attachments.subject, subject),
    inArray(attachments.recordId, [...ids]),
  );

/** The upload `id` of the record, by `uploadedBy`, not completed. */
const ownUpload = (id: string, record: RecordRef, uploadedBy: string) =>
  and(
    eq(attachmentUploads.id, id),
    eq(attachmentUploads.subject, record.subject),
    eq(attachmentUploads.recordId, record.recordId),
    eq(attachmentUploads.uploadedBy, uploadedBy),
    isNull(attachmentUploads.completedAt),
  );

/** The pending scans: all of them, or those uploaded before `before`. */
const pendingScan = (before?: Date) =>
  and(
    eq(attachments.scanStatus, 'pending'),
    before ? lt(attachments.createdAt, before) : undefined,
  );

/**
 * The pending renditions: all of them, or the clean images (a scan still
 * running queues the job itself when it ends) changed before `before`.
 */
const pendingImage = (before?: Date) =>
  and(
    eq(attachments.renditionStatus, 'pending'),
    before ? eq(attachments.scanStatus, 'clean') : undefined,
    before ? lt(attachments.updatedAt, before) : undefined,
  );

/** The files waiting for their text: attachments_text_pending_idx's predicate, changed before `before`. */
const pendingText = (before: Date) =>
  and(
    eq(attachments.textPending, true),
    eq(attachments.scanStatus, 'clean'),
    eq(attachments.locked, false),
    isNull(attachments.fields),
    lt(attachments.updatedAt, before),
  );

/** The attachments', their versions', uploads' and texts' queries, in the caller's transaction and tenant. */
@Injectable()
export class AttachmentsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  // Attachments

  async find(id: string) {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, id));
    return row;
  }

  /** A page of the record's attachments and the count; `hidden` never matches a filter by name. */
  async page(record: RecordRef, query: ListQuery, hidden: string[]) {
    const where = and(
      ofRecord(record),
      ATTACHMENT_LIST.where(query),
      hidden.length ? notInArray(attachments.id, hidden) : undefined,
    );
    return Promise.all([
      this.db
        .select()
        .from(attachments)
        .where(and(where, afterCursor(attachments.id, query)))
        .orderBy(...pageOrder(attachments.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, attachments, where, query),
    ]);
  }

  /** The record's issued documents: those that show some of its fields. */
  async issued(record: RecordRef) {
    return this.db
      .select({ id: attachments.id, fields: attachments.fields })
      .from(attachments)
      .where(and(ofRecord(record), isNotNull(attachments.fields)));
  }

  /** The record's scanned files, oldest first. */
  async clean(record: RecordRef) {
    return this.db
      .select()
      .from(attachments)
      .where(and(ofRecord(record), eq(attachments.scanStatus, 'clean')))
      .orderBy(attachments.id);
  }

  async insert(values: NewAttachment) {
    const [row] = await this.db.insert(attachments).values(values).returning();
    return row!;
  }

  /** Deletes the attachment unless it is locked; the row deleted. */
  async deleteUnlocked(id: string) {
    const [row] = await this.db
      .delete(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.locked, false)))
      .returning();
    return row;
  }

  async moveRecord(subject: string, from: string, to: string) {
    await this.db
      .update(attachments)
      .set({ recordId: to })
      .where(
        and(eq(attachments.subject, subject), eq(attachments.recordId, from)),
      );
  }

  /** The files of the earlier versions of these records' attachments. */
  async versionKeysOfRecords(subject: string, ids: readonly string[]) {
    const rows = await this.db
      .select({ key: attachmentVersions.key })
      .from(attachmentVersions)
      .innerJoin(
        attachments,
        eq(attachments.id, attachmentVersions.attachmentId),
      )
      .where(ofRecords(subject, ids));
    return rows.map((row) => row.key);
  }

  async deleteOfRecords(subject: string, ids: readonly string[]) {
    return this.db
      .delete(attachments)
      .where(ofRecords(subject, ids))
      .returning();
  }

  /** The attachments a person uploaded, newest first, after `cursor`. */
  async uploadedBy(key: string, cursor: string | undefined, limit: number) {
    return this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.uploadedBy, key),
          cursor ? lt(attachments.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(attachments.id))
      .limit(limit);
  }

  async renameUploader(from: string, to: string) {
    await this.db
      .update(attachments)
      .set({ uploadedBy: to })
      .where(eq(attachments.uploadedBy, from));
  }

  /** Which of these keys are attachments' files. */
  async usedKeys(keys: string[]) {
    const rows = await this.db
      .select({ key: attachments.key })
      .from(attachments)
      .where(inArray(attachments.key, keys));
    return rows.map((row) => row.key);
  }

  // The malware scan

  /** Marks the attachment clean if it was pending; whether it was. */
  async markClean(id: string) {
    const [row] = await this.db
      .update(attachments)
      .set({ scanStatus: 'clean' })
      .where(and(eq(attachments.id, id), eq(attachments.scanStatus, 'pending')))
      .returning({ id: attachments.id });
    return !!row;
  }

  /** The oldest pending scans (uploaded before `before`, when given). */
  async pendingScans(before: Date | undefined, limit: number) {
    return this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(pendingScan(before))
      .orderBy(asc(attachments.createdAt))
      .limit(limit);
  }

  /** The tenants with a pending scan (uploaded before `before`, when given), read across every tenant. */
  async pendingScanTenants(before: Date | undefined) {
    const rows = await this.db
      .selectDistinct({ tenantId: attachments.tenantId })
      .from(attachments)
      .where(pendingScan(before));
    return rows.map((row) => row.tenantId);
  }

  /** Marks the oldest `limit` pending scans clean; the rows. */
  async releasePendingScans(limit: number) {
    return this.db
      .update(attachments)
      .set({ scanStatus: 'clean' })
      .where(
        and(
          eq(attachments.scanStatus, 'pending'),
          inArray(
            attachments.id,
            this.db
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.scanStatus, 'pending'))
              .orderBy(asc(attachments.createdAt))
              .limit(limit),
          ),
        ),
      )
      .returning();
  }

  /** Deletes the attachment if its scan is still pending; whether it was. */
  async deletePending(id: string) {
    const [row] = await this.db
      .delete(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.scanStatus, 'pending')))
      .returning({ id: attachments.id });
    return !!row;
  }

  // The image renditions

  /** The images waiting longest for their renditions (see pendingImage). */
  async pendingImages(before: Date | undefined, limit: number) {
    return this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(pendingImage(before))
      .orderBy(asc(attachments.updatedAt))
      .limit(limit);
  }

  async pendingImageTenants(before: Date | undefined) {
    const rows = await this.db
      .selectDistinct({ tenantId: attachments.tenantId })
      .from(attachments)
      .where(pendingImage(before));
    return rows.map((row) => row.tenantId);
  }

  /** Clears the state of the `limit` images waiting longest; how many. */
  async releasePendingImages(limit: number) {
    const rows = await this.db
      .update(attachments)
      .set({ renditionStatus: null })
      .where(
        inArray(
          attachments.id,
          this.db
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.renditionStatus, 'pending'))
            .orderBy(asc(attachments.updatedAt))
            .limit(limit),
        ),
      )
      .returning({ id: attachments.id });
    return rows.length;
  }

  /** Records the renditions while the image is still pending with the key read; the row. */
  async storeRenditions(row: Attachment, values: Partial<NewAttachment>) {
    const [done] = await this.db
      .update(attachments)
      .set({ ...values, renditionStatus: 'ready' })
      .where(
        and(
          eq(attachments.id, row.id),
          eq(attachments.renditionStatus, 'pending'),
          eq(attachments.key, row.key),
        ),
      )
      .returning();
    return done;
  }

  /** Marks a pending image failed; whether it was pending. */
  async failRenditions(id: string) {
    const [done] = await this.db
      .update(attachments)
      .set({ renditionStatus: 'failed' })
      .where(
        and(eq(attachments.id, id), eq(attachments.renditionStatus, 'pending')),
      )
      .returning({ id: attachments.id });
    return !!done;
  }

  // The texts

  /** Whether the file at `key` has its text. */
  async hasText(attachmentId: string, key: string) {
    const [row] = await this.db
      .select({ id: attachmentTexts.id })
      .from(attachmentTexts)
      .where(
        and(
          eq(attachmentTexts.attachmentId, attachmentId),
          eq(attachmentTexts.key, key),
        ),
      );
    return !!row;
  }

  async pendingTexts(before: Date, limit: number) {
    return this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(pendingText(before))
      .orderBy(asc(attachments.updatedAt))
      .limit(limit);
  }

  async pendingTextTenants(before: Date) {
    const rows = await this.db
      .selectDistinct({ tenantId: attachments.tenantId })
      .from(attachments)
      .where(pendingText(before));
    return rows.map((row) => row.tenantId);
  }

  /** Whether the attachment still has the file at `key`, locked against its removal until the commit. */
  async shareLockFile(id: string, key: string) {
    const [row] = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.key, key)))
      .for('share');
    return !!row;
  }

  /** The attachment's text, replacing what an earlier file of it had. */
  async saveText(
    attachmentId: string,
    key: string,
    status: AttachmentTextStatus,
    text: string,
  ) {
    await this.db
      .insert(attachmentTexts)
      .values({ attachmentId, key, status, text })
      .onConflictDoUpdate({
        target: [attachmentTexts.tenantId, attachmentTexts.attachmentId],
        set: { key, status, text, updatedAt: new Date() },
      });
  }

  /** The file at `key` needs no more extraction (if it is still the attachment's). */
  async settleText(id: string, key: string) {
    await this.db
      .update(attachments)
      .set({ textPending: false })
      .where(and(eq(attachments.id, id), eq(attachments.key, key)));
  }

  /**
   * The best text matches of one record type's files, read only where
   * `readable` lets the record through: scanned, not issued.
   */
  async searchTexts(
    table: RecordTable,
    subject: string,
    readable: SQL | undefined,
    q: string,
    limit: number,
  ) {
    // On attachment_texts alone, so the capped count and the ranking find the
    // matches by the GIN index; the record's read filter decides per match.
    const where = and(
      matches(attachmentTexts.search, q),
      exists(
        this.db
          .select({ id: attachments.id })
          .from(attachments)
          .innerJoin(
            table as unknown as PgTable,
            eq(table.id, attachments.recordId),
          )
          .where(
            and(
              eq(attachments.id, attachmentTexts.attachmentId),
              eq(attachments.key, attachmentTexts.key),
              eq(attachments.subject, subject),
              eq(attachments.scanStatus, 'clean'),
              eq(attachments.locked, false),
              isNull(attachments.fields),
              readable,
            ),
          ),
      ),
    );
    const score = rank(attachmentTexts.search, q);
    return this.db
      .select({
        id: attachments.id,
        name: attachments.name,
        recordId: attachments.recordId,
        score,
        snippet: headline(attachmentTexts.text, q),
      })
      .from(attachmentTexts)
      .innerJoin(attachments, eq(attachments.id, attachmentTexts.attachmentId))
      .where(
        and(
          where,
          await rankedMatches(
            this.db,
            attachmentTexts,
            attachmentTexts.id,
            where,
          ),
        ),
      )
      .orderBy(desc(score), desc(attachmentTexts.id))
      .limit(limit);
  }

  // Versions

  /** The files of the earlier versions of these attachments. */
  async versionKeys(ids: string[]) {
    const rows = await this.db
      .select({ key: attachmentVersions.key })
      .from(attachmentVersions)
      .where(inArray(attachmentVersions.attachmentId, ids));
    return rows.map((version) => version.key);
  }

  /** The attachment's earlier versions, newest first. */
  async versions(attachmentId: string) {
    return this.db
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, attachmentId))
      .orderBy(desc(attachmentVersions.version));
  }

  async latestVersion(attachmentId: string) {
    const [row] = await this.db
      .select()
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, attachmentId))
      .orderBy(desc(attachmentVersions.version))
      .limit(1);
    return row;
  }

  async findVersion(attachmentId: string, version: number) {
    const [row] = await this.db
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.attachmentId, attachmentId),
          eq(attachmentVersions.version, version),
        ),
      );
    return row;
  }

  async insertVersion(values: NewVersion) {
    await this.db.insert(attachmentVersions).values(values);
  }

  async deleteVersion(id: string) {
    await this.db
      .delete(attachmentVersions)
      .where(eq(attachmentVersions.id, id));
  }

  /** Changes the attachment while its scan is still pending; the row. */
  async updatePending(id: string, values: Partial<NewAttachment>) {
    const [row] = await this.db
      .update(attachments)
      .set(values)
      .where(and(eq(attachments.id, id), eq(attachments.scanStatus, 'pending')))
      .returning();
    return row;
  }

  /**
   * Changes the attachment while it is still at `version` and idle: not
   * locked, scanned, no renditions pending. The row, or none.
   */
  async updateIdle(
    id: string,
    version: number,
    values: Partial<NewAttachment>,
  ) {
    const [row] = await this.db
      .update(attachments)
      .set(values)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.version, version),
          eq(attachments.locked, false),
          eq(attachments.scanStatus, 'clean'),
          or(
            isNull(attachments.renditionStatus),
            ne(attachments.renditionStatus, 'pending'),
          ),
        ),
      )
      .returning();
    return row;
  }

  // Uploads

  /** How many of a person's uploads can still be completed at `now`. */
  async countOpenUploads(uploadedBy: string, now: Date) {
    const [row] = await this.db
      .select({ pending: count() })
      .from(attachmentUploads)
      .where(
        and(
          eq(attachmentUploads.uploadedBy, uploadedBy),
          isNull(attachmentUploads.completedAt),
          gt(attachmentUploads.expiresAt, now),
        ),
      );
    return row?.pending ?? 0;
  }

  async insertUpload(values: NewUpload) {
    const [row] = await this.db
      .insert(attachmentUploads)
      .values(values)
      .returning();
    return row!;
  }

  /** Whether the upload is open at `offset` (received, not completing), locked until the commit. */
  async lockUploadAt(id: string, offset: number) {
    const [row] = await this.db
      .select({ id: attachmentUploads.id })
      .from(attachmentUploads)
      .where(
        and(
          eq(attachmentUploads.id, id),
          eq(attachmentUploads.received, offset),
          isNull(attachmentUploads.completingAt),
          isNull(attachmentUploads.completedAt),
        ),
      )
      .for('update');
    return !!row;
  }

  async updateUpload(id: string, values: Partial<NewUpload>) {
    const [row] = await this.db
      .update(attachmentUploads)
      .set(values)
      .where(eq(attachmentUploads.id, id))
      .returning();
    return row;
  }

  async deleteUploads(ids: string[]) {
    await this.db
      .delete(attachmentUploads)
      .where(inArray(attachmentUploads.id, ids));
  }

  /** The person's open resumable session of the record. */
  async findSession(id: string, record: RecordRef, uploadedBy: string) {
    const [row] = await this.db
      .select()
      .from(attachmentUploads)
      .where(
        and(
          ownUpload(id, record, uploadedBy),
          eq(attachmentUploads.resumable, true),
        ),
      );
    return row;
  }

  /** Claims the person's upload for completion unless claimed since `staleBefore`; the row. */
  async claimUpload(
    id: string,
    record: RecordRef,
    uploadedBy: string,
    staleBefore: Date,
  ) {
    const [row] = await this.db
      .update(attachmentUploads)
      .set({ completingAt: new Date() })
      .where(
        and(
          ownUpload(id, record, uploadedBy),
          or(
            isNull(attachmentUploads.completingAt),
            lt(attachmentUploads.completingAt, staleBefore),
          ),
        ),
      )
      .returning();
    return row;
  }

  /** Whether the person has this open upload of the record. */
  async hasUpload(id: string, record: RecordRef, uploadedBy: string) {
    const [row] = await this.db
      .select({ id: attachmentUploads.id })
      .from(attachmentUploads)
      .where(ownUpload(id, record, uploadedBy));
    return !!row;
  }

  /** The uploads expired before `before`, by id. */
  async expiredUploads(before: Date, limit: number) {
    return this.db
      .select({
        id: attachmentUploads.id,
        key: attachmentUploads.key,
        resumable: attachmentUploads.resumable,
        completedAt: attachmentUploads.completedAt,
      })
      .from(attachmentUploads)
      .where(lt(attachmentUploads.expiresAt, before))
      .orderBy(asc(attachmentUploads.id))
      .limit(limit);
  }
}
