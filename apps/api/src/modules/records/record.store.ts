import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, getColumns, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { List, ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Events } from '../../core/outbox/events.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { memberships } from '../../iam/auth/auth.tables.js';
import { AccessService } from '../../iam/access/access.service.js';
import { PermissionCatalog } from '../../iam/access/permission-catalog.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { LegalHoldsService } from '../../iam/holds/holds.service.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { QuotasService } from '../quotas/quotas.service.js';
import { refuseBroadRank } from './full-text.js';
import { recordKey, type RecordRow, recordView } from './record.js';
import type { RecordHooks } from './record-extension.js';
import {
  emptyReferences,
  relationsFrom,
  relationsTo,
} from './record-relations.js';
import { recordEvents } from './record.events.js';
import { RecordFeature, Records } from './records.service.js';

/** How a single-record lookup finds its record. */
export interface RecordLookup {
  /** One in the recycle bin, and only those. */
  deleted?: boolean;
  /**
   * Only one this principal may read (in the recycle bin: restore), in the
   * query: a record they may not read is the same 404 as a missing one.
   */
  visibleTo?: Principal;
}

/** Checks a write makes on the record as it is, locked, before changing it (a 403, a 412). */
export type CurrentCheck<Row> = (current: Row) => Promise<void> | void;

/** What a write passes along: the check on the locked row, the request's body for the add-ons' hooks. */
export interface WriteOptions<Row> {
  check?: CurrentCheck<Row>;
  /** The validated body: add-ons read their keys from it (`customFields`). */
  input?: object;
}

/**
 * A record's reads and writes, whose shape its declaration decides (the
 * recycle bin, units), for the feature's service. Each write runs in one
 * transaction with what it causes: the hooks of the record's add-ons
 * (RecordHooks), its audit entry (`<item>.created`…, iam/audit) and its
 * domain event (`recordEvents()`, core/outbox). The feature's service
 * keeps the business logic around these calls. Provided by
 * RecordsModule.forFeature().
 */
@Injectable()
export class RecordStore<Row extends RecordRow = RecordRow> {
  constructor(
    private readonly feature: RecordFeature,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
    private readonly events: Events,
    @Inject(OrganizationService)
    private readonly organization: OrganizationService,
    private readonly holds: LegalHoldsService,
    // Only with forFeature({ quota }), which imports QuotasModule.
    @Optional() private readonly quotas?: QuotasService,
  ) {}

  private get declaration() {
    return this.feature.declaration;
  }

  private get table() {
    return this.feature.table;
  }

  /** The current transaction, or the database outside one. */
  private get db() {
    return this.txHost.tx;
  }

  private get hooks(): readonly RecordHooks[] {
    return this.records.of(this.declaration.subject).extensions;
  }

  private notFound(id: string) {
    const noun = this.declaration.noun;
    return new NotFoundException(
      `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id} not found.`,
    );
  }

  /**
   * One, or a 404. With a recycle bin, deleted ones are found only with
   * `deleted` (and only they). With `visibleTo`, only one that principal
   * may read (`deleted`: restore), filtered in the query.
   */
  async findOne(
    id: string,
    { deleted = false, visibleTo }: RecordLookup = {},
  ): Promise<Row> {
    const t = this.table;
    const { softDelete, subject } = this.declaration;
    if (deleted && !softDelete) throw this.notFound(id);
    const visible = visibleTo
      ? await this.access.sqlFilter(
          visibleTo,
          subject,
          deleted ? 'restore' : 'read',
          { deleted },
        )
      : undefined;
    const [row] = await this.db
      .select()
      .from(t as unknown as PgTable)
      .where(
        and(
          eq(t.id, id),
          softDelete
            ? deleted
              ? isNotNull(t.deletedAt!)
              : isNull(t.deletedAt!)
            : undefined,
          visible,
        ),
      );
    if (!row) throw this.notFound(id);
    return row as Row;
  }

