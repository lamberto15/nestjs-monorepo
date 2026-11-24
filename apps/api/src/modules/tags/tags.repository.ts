import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
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
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import type { RecordRegistration } from '../records/records.service.js';
import { TAG_LIST } from './tags.list.js';
import { recordTags, tags } from './tags.tables.js';

type Tag = typeof tags.$inferSelect;

/**
 * The tags' queries: the tags and the records' links to them, in the
 * caller's tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class TagsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of tags, and the total when asked. */
  page(query: ListQuery) {
    const where = TAG_LIST.where(query);
    return Promise.all([
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
  }

  /** How many records carry each tag. */
  usageOf(ids: string[]) {
    return this.db
      .select({ tagId: recordTags.tagId, count: count() })
      .from(recordTags)
      .where(inArray(recordTags.tagId, ids))
      .groupBy(recordTags.tagId);
  }

  async findById(id: string) {
    const [tag] = await this.db.select().from(tags).where(eq(tags.id, id));
    return tag;
  }

  /** A tag of the subject: its id and name. */
  async findOfSubject(subject: string, id: string) {
    const [tag] = await this.db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.subject, subject), eq(tags.id, id)));
    return tag;
  }

  async insert(values: typeof tags.$inferInsert) {
    const [created] = await this.db.insert(tags).values(values).returning();
    return created!;
  }

  async update(id: string, values: Partial<Tag>) {
    const [updated] = await this.db
      .update(tags)
      .set(values)
      .where(eq(tags.id, id))
      .returning();
    return updated!;
  }

  async delete(id: string) {
    await this.db.delete(tags).where(eq(tags.id, id));
  }

  /** Locks a record's row until the commit. */
  async lockRecord(record: RecordRegistration, recordId: string) {
    const table = record.feature.table;
    await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(eq(table.id, recordId))
      .for('update');
  }

  /** The ids among `ids` that are tags of the subject, share-locked until the commit. */
  async lockTags(subject: string, ids: string[]) {
    const rows = await this.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.subject, subject), inArray(tags.id, ids)))
      .for('share');
    return rows.map((row) => row.id);
  }

  /** The ids of a record's tags. */
  async tagIdsOf(subject: string, recordId: string) {
    const rows = await this.db
      .select({ tagId: recordTags.tagId })
      .from(recordTags)
      .where(this.ofRecord(subject, recordId));
    return rows.map((row) => row.tagId);
  }

  /** Removes a record's tags but `keep`. */
  async unlinkExcept(subject: string, recordId: string, keep: string[]) {
    await this.db
      .delete(recordTags)
      .where(
        and(
          this.ofRecord(subject, recordId),
          keep.length ? notInArray(recordTags.tagId, keep) : undefined,
        ),
      );
  }

  async link(subject: string, recordId: string, tagIds: string[]) {
    await this.db
      .insert(recordTags)
      .values(tagIds.map((tagId) => ({ subject, recordId, tagId })))
      .onConflictDoNothing();
  }

  /** The tags of these records, by lower-cased name. */
  tagsOf(subject: string, recordIds: string[]) {
    return this.db
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
          inArray(recordTags.recordId, recordIds),
        ),
      )
      .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id));
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

  /** Moves a record's tags to another, keeping the ones it has. */
  async moveLinks(subject: string, from: string, to: string) {
    const moved = await this.db
      .delete(recordTags)
      .where(this.ofRecord(subject, from))
      .returning();
    if (moved.length > 0) {
      await this.db
        .insert(recordTags)
        .values(moved.map((tag) => ({ ...tag, recordId: to })))
        .onConflictDoNothing();
    }
  }

  async unlinkRecords(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(recordTags)
      .where(
        and(
          eq(recordTags.subject, subject),
          inArray(recordTags.recordId, [...recordIds]),
        ),
      );
  }

  private ofRecord(subject: string, recordId: string) {
    return and(
      eq(recordTags.subject, subject),
      eq(recordTags.recordId, recordId),
    );
  }
}
