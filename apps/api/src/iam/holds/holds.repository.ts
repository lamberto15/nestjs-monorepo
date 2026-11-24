import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { LEGAL_HOLD_LIST } from './holds.lists.js';
import { type LegalHoldRow, legalHolds } from './holds.tables.js';

/** The queries of legal holds, in the request's tenant and the ambient transaction. */
@Injectable()
export class LegalHoldsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of holds, newest first unless the query sorts. */
  async page(query: ListQuery) {
    const where = LEGAL_HOLD_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(legalHolds)
        .where(and(where, afterCursor(legalHolds.id, query)))
        .orderBy(...pageOrder(legalHolds.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, legalHolds, where, query),
    ]);
    return toPage(rows, query, total);
  }

  async findById(id: string): Promise<LegalHoldRow | undefined> {
    const [hold] = await this.db
      .select()
      .from(legalHolds)
      .where(eq(legalHolds.id, id));
    return hold;
  }

  async insert(values: {
    subject: string;
    recordId: string | null;
    reason: string;
    placedBy: string;
  }) {
    const [hold] = await this.db.insert(legalHolds).values(values).returning();
    return hold!;
  }

  /** Releases a hold still active; undefined when there is none. */
  async release(
    id: string,
    values: {
      releasedAt: Date;
      releasedBy: string;
      releaseNote: string | null;
    },
  ): Promise<LegalHoldRow | undefined> {
    const [released] = await this.db
      .update(legalHolds)
      .set(values)
      .where(and(eq(legalHolds.id, id), isNull(legalHolds.releasedAt)))
      .returning();
    return released;
  }

  /** The active holds of `subject` on these records or on all of them (`recordId` null). */
  activeHoldsOn(subject: string, ids: string[]) {
    return this.db
      .select({ recordId: legalHolds.recordId })
      .from(legalHolds)
      .where(
        and(
          eq(legalHolds.subject, subject),
          isNull(legalHolds.releasedAt),
          or(isNull(legalHolds.recordId), inArray(legalHolds.recordId, ids)),
        ),
      );
  }
}
