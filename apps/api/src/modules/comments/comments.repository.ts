import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { users } from '../../iam/auth/auth.tables.js';
import { COMMENT_LIST } from './comments.lists.js';
import { comments } from './comments.tables.js';

type NewComment = typeof comments.$inferInsert;

const ofRecord = (subject: string, recordId: string) =>
  and(eq(comments.subject, subject), eq(comments.recordId, recordId));

/** Oldest first unless sorted; a plain cursor is the last id seen. */
const orderOf = (query: ListQuery) =>
  query.sort?.length ? pageOrder(comments.id, query) : [asc(comments.id)];

const afterOf = (query: ListQuery) =>
  !query.cursor || query.sort?.length
    ? afterCursor(comments.id, query)
    : gt(comments.id, query.cursor);

/** The comments' queries, in the caller's transaction and tenant. */
@Injectable()
export class CommentsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of a record's comments (one row more than the limit), and the total. */
  async list(subject: string, recordId: string, query: ListQuery) {
    const where = and(ofRecord(subject, recordId), COMMENT_LIST.where(query));
    return Promise.all([
      this.db
        .select()
        .from(comments)
        .where(and(where, afterOf(query)))
        .orderBy(...orderOf(query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, comments, where, query),
    ]);
  }

  async findOne(subject: string, recordId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(comments)
      .where(and(ofRecord(subject, recordId), eq(comments.id, id)));
    return row;
  }

  async countReplies(parentId: string) {
    const [counted] = await this.db
      .select({ replies: count() })
      .from(comments)
      .where(eq(comments.parentId, parentId));
    return counted?.replies ?? 0;
  }

  /** Whether the author commented on the record before. */
  async hasCommented(subject: string, recordId: string, author: string) {
    const [earlier] = await this.db
      .select({ id: comments.id })
      .from(comments)
      .where(and(ofRecord(subject, recordId), eq(comments.author, author)))
      .limit(1);
    return !!earlier;
  }

  async insert(values: NewComment) {
    const [row] = await this.db.insert(comments).values(values).returning();
    return row!;
  }

  async update(id: string, values: Partial<NewComment>) {
    const [row] = await this.db
      .update(comments)
      .set(values)
      .where(eq(comments.id, id))
      .returning();
    return row!;
  }

  async delete(id: string) {
    await this.db.delete(comments).where(eq(comments.id, id));
  }

  /** A merge: the duplicate's comments move to the survivor. */
  async moveRecord(subject: string, from: string, to: string) {
    await this.db
      .update(comments)
      .set({ recordId: to })
      .where(ofRecord(subject, from));
  }

  async deleteOfRecords(subject: string, ids: readonly string[]) {
    await this.db
      .delete(comments)
      .where(
        and(
          eq(comments.subject, subject),
          inArray(comments.recordId, [...ids]),
        ),
      );
  }

  /** A page of the author's comments, newest first, before `cursor`. */
  async ofAuthor(author: string, cursor: string | undefined, limit: number) {
    return this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.author, author),
          cursor ? lt(comments.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(comments.id))
      .limit(limit);
  }

  /** The author's comments lose their text, author and mentions. */
  async blankOfAuthor(author: string, body: string, anonymous: string) {
    await this.db
      .update(comments)
      .set({ body, author: anonymous, mentions: [] })
      .where(eq(comments.author, author));
  }

  async renameResolver(from: string, to: string) {
    await this.db
      .update(comments)
      .set({ resolvedBy: to })
      .where(eq(comments.resolvedBy, from));
  }

  async emailOf(userId: string) {
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return account?.email;
  }

  /**
   * Drops the person from every comment that names them: the mention key,
   * and the text matching `pattern` (a scan, but the job is nightly).
   */
  async dropMentions(key: string, pattern: string) {
    await this.db
      .update(comments)
      .set({
        body: sql`regexp_replace(${comments.body}, ${pattern}, '@[deleted]', 'gi')`,
        mentions: sql`array_remove(${comments.mentions}, ${key})`,
      })
      .where(
        or(
          arrayContains(comments.mentions, [key]),
          sql`${comments.body} ~* ${pattern}`,
        ),
      );
  }
}
