import {
  InjectTransaction,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  getColumns,
  inArray,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { databaseErrorKind } from '../../core/database/database-errors.js';
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
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { TAG_LIST } from './tags.list.js';
import type { CreateTagDto, TagRef, UpdateTagDto } from './tags.schemas.js';
import { TagsRegistry } from './tags.registry.js';
import { recordTags, tags } from './tags.tables.js';

type Tag = typeof tags.$inferSelect;

const view = (tag: Tag, usageCount: number) => ({
  ...tag,
  usageCount,
  createdAt: tag.createdAt.toISOString(),
  updatedAt: tag.updatedAt.toISOString(),
});

const ref = ({ id, name, color }: Pick<Tag, 'id' | 'name' | 'color'>) => ({
  id,
  name,
  color,
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/**
 * Tags (labels) on the records that opted in (`TagsModule.forRecord()`).
 * Administrators (`Access.manageTags`) define them per subject; a record's
 * tags are set with `setTags`, shown with `tagsOf` (one query per page).
 * Each write is one transaction with its audit entry.
 */
@Injectable()
export class TagsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly registry: TagsRegistry,
    private readonly records: Records,
    private readonly audit: AuditService,
  ) {}

  /** A page of tags, newest first unless the query sorts. */
  async list(query: ListQuery) {
    const where = TAG_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({ ...getColumns(tags), ...TAG_LIST.sortSelect(query) })
        .from(tags)
        .where(and(where, afterCursor(tags.id, query)))
        .orderBy(...pageOrder(tags.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, tags, where, query),
    ]);
    const page = toPage(rows, query, total);
    // How many records carry each tag: one grouped query per page.
    const usage = await this.usageOf(page.items.map((row) => row.id));
    return {
      ...page,
      items: page.items.map((row) => view(row, usage.get(row.id) ?? 0)),
    };
  }

  /** Records carrying each tag, one query for all `ids`. */
  private async usageOf(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ tagId: recordTags.tagId, count: count() })
      .from(recordTags)
      .where(inArray(recordTags.tagId, ids))
      .groupBy(recordTags.tagId);
    return new Map(rows.map((row) => [row.tagId, row.count]));
  }

  private async findOne(id: string): Promise<Tag> {
    const [tag] = await this.db.select().from(tags).where(eq(tags.id, id));
    if (!tag) throw new NotFoundException(`Tag ${id} not found.`);
    return tag;
  }

  /** A new tag of a subject that takes tags; a 409 when its name is taken (whatever the case). */
  async create(principal: Principal, dto: CreateTagDto, ip?: string) {
    if (!this.registry.has(dto.subject)) {
      throw invalid([
        {
          path: 'subject',
          message: `"${dto.subject}" takes no tags: one of ${this.registry.subjects().join(', ')}`,
        },
      ]);
    }
    const row = await this.txHost
      .withTransaction(async () => {
        const [created] = await this.db
          .insert(tags)
          .values({
            subject: dto.subject,
            name: dto.name,
            color: dto.color ?? null,
            description: dto.description || null,
          })
          .returning();
        await this.audit.record(principal, {
          action: 'tag.created',
          targetType: 'tag',
          targetId: created!.id,
          details: { subject: dto.subject, name: dto.name },
          ip,
        });
        return created!;
      })
      .catch((error: unknown) => {
        throw this.conflict(error, dto.subject, dto.name);
      });
    return view(row, 0);
  }

  /** Renames, recolours or redescribes a tag: only what is sent changes. */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateTagDto,
    ip?: string,
  ) {
    const tag = await this.findOne(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateTagDto;
    if (values.description === '') values.description = null;
    if (Object.keys(values).length === 0) {
      return view(tag, (await this.usageOf([id])).get(id) ?? 0);
    }
    const row = await this.txHost
      .withTransaction(async () => {
        const [updated] = await this.db
          .update(tags)
          .set(values)
          .where(eq(tags.id, id))
          .returning();
        await this.audit.record(principal, {
          action: 'tag.updated',
          targetType: 'tag',
          targetId: id,
          details: {
            changes: Object.fromEntries(
              Object.entries(values).map(([key, to]) => [
                key,
                { from: tag[key as keyof Tag] ?? null, to },
              ]),
            ),
          },
          ip,
        });
        return updated!;
      })
      .catch((error: unknown) => {
        throw this.conflict(error, tag.subject, values.name ?? tag.name);
      });
    return view(row, (await this.usageOf([id])).get(id) ?? 0);
  }

  /** Deletes a tag: every record loses it (the links cascade). */
  @Transactional()
  async remove(principal: Principal, id: string, ip?: string) {
    const tag = await this.findOne(id);
    await this.db.delete(tags).where(eq(tags.id, id));
    await this.audit.record(principal, {
      action: 'tag.deleted',
      targetType: 'tag',
      targetId: id,
      details: { subject: tag.subject, name: tag.name },
      ip,
    });
  }

  /**
   * Replaces a record's tags with `tagIds`, in one transaction with one
   * audit entry (`tags.changed`, from and to): a 400 naming each id that is
   * not a tag of the record's subject. The caller has checked the record is
   * theirs to change. Returns the record's tags.
   */
  @Transactional()
  async setTags(
    principal: Principal,
    subject: string,
    recordId: string,
    tagIds: readonly string[],
    ip?: string,
  ): Promise<TagRef[]> {
    const wanted = [...new Set(tagIds)];
    // One change of a record's set at a time: two at once would merge their
    // sets and each audit a `to` that isn't. The record's row is the lock.
    const table = this.records.of(subject).feature.table;
    await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(eq(table.id, recordId))
      .for('update');
    // Shared locks: a tag deleted meanwhile would fail the insert (a 500, not the 400).
    const found = wanted.length
      ? await this.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.subject, subject), inArray(tags.id, wanted)))
          .for('share')
      : [];
    const known = new Set(found.map((row) => row.id));
    const unknown = tagIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !known.has(id));
    if (unknown.length) {
      throw invalid(
        unknown.map(({ id, index }) => ({
          path: `tagIds.${index}`,
          message: `No ${subject} tag ${id}`,
        })),
      );
    }
    const mine = and(
      eq(recordTags.subject, subject),
      eq(recordTags.recordId, recordId),
    );
    const before = (
      await this.db
        .select({ tagId: recordTags.tagId })
        .from(recordTags)
        .where(mine)
    ).map((row) => row.tagId);
    const added = wanted.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !wanted.includes(id));
    if (removed.length) {
      await this.db
        .delete(recordTags)
        .where(
          and(
            mine,
            wanted.length ? notInArray(recordTags.tagId, wanted) : undefined,
          ),
        );
    }
    if (added.length) {
      await this.db
        .insert(recordTags)
        .values(added.map((tagId) => ({ subject, recordId, tagId })))
        .onConflictDoNothing();
    }
    if (added.length || removed.length) {
      await this.audit.record(principal, {
        action: 'tags.changed',
        targetType: subject.charAt(0).toLowerCase() + subject.slice(1),
        targetId: recordId,
        details: { subject, from: before, to: wanted, added, removed },
        ip,
      });
    }
    return (await this.tagsOf(subject, [recordId])).get(recordId)!;
  }

  /**
   * The tags of records of a subject, by record id (every id given has an
   * entry, [] when untagged), by name: one query for a whole page.
   */
  async tagsOf(
    subject: string,
    recordIds: readonly string[],
  ): Promise<Map<string, TagRef[]>> {
    const result = new Map<string, TagRef[]>(
      recordIds.map((id) => [id, []] as [string, TagRef[]]),
    );
    if (recordIds.length) {
      const rows = await this.db
        .select({
          recordId: recordTags.recordId,
          id: tags.id,
          name: tags.name,
          color: tags.color,
        })
        .from(recordTags)
        .innerJoin(tags, eq(tags.id, recordTags.tagId))
        .where(
          and(
            eq(recordTags.subject, subject),
            inArray(recordTags.recordId, [...new Set(recordIds)]),
          ),
        )
        .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id));
      for (const row of rows) result.get(row.recordId)?.push(ref(row));
    }
    return result;
  }

  /** The ids of the records of `subject` carrying any of `tagIds`: a subquery, for a list filter. */
  idsTagged(subject: string, tagIds: string[]) {
    return this.db
      .select({ id: recordTags.recordId })
      .from(recordTags)
      .where(
        and(eq(recordTags.subject, subject), inArray(recordTags.tagId, tagIds)),
      );
  }

  /** Records deleted for good take their tags with them. */
  /** A merge: the survivor gains the duplicate's tags (keeping its own). */
  async merge(subject: string, from: string, to: string) {
    const moved = await this.db
      .delete(recordTags)
      .where(
        and(eq(recordTags.subject, subject), eq(recordTags.recordId, from)),
      )
      .returning();
    if (moved.length > 0) {
      await this.db
        .insert(recordTags)
        .values(moved.map((tag) => ({ ...tag, recordId: to })))
        .onConflictDoNothing();
    }
  }

  async forget(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recordTags)
      .where(
        and(
          eq(recordTags.subject, subject),
          inArray(recordTags.recordId, [...recordIds]),
        ),
      );
  }

  private conflict(error: unknown, subject: string, name: string) {
    return databaseErrorKind(error) === 'unique_violation'
      ? new ConflictException({
          code: 'tag_taken',
          message: `A ${subject} tag named "${name}" exists already.`,
        })
      : error;
  }
}
