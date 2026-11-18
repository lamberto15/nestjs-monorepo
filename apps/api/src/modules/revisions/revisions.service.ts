import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  type RecordDeclaration,
  recordValues,
  recordView,
} from '../records/record.js';
import { assertWritableFields } from '../records/record.routes.js';
import { Records } from '../records/records.service.js';
import { fieldSnapshot, writableFields } from '../fields/fields.js';
import { REVISION_LIST } from './revisions.list.js';
import type { RevisionView } from './revisions.schemas.js';
import { type Changes, revisions } from './revisions.tables.js';

type Revision = typeof revisions.$inferSelect;
type Snapshot = Record<string, unknown>;

/** Who wrote a record's state from before it kept revisions: not known. */
export const UNKNOWN_CHANGER = 'unknown';

/** What a revision keeps of a row: the fields a body may set, as the API shows them. */
export const snapshotOf = (
  declaration: RecordDeclaration,
  row: Record<string, unknown>,
): Snapshot =>
  fieldSnapshot(
    writableFields(declaration.fields),
    recordView(declaration, row) as Record<string, unknown>,
  );

/** What differs between two snapshots, from `before`'s values to `after`'s. */
export function diff(before: Snapshot, after: Snapshot): Changes {
  const changes: Changes = {};
  for (const field of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[field] = { from, to };
    }
  }
  return changes;
}

/**
 * Record revisions: each saved state of a record, numbered per record, with
 * what changed. The record's extension writes them in the transaction of
 * each change (RevisionsExtension); whoever may read the record reads
 * them, whoever may change it restores one, through the record's own
 * store: audited as any change, and a new revision marked `restoredFrom`.
 */
@Injectable()
export class RevisionsService {
  /** The bodies of restores in progress, by object: the `updated` hook of that write reads the revision's number. */
  private readonly restoring = new WeakMap<object, number>();

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** The revision a write's `input` restores, if it is a restore's. */
  restoredFrom(input: object) {
    return this.restoring.get(input);
  }

  /**
   * In the change's transaction: the record's next revision, holding
   * `snapshot` and what changed since the last one. Nothing when nothing
   * changed. On create, revision 1 (no `changes`). An update passes `before`:
   * a record with no revision yet (written before its feature kept them)
   * first gets revision 1 from it (by `unknown`), so its earlier state
   * stays restorable. The record's write holds its row lock, so two changes
   * of one record take turns; the unique index is the invariant.
   */
  async record(
    subject: string,
    recordId: string,
    {
      snapshot,
      before,
      by,
      restoredFrom,
    }: {
      snapshot: Snapshot;
      before?: Snapshot;
      by: Principal;
      restoredFrom?: number;
    },
  ) {
    const [last] = await this.db
      .select({ number: revisions.number, snapshot: revisions.snapshot })
      .from(revisions)
      .where(this.of(subject, recordId))
      .orderBy(desc(revisions.number))
      .limit(1);
    let previous = last;
    if (!previous && before) {
      [previous] = await this.db
        .insert(revisions)
        .values({
          subject,
          recordId,
          number: 1,
          snapshot: before,
          changes: null,
          changedBy: UNKNOWN_CHANGER,
        })
        .returning({ number: revisions.number, snapshot: revisions.snapshot });
    }
    const changes = previous ? diff(previous.snapshot, snapshot) : null;
    if (changes && Object.keys(changes).length === 0) return;
    await this.db.insert(revisions).values({
      subject,
      recordId,
      number: (previous?.number ?? 0) + 1,
      snapshot,
      changes,
      restoredFrom: restoredFrom ?? null,
      changedBy: principalKey(by),
    });
  }

  /** A page of a record's revisions, newest first unless the query sorts (404 when the principal may not read the record). */
  async list(
    principal: Principal,
    subject: string,
    recordId: string,
    query: ListQuery,
  ) {
    const readable = await this.readable(principal, subject, recordId);
    const where = and(
      this.of(subject, recordId),
      readable.shown,
      REVISION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(revisions)
        .where(and(where, this.after(subject, recordId, query)))
        .orderBy(
          ...(query.sort?.length
            ? pageOrder(revisions.id, query)
            : [desc(revisions.number)]),
        )
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, revisions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: await this.views(readable, page.items) };
  }

  /** One revision of a record, or a 404. */
  async get(
    principal: Principal,
    subject: string,
    recordId: string,
    number: number,
  ) {
    const readable = await this.readable(principal, subject, recordId);
    const [view] = await this.views(readable, [
      await this.findOne(subject, recordId, number, readable.shown),
    ]);
    return view!;
  }

  /** What differs from revision `a`'s values to `b`'s (either order). */
  async diff(
    principal: Principal,
    subject: string,
    recordId: string,
    a: number,
    b: number,
  ) {
    const readable = await this.readable(principal, subject, recordId);
    const [from, to] = await Promise.all([
      this.findOne(subject, recordId, a, readable.shown),
      this.findOne(subject, recordId, b, readable.shown),
    ]);
    const changes = diff(from.snapshot, to.snapshot);
    return {
      from: a,
      to: b,
      changes: Object.fromEntries(
        Object.entries(changes).filter(([field]) => readable.allowed(field)),
      ),
    };
  }