  /**
   * A page of the records `user` may read matching a list query (the
   * recycle bin with `?deleted=true`, for those who may restore), newest
   * first. `list` is the one the query was parsed with (RecordPresenter.query).
   */
  async findPage(user: Principal, list: List, query: ListQuery) {
    const t = this.table;
    const where = and(
      await this.access.sqlFilter(
        user,
        this.declaration.subject,
        query.deleted ? 'restore' : 'read',
        { deleted: query.deleted === true },
      ),
      list.where(query),
    );
    await refuseBroadRank(this.db, t as unknown as PgTable, where, query);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          ...getColumns(t as unknown as PgTable),
          ...list.sortSelect(query),
        })
        .from(t as unknown as PgTable)
        .where(and(where, afterCursor(t.id, query)))
        .orderBy(...pageOrder(t.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, t as unknown as PgTable, where, query),
    ]);
    return toPage(rows as Row[], query, total);
  }

  /**
   * A new record of `owner`'s: `values` are its columns
   * (`recordValues(INVOICE, dto)` and what the service derives); the owner
   * and, with units, the owner's unit (their only current one, else none)
   * are added. `by` acts, when not the owner (a system job).
   */
  async create(
    owner: Principal,
    values: Record<string, unknown>,
    { by = owner, input = {} }: { by?: Principal; input?: object } = {},
  ): Promise<Row> {
    const body = input as Record<string, unknown>;
    const unitId =
      this.declaration.unit && owner.kind === 'user'
        ? await this.onlyUnitOf(owner.id)
        : null;
    return this.txHost.withTransaction(async () => {
      // The last place: the quota locks its own row until the commit.
      if (this.feature.quota) await this.quotas!.assertRoom(this.feature.quota);
      let all = { ...values };
      for (const hooks of this.hooks) {
        const added = await hooks.creating?.({
          values: all,
          owner,
          by,
          input: body,
        });
        if (added) all = { ...all, ...added };
      }
      await this.assertReferences(by, all);
      const [row] = (await this.db
        .insert(this.table as unknown as PgTable)
        .values({
          ...all,
          ownerId: principalKey(owner),
          ...(this.declaration.unit && { unitId }),
        })
        .returning()
        .catch((error: unknown) => this.taken(error))) as Row[];
      for (const hooks of this.hooks) {
        await hooks.created?.({ row: row!, by, input: body });
      }
      await this.changed('created', row!, by);
      return row!;
    });
  }

  /**
   * Changes one: locks it, runs `check` on it as it is (the policy, the
   * If-Match), then the add-ons' `updating` hooks (which may add columns),
   * and writes `changes` (columns) when there are any.
   */
  async update(
    by: Principal,
    id: string,
    changes: Record<string, unknown>,
    { check, input = {} }: WriteOptions<Row> = {},
  ): Promise<Row> {
    const body = input as Record<string, unknown>;
    return this.txHost.withTransaction(async () => {
      const before = await this.lock(id);
      await check?.(before);
      let all = { ...changes };
      for (const hooks of this.hooks) {
        const added = await hooks.updating?.({
          before,
          changes: all,
          by,
          input: body,
        });
        if (added) all = { ...all, ...added };
      }
      if (Object.keys(all).length === 0) return before;
      await this.assertReferences(by, all, before);
      const [after] = (await this.db
        .update(this.table as unknown as PgTable)
        .set(all)
        .where(eq(this.table.id, id))
        .returning()
        .catch((error: unknown) => this.taken(error))) as Row[];
      for (const hooks of this.hooks) {
        await hooks.updated?.({ before, after: after!, by, input: body });
      }
      await this.changed('updated', after!, by, this.changesOf(before, after!));
      return after!;
    });
  }

  /**
   * Deletes one: to the recycle bin when it has one, else for good. Refused
   * under a legal hold (409 `legal_hold`, iam/holds) and while records
   * refer to it (409 `record_referenced`).
   */
  async delete(
    by: Principal,
    id: string,
    { check, input = {} }: WriteOptions<Row> = {},
  ) {
    const body = input as Record<string, unknown>;
    await this.txHost.withTransaction(async () => {
      const current = await this.lock(id);
      await check?.(current);
      await this.holds.assertNotHeld(this.declaration.subject, [id]);
      await this.assertNotReferred(current);
      for (const hooks of this.hooks) {
        await hooks.deleting?.({ row: current, by, input: body });
      }
      let row: Row = current;
      if (this.declaration.softDelete) {
        [row] = (await this.db
          .update(this.table as unknown as PgTable)
          .set({ deletedAt: new Date(), deletedBy: principalKey(by) })
          .where(eq(this.table.id, id))
          .returning()) as Row[] as [Row];
      } else {
        await this.forget(by, [id]);
        await this.db
          .delete(this.table as unknown as PgTable)
          .where(eq(this.table.id, id));
      }
      for (const hooks of this.hooks) {
        await hooks.deleted?.({ row, by, input: body });
      }
      await this.changed('deleted', row, by);
    });
  }

  /**
   * Out of the recycle bin: the record as it is now. A unique value
   * another record took meanwhile is a 409 `<item>_taken`; past the
   * record's stock quota (it counts live records), a 422 `quota_exceeded`.
   */
  async restore(by: Principal, id: string): Promise<Row> {
    if (!this.declaration.softDelete) throw this.notFound(id);
    return this.txHost.withTransaction(async () => {
      // As in create(): the quota's lock first, then the row's.
      if (this.feature.quota) await this.quotas!.assertRoom(this.feature.quota);
      const [row] = (await this.db
        .update(this.table as unknown as PgTable)
        .set({ deletedAt: null, deletedBy: null })
        .where(and(eq(this.table.id, id), isNotNull(this.table.deletedAt!)))
        .returning()
        .catch((error: unknown) => this.taken(error))) as Row[];
      if (!row) throw this.notFound(id);
      await this.assertReferencesLive(row);
      for (const hooks of this.hooks) {
        await hooks.restored?.({ row, by, input: {} });
      }
      await this.changed('restored', row, by);
      return row;
    });
  }

  /**
   * Deletes records of the recycle bin for good (the recycle bin's purge),
   * in one transaction with what goes with them: the optional references
   * to them emptied, the add-ons' `purged` hooks, the audit entry
   * `records.purged`. The caller leaves out held ones (`notHeld()`).
   */
  async purge(by: Principal, ids: readonly string[]) {
    if (ids.length === 0) return;
    await this.txHost.withTransaction(async () => {
      await this.forget(by, ids);
      await this.db
        .delete(this.table as unknown as PgTable)
        .where(inArray(this.table.id, [...ids]));
      await this.audit.record(by, {
        action: 'records.purged',
        targetType: recordKey(this.declaration),
        details: { ids },
      });
    });
  }

  /**
   * After a merge (modules/merge) moved `from` into `to`, in its
   * transaction: each extension's `merged` hook moves what it keeps about
   * the duplicate to the survivor. The merge calls it; nothing else does.
   */
  async merged(by: Principal, from: Row, to: Row) {
    await this.txHost.withTransaction(async () => {
      for (const hooks of this.hooks) await hooks.merged?.({ from, to, by });
    });
  }

  /** What goes with records deleted for good: the references emptied, the add-ons told. */
  async forget(by: Principal, ids: readonly string[]) {
    await emptyReferences(this.db, this.declaration.subject, ids);
    for (const hooks of this.hooks) await hooks.purged?.({ ids, by });
  }

  /**
   * Each reference a write sets or changes names a live record `by` may
   * read: else a 422 `reference_not_found` (the same for one that doesn't
   * exist, is in another tenant or in the recycle bin).
   */
  private async assertReferences(
    by: Principal,
    values: Record<string, unknown>,
    before?: Row,
  ) {
    await this.assertMembers(values, before);
    for (const relation of relationsFrom(this.declaration)) {
      const id = values[relation.field] as string | null | undefined;
      const subject = relation.target();
      if (id == null || before?.[relation.field] === id || !subject) continue;
      const target = relation.targetTable();
      const [found] = await this.db
        .select({ id: target.id })
        .from(target as unknown as PgTable)
        .where(
          and(
            eq(target.id, id),
            await this.access.sqlFilter(by, subject, 'read', {
              deleted: false,
            }),
          ),
        )
        .limit(1);
      if (!found) {
        throw new UnprocessableEntityException({
          code: 'reference_not_found',
          message: `${relation.field}: no ${subject} ${id} that you may read.`,
          field: relation.field,
        });
      }
    }
  }

  /**
   * Each `user` field a write sets or changes names an active member of
   * the tenant: else a 422 `person_not_found` (the same for one of another
   * tenant, one who left or none). One kept as it was stays, a member who
   * left included.
   */
  private async assertMembers(values: Record<string, unknown>, before?: Row) {
    for (const [field, f] of Object.entries(this.declaration.fields)) {
      if (f.kind !== 'user') continue;
      const key = values[field];
      if (typeof key !== 'string' || before?.[field] === key) continue;
      const [found] = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, requireTenantId('A person field')),
            eq(memberships.userId, key.slice('user:'.length)),
            eq(memberships.active, true),
          ),
        )
        .limit(1);
      if (!found) {
        throw new UnprocessableEntityException({
          code: 'person_not_found',
          message: `${field}: ${key} is no member of this tenant.`,
          field,
        });
      }
    }
  }

  /**
   * A record a `restrict` reference points at can't go (409
   * `record_referenced`) while live records refer to it; a required one
   * counts those in the recycle bin too (the key would refuse the purge).
   */
  private async assertNotReferred(row: Row) {
    for (const relation of relationsTo(this.declaration.subject)) {
      if (relation.onDelete === 'keep') continue;
      const binned = relation.table.deletedAt;
      const [referring] = await this.db
        .select({ id: relation.table.id })
        .from(relation.table as unknown as PgTable)
        .where(
          and(
            eq(relation.column, row.id),
            relation.required || !binned ? undefined : isNull(binned),
          ),
        )
        .limit(1);
      if (referring) {
        throw new ConflictException({
          code: 'record_referenced',
          message: `${relation.from.path} still refer to this ${this.declaration.noun} (${relation.field}): change or delete them first.`,
          subject: relation.from.subject,
          field: relation.field,
        });
      }
    }
  }

  /**
   * A record restored while a `restrict` reference of its points at one in
   * the recycle bin: 409 `reference_deleted`, restore that one first.
   */
  private async assertReferencesLive(row: Row) {
    for (const relation of relationsFrom(this.declaration)) {
      const id = row[relation.field] as string | null | undefined;
      const target = relation.targetTable();
      if (id == null || relation.onDelete === 'keep' || !target.deletedAt) {
        continue;
      }
      const [binned] = await this.db
        .select({ id: target.id })
        .from(target as unknown as PgTable)
        .where(and(eq(target.id, id), isNotNull(target.deletedAt)))
        .limit(1);
      if (binned) {
        throw new ConflictException({
          code: 'reference_deleted',
          message: `${relation.field}: the ${relation.target() ?? 'record'} it refers to is in the recycle bin: restore it first.`,
          field: relation.field,
        });
      }
    }
  }

  /** One live record locked until the transaction ends, or a 404. */
  private async lock(id: string): Promise<Row> {
    const t = this.table;
    const [row] = await this.db
      .select()
      .from(t as unknown as PgTable)
      .where(
        and(
          eq(t.id, id),
          this.declaration.softDelete ? isNull(t.deletedAt!) : undefined,
        ),
      )
      .for('update');
    if (!row) throw this.notFound(id);
    return row as Row;
  }

  /** A user's only current unit, else none (none or several). */
  private async onlyUnitOf(userId: string) {
    const units = await this.organization.unitsOf(userId);
    return units.length === 1 ? units[0]! : null;
  }

  /** The audit entry and the domain event of a change, in its transaction. */
  private async changed(
    event: 'created' | 'updated' | 'deleted' | 'restored',
    row: Row,
    by: Principal,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ) {
    const { subject } = this.declaration;
    await this.audit.record(by, {
      action: `${recordKey(this.declaration)}.${event}`,
      targetType: subject,
      targetId: row.id,
      ...(changes && { details: { changes } }),
    });
    await this.events.publish(
      recordEvents(this.declaration)[event],
      {
        subject,
        id: row.id,
        by: principalKey(by),
        record: recordView(this.declaration, row),
      },
      { key: row.id },
    );
  }

  /** What an update changed, field by field, as the API shows it; sensitive fields' values left out. */
  private changesOf(before: Row, after: Row) {
    const sensitive = this.catalog.sensitiveFields(this.declaration.subject);
    const from = recordView(this.declaration, before) as Record<
      string,
      unknown
    >;
    const to = recordView(this.declaration, after) as Record<string, unknown>;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    // The fields and the columns add-ons added; not the engine's own.
    const names = Object.keys(to).filter(
      (name) =>
        !['id', 'ownerId', 'unitId', 'createdAt', 'updatedAt'].includes(name),
    );
    for (const name of names) {
      if (JSON.stringify(from[name]) === JSON.stringify(to[name])) continue;
      changes[name] = sensitive.includes(name)
        ? { from: '[redacted]', to: '[redacted]' }
        : { from: from[name] ?? null, to: to[name] ?? null };
    }
    return changes;
  }

  /** A unique field's value another live record has: a 409 `<item>_taken`, not a 500. */
  private taken(error: unknown): never {
    if (databaseErrorKind(error) === 'unique_violation') {
      throw new ConflictException({
        code: `${recordKey(this.declaration)}_taken`,
        message: `Another ${this.declaration.noun} has this value already.`,
      });
    }
    throw error;
  }
}
