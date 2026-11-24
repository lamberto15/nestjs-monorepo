import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { RecordRecentDto } from './recents.schemas.js';
import { recentRecords } from './recents.tables.js';

/**
 * The queries of recent records, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class RecentsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** An owner's entries viewed after `after`, newest first. */
  listOf(owner: string, after: Date, limit: number) {
    return this.db
      .select()
      .from(recentRecords)
      .where(
        and(eq(recentRecords.owner, owner), gt(recentRecords.viewedAt, after)),
      )
      .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
      .limit(limit);
  }

  /** Every entry of an owner, newest first (the export). */
  allOf(owner: string) {
    return this.db
      .select()
      .from(recentRecords)
      .where(eq(recentRecords.owner, owner))
      .orderBy(desc(recentRecords.viewedAt));
  }

  async upsert(owner: string, dto: RecordRecentDto) {
    const [row] = await this.db
      .insert(recentRecords)
      .values({ ...dto, owner })
      .onConflictDoUpdate({
        target: [
          recentRecords.tenantId,
          recentRecords.owner,
          recentRecords.subject,
          recentRecords.recordId,
        ],
        // The database's clock, as the insert's default: with the app's, a
        // re-opened record sorted below one opened a moment earlier whenever
        // the two clocks differed.
        set: { label: dto.label, viewedAt: sql`now()` },
      })
      .returning();
    return row!;
  }

  async countOf(owner: string) {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(recentRecords)
      .where(eq(recentRecords.owner, owner));
    return total;
  }

  /** Deletes an owner's entries past the newest `keep`. */
  async deleteBeyond(owner: string, keep: number) {
    const stale = await this.db
      .select({ id: recentRecords.id })
      .from(recentRecords)
      .where(eq(recentRecords.owner, owner))
      .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
      .offset(keep);
    await this.db.delete(recentRecords).where(
      inArray(
        recentRecords.id,
        stale.map((s) => s.id),
      ),
    );
  }

  /** Deletes one of the owner's entries; true when there was one. */
  async deleteOne(owner: string, id: string) {
    const deleted = await this.db
      .delete(recentRecords)
      .where(and(eq(recentRecords.id, id), eq(recentRecords.owner, owner)))
      .returning({ id: recentRecords.id });
    return deleted.length > 0;
  }

  async deleteAllOf(owner: string) {
    await this.db.delete(recentRecords).where(eq(recentRecords.owner, owner));
  }

  async deleteForRecords(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recentRecords)
      .where(
        and(
          eq(recentRecords.subject, subject),
          inArray(recentRecords.recordId, [...recordIds]),
        ),
      );
  }

  /** Deletes up to `limit` entries viewed before `before`; how many went. */
  async deleteViewedBefore(before: Date, limit: number) {
    const rows = await this.db
      .delete(recentRecords)
      .where(
        inArray(
          recentRecords.id,
          this.db
            .select({ id: recentRecords.id })
            .from(recentRecords)
            .where(lt(recentRecords.viewedAt, before))
            .limit(limit),
        ),
      )
      .returning({ id: recentRecords.id });
    return rows.length;
  }
}
