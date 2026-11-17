import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AuditService } from '../audit/audit.service.js';
import { type Principal, principalKey } from '../auth/principal.js';
import { LEGAL_HOLD_LIST } from './holds.lists.js';
import type {
  PlaceLegalHoldDto,
  ReleaseLegalHoldDto,
} from './holds.schemas.js';
import { type LegalHoldRow, legalHolds } from './holds.tables.js';

const view = (hold: LegalHoldRow) => ({
  id: hold.id,
  subject: hold.subject,
  recordId: hold.recordId,
  reason: hold.reason,
  active: hold.releasedAt === null,
  placedBy: hold.placedBy,
  placedAt: hold.createdAt.toISOString(),
  releasedAt: hold.releasedAt?.toISOString() ?? null,
  releasedBy: hold.releasedBy,
  releaseNote: hold.releaseNote,
});

/**
 * Legal holds (README.md): placing and releasing them, audited
 * (`legal-hold.placed`, `legal-hold.released`, in the change's
 * transaction), and the checks that keep a held record: `assertNotHeld()`
 * before a delete (a 409 `legal_hold`) and `notHeld()` (holds.tables.ts) in
 * the SQL of the jobs that delete or rewrite for good.
 */
@Injectable()
export class LegalHoldsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
  ) {}

  /** A page of holds, newest first unless the query sorts. */
  async list(query: ListQuery) {
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
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  private async find(id: string) {
    const [hold] = await this.db
      .select()
      .from(legalHolds)
      .where(eq(legalHolds.id, id));
    if (!hold) {
      throw new NotFoundException(`Legal hold ${id} not found.`);
    }
    return hold;
  }

  async get(id: string) {
    return view(await this.find(id));
  }

  /** Holds a record, or every record of a subject (no `recordId`). */
  async place(principal: Principal, dto: PlaceLegalHoldDto, ip?: string) {
    const row = await this.txHost.withTransaction(async () => {
      const [hold] = await this.db
        .insert(legalHolds)
        .values({
          subject: dto.subject,
          recordId: dto.recordId ?? null,
          reason: dto.reason,
          placedBy: principalKey(principal),
        })
        .returning();
      await this.audit.record(principal, {
        action: 'legal-hold.placed',
        targetType: 'legalHold',
        targetId: hold!.id,
        details: {
          subject: dto.subject,
          recordId: dto.recordId ?? null,
          reason: dto.reason,
        },
        ip,
      });
      return hold!;
    });
    return view(row);
  }

  /** Releases a hold (a 404 when it is not there, a 409 when released already). */
  async release(
    principal: Principal,
    id: string,
    dto: ReleaseLegalHoldDto,
    ip?: string,
  ) {
    const row = await this.txHost.withTransaction(async () => {
      const [released] = await this.db
        .update(legalHolds)
        .set({
          releasedAt: new Date(),
          releasedBy: principalKey(principal),
          releaseNote: dto.note ?? null,
        })
        .where(and(eq(legalHolds.id, id), isNull(legalHolds.releasedAt)))
        .returning();
      if (!released) {
        await this.find(id); // a 404 when it is not there at all
        throw new ConflictException({
          code: 'legal_hold_released',
          message: 'This legal hold is released already.',
        });
      }
      await this.audit.record(principal, {
        action: 'legal-hold.released',
        targetType: 'legalHold',
        targetId: id,
        details: {
          subject: released.subject,
          recordId: released.recordId,
          note: dto.note ?? null,
        },
        ip,
      });
      return released;
    });
    return view(row);
  }

  /** The ids among `ids` of `subject` under an active hold (one query). */
  async heldAmong(
    subject: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const holds = await this.db
      .select({ recordId: legalHolds.recordId })
      .from(legalHolds)
      .where(
        and(
          eq(legalHolds.subject, subject),
          isNull(legalHolds.releasedAt),
          or(
            isNull(legalHolds.recordId),
            inArray(legalHolds.recordId, [...ids]),
          ),
        ),
      );
    if (holds.some((hold) => hold.recordId === null)) {
      return new Set(ids);
    }
    return new Set(holds.map((hold) => hold.recordId!));
  }

  /**
   * A 409 `legal_hold` when any of the records is held: call it in a
   * delete's transaction, before the write.
   */
  async assertNotHeld(subject: string, ids: readonly string[]) {
    const held = await this.heldAmong(subject, ids);
    if (held.size > 0) {
      throw new ConflictException({
        code: 'legal_hold',
        message: `${subject} ${[...held].join(', ')} is under a legal hold and cannot be deleted.`,
      });
    }
  }
}