  /**
   * Sets the record's fields back to a revision's, as a PATCH would set
   * them (the same permissions, field-level ones too): through the store,
   * so the add-ons' hooks, the audit entry and a new revision (`restoredFrom`)
   * come with it. Nothing is written when the record already has those
   * values. Answers the record as its GET shows it.
   */
  async restore(
    principal: Principal,
    subject: string,
    recordId: string,
    number: number,
    unchanged: (current: object) => void,
  ) {
    const { store, feature, presenter, declaration } = this.records.of(subject);
    // Only a revision the principal may see: else it would restore what it hides.
    const { row, shown } = await this.readable(principal, subject, recordId);
    const revision = await this.findOne(subject, recordId, number, shown);
    const changed = diff(snapshotOf(declaration, row), revision.snapshot);
    // Only fields the record still has (a revision may predate a removed one).
    const body = Object.fromEntries(
      Object.entries(changed)
        .filter(([field]) => field in snapshotOf(declaration, row))
        .map(([field, { to }]) => [field, to]),
    );
    const check = async (current: Record<string, unknown>) => {
      await this.authorization.authorize(
        feature.policy,
        'update',
        principal,
        current,
      );
      await assertWritableFields(
        this.access,
        principal,
        'update',
        declaration,
        body,
        current,
      );
      unchanged(await presenter.one(principal, current));
    };
    if (Object.keys(body).length === 0) {
      await check(row);
      return presenter.one(principal, row);
    }
    this.restoring.set(body, number);
    const updated = await store.update(
      principal,
      recordId,
      recordValues(declaration, body),
      { check, input: body },
    );
    return presenter.one(principal, updated);
  }

  /** Records gone for good: their revisions go with them (in that transaction). */
  async forget(subject: string, recordIds: readonly string[]) {
    if (recordIds.length === 0) return;
    await this.db
      .delete(revisions)
      .where(
        and(
          eq(revisions.subject, subject),
          inArray(revisions.recordId, [...recordIds]),
        ),
      );
  }

  /**
   * The record, once the principal may read it (else a 404: its existence
   * stays hidden), as the table holds it, which of its fields they may see, and the revisions they
   * may see (`shown`): the first, and those that change a field they see.
   * A revision of hidden fields only would still tell that, when and who
   * changed one.
   */
  private async readable(
    principal: Principal,
    subject: string,
    recordId: string,
  ) {
    const { store, feature, declaration } = this.records.of(subject);
    const row = await store.findOne(recordId, { visibleTo: principal });
    await this.authorization.authorize(feature.policy, 'read', principal, row);
    const view = recordView(declaration, row) as Record<string, unknown>;
    const shown = await this.access.redact(principal, 'read', subject, view);
    const visible = Object.keys(shown);
    return {
      row,
      allowed: (field: string) => field in shown,
      // Drizzle has no jsonb `?|` (has any of these keys).
      shown:
        visible.length === Object.keys(view).length
          ? undefined
          : or(
              isNull(revisions.changes),
              sql`${revisions.changes} ?| ${sql.param(visible)}::text[]`,
            ),
    };
  }

  private async findOne(
    subject: string,
    recordId: string,
    number: number,
    shown?: SQL,
  ) {
    // An integer column: a number outside it is no revision (not a database error).
    const [row] = !(number >= 1 && number <= 2_147_483_647)
      ? []
      : await this.db
          .select()
          .from(revisions)
          .where(
            and(
              this.of(subject, recordId),
              eq(revisions.number, number),
              shown,
            ),
          );
    if (!row) {
      throw new NotFoundException(
        `Revision ${number} of ${subject} ${recordId} not found.`,
      );
    }
    return row;
  }

  /** Revisions as the API shows them: hidden fields left out of snapshots and changes, with who changed them by name. */
  private async views(
    readable: { allowed: (field: string) => boolean },
    rows: Revision[],
  ): Promise<RevisionView[]> {
    // Their names in one query, whatever the page's size.
    const named = await this.audit.withActorNames(
      rows.map((row) => ({ actor: row.changedBy })),
    );
    const keep = <T>(values: Record<string, T>) =>
      Object.fromEntries(
        Object.entries(values).filter(([field]) => readable.allowed(field)),
      );
    return rows.map((row, index) => ({
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      number: row.number,
      snapshot: keep(row.snapshot),
      changes: row.changes && keep(row.changes),
      restoredFrom: row.restoredFrom,
      changedBy: row.changedBy,
      changedByName: named[index]!.actorName,
      changedAt: row.changedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private of(subject: string, recordId: string) {
    return and(
      eq(revisions.subject, subject),
      eq(revisions.recordId, recordId),
    );
  }

  /**
   * Newest first by default: after the cursor's revision is a lower number.
   * A cursor of another record's revision is none of this one's: no rows.
   */
  private after(subject: string, recordId: string, query: ListQuery) {
    if (!query.cursor || query.sort?.length) {
      return afterCursor(revisions.id, query);
    }
    if (!z.uuid().safeParse(query.cursor).success) {
      throw validationException([
        { path: ['cursor'], message: 'is not a revision cursor' },
      ]);
    }
    return lt(
      revisions.number,
      this.db
        .select({ number: revisions.number })
        .from(revisions)
        .where(and(this.of(subject, recordId), eq(revisions.id, query.cursor))),
    );
  }
}
