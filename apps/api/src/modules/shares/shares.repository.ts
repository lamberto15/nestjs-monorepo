import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { RecordRegistration } from '../records/records.service.js';
import { recordShares } from './shares.tables.js';

/** A record a link is made for: its subject and id. */
interface RecordRef {
  subject: string;
  recordId: string;
}

/**
 * The links' queries, in the caller's tenant and transaction
 * (`@InjectTransaction()`). "Working": not revoked, not expired.
 */
@Injectable()
export class SharesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A record's links, newest first. */
  ofRecord(record: RecordRef) {
    return this.db
      .select()
      .from(recordShares)
      .where(this.whereRecord(record))
      .orderBy(desc(recordShares.id));
  }

  async findOfRecord(record: RecordRef, id: string) {
    const [row] = await this.db
      .select()
      .from(recordShares)
      .where(and(eq(recordShares.id, id), this.whereRecord(record)));
    return row;
  }

  /** The working link of this token hash. */
  async findWorking(tokenHash: string) {
    const [share] = await this.db
      .select()
      .from(recordShares)
      .where(and(eq(recordShares.tokenHash, tokenHash), this.working()));
    return share;
  }

  /** Locks a record's row until the commit. */
  async lockRecord(registration: RecordRegistration, recordId: string) {
    const table = registration.feature.table;
    await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(eq(table.id, recordId))
      .for('update');
  }

  async countWorking(record: RecordRef) {
    const [{ open }] = await this.db
      .select({ open: count() })
      .from(recordShares)
      .where(and(this.whereRecord(record), this.working()));
    return open!;
  }

  async insert(values: typeof recordShares.$inferInsert) {
    const [created] = await this.db
      .insert(recordShares)
      .values(values)
      .returning();
    return created!;
  }

  async revoke(id: string, by: string) {
    await this.db
      .update(recordShares)
      .set({ revokedAt: new Date(), revokedBy: by })
      .where(and(eq(recordShares.id, id), isNull(recordShares.revokedAt)));
  }

  async countView(id: string) {
    await this.db
      .update(recordShares)
      .set({
        views: sql`${recordShares.views} + 1`,
        lastViewedAt: new Date(),
      })
      .where(eq(recordShares.id, id));
  }

  async saveCode(id: string, codeHash: string, codeExpiresAt: Date) {
    await this.db
      .update(recordShares)
      .set({ codeHash, codeExpiresAt, codeAttempts: 0 })
      .where(eq(recordShares.id, id));
  }

  /** A link's code, locked until the commit. */
  async lockCode(id: string) {
    const [current] = await this.db
      .select({
        codeHash: recordShares.codeHash,
        codeExpiresAt: recordShares.codeExpiresAt,
        codeAttempts: recordShares.codeAttempts,
      })
      .from(recordShares)
      .where(eq(recordShares.id, id))
      .for('update');
    return current;
  }

  async countAttempt(id: string) {
    await this.db
      .update(recordShares)
      .set({ codeAttempts: sql`${recordShares.codeAttempts} + 1` })
      .where(eq(recordShares.id, id));
  }

  async deleteForRecords(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recordShares)
      .where(
        and(
          eq(recordShares.subject, subject),
          inArray(recordShares.recordId, [...recordIds]),
        ),
      );
  }

  /** The links a person made, without their secrets (their export). */
  madeBy(key: string) {
    return this.db
      .select({
        id: recordShares.id,
        subject: recordShares.subject,
        recordId: recordShares.recordId,
        fields: recordShares.fields,
        files: recordShares.files,
        recipientEmail: recordShares.recipientEmail,
        expiresAt: recordShares.expiresAt,
        revokedAt: recordShares.revokedAt,
        views: recordShares.views,
        createdAt: recordShares.createdAt,
      })
      .from(recordShares)
      .where(eq(recordShares.createdBy, key));
  }

  /** A person's working links revoked, and their name replaced by `by` on every link. */
  async anonymize(key: string, by: string) {
    await this.db
      .update(recordShares)
      .set({ revokedAt: new Date(), revokedBy: by })
      .where(
        and(eq(recordShares.createdBy, key), isNull(recordShares.revokedAt)),
      );
    await this.db
      .update(recordShares)
      .set({ createdBy: by })
      .where(eq(recordShares.createdBy, key));
    await this.db
      .update(recordShares)
      .set({ revokedBy: by })
      .where(eq(recordShares.revokedBy, key));
  }

  private whereRecord(record: RecordRef) {
    return and(
      eq(recordShares.subject, record.subject),
      eq(recordShares.recordId, record.recordId),
    );
  }

  private working() {
    return and(
      isNull(recordShares.revokedAt),
      gt(recordShares.expiresAt, new Date()),
    );
  }
}
