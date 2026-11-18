import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import {
  MAX_RECENTS,
  RECENTS_RETENTION_DAYS,
  type RecordRecentDto,
} from './recents.schemas.js';
import { RecentsRegistry } from './recents.registry.js';
import { recentRecords } from './recents.tables.js';

type Row = typeof recentRecords.$inferSelect;

/**
 * A person's recently opened records: bounded (MAX_RECENTS, the oldest drops
 * out), not older than RECENTS_RETENTION_DAYS, their own alone. Recording
 * checks they can read the record, and the list checks again, leaving out
 * what they no longer see or what is gone, so a title is never shown for a
 * record they may not read. Cleared by them any time, and gone with the
 * record's purge and the nightly sweep.
 */
@Injectable()
export class RecentsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly registry: RecentsRegistry,
  ) {}

  /** The principal's recent records, newest first, without what they no longer see. */
  async list(principal: Principal) {
    const rows = await this.db
      .select()
      .from(recentRecords)
      .where(
        and(
          eq(recentRecords.owner, principalKey(principal)),
          gt(recentRecords.viewedAt, this.cutoff()),
        ),
      )
      .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
      .limit(MAX_RECENTS);
    const seen = await Promise.all(
      rows.map((row) => this.sees(principal, row)),
    );
    return {
      items: rows.filter((_, i) => seen[i]).map((row) => this.item(row)),
    };
  }

  /** Notes that the principal opened a record they can read: first in their list, and the list stays bounded. */
  async record(principal: Principal, dto: RecordRecentDto) {
    await this.assertSees(principal, dto);
    const owner = principalKey(principal);
    return this.txHost.withTransaction(async () => {
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
      // Past the bound: the oldest go.
      const [{ total }] = await this.db
        .select({ total: count() })
        .from(recentRecords)
        .where(eq(recentRecords.owner, owner));
      if (total > MAX_RECENTS) {
        const stale = await this.db
          .select({ id: recentRecords.id })
          .from(recentRecords)
          .where(eq(recentRecords.owner, owner))
          .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
          .offset(MAX_RECENTS);
        await this.db.delete(recentRecords).where(
          inArray(
            recentRecords.id,
            stale.map((s) => s.id),
          ),
        );
      }
      return this.item(row!);
    });
  }

  /** Removes one of the principal's recent records, or a 404. */
  async remove(principal: Principal, id: string) {
    const deleted = await this.db
      .delete(recentRecords)
      .where(
        and(
          eq(recentRecords.id, id),
          eq(recentRecords.owner, principalKey(principal)),
        ),
      )
      .returning({ id: recentRecords.id });
    if (deleted.length === 0) {
      throw new NotFoundException(`Recent record ${id} not found.`);
    }
  }

  /** Clears the principal's history in this tenant. */
  async clear(principal: Principal) {
    await this.db
      .delete(recentRecords)
      .where(eq(recentRecords.owner, principalKey(principal)));
  }

  /** When records are gone for good: nobody's recent records any more. */
  async forget(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recentRecords)
      .where(
        and(
          eq(recentRecords.subject, subject),
          inArray(recentRecords.recordId, [...recordIds]),
        ),
      );
  }

  /** The age past which an entry is expired. */
  private cutoff(now = Date.now()) {
    return new Date(now - RECENTS_RETENTION_DAYS * 86_400_000);
  }

  private async sees(
    principal: Principal,
    recent: Pick<Row, 'subject' | 'recordId'>,
  ) {
    try {
      await this.assertSees(principal, recent);
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        return false;
      }
      throw error;
    }
  }

  /** A 404 unless the principal can read the record (as reading it would). */
  private async assertSees(
    principal: Principal,
    recent: Pick<Row, 'subject' | 'recordId'> | RecordRecentDto,
  ) {
    const record = this.registry.has(recent.subject)
      ? this.records.find(recent.subject)
      : undefined;
    if (!record) {
      throw new NotFoundException(`No records of ${recent.subject}.`);
    }
    await record.store.findOne(recent.recordId, { visibleTo: principal });
  }

  private item(row: Row) {
    return {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      label: row.label,
      viewedAt: row.viewedAt.toISOString(),
    };
  }
}
