import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  afterCursor,
  type PageQuery,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { type DocumentStatus, documents } from './documents.tables.js';

type NewDocument = typeof documents.$inferInsert;

/** The documents' queries, in the caller's transaction and tenant. */
@Injectable()
export class DocumentsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async insert(values: NewDocument) {
    const [row] = await this.db.insert(documents).values(values).returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id));
    return row;
  }

  /** The requester's document of a record and locale in one of `statuses`. */
  async findOpen(
    document: Pick<
      NewDocument,
      'source' | 'recordId' | 'requestedBy' | 'locale'
    >,
    statuses: readonly DocumentStatus[],
  ) {
    const [row] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.source, document.source),
          eq(documents.recordId, document.recordId),
          eq(documents.requestedBy, document.requestedBy),
          eq(documents.locale, document.locale),
          inArray(documents.status, [...statuses]),
        ),
      );
    return row;
  }

  /** A page of a record's documents (one row more than the limit). */
  async ofRecord(subject: string, recordId: string, query: PageQuery) {
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.subject, subject),
          eq(documents.recordId, recordId),
          afterCursor(documents.id, query),
        ),
      )
      .orderBy(...pageOrder(documents.id, query))
      .limit(query.limit + 1)
      .offset(pageOffset(query));
  }

  /**
   * Changes a document still in one of `statuses` (and held by `runToken`
   * when given); undefined when it no longer is.
   */
  async updateIn(
    id: string,
    statuses: readonly DocumentStatus[],
    values: Partial<NewDocument>,
    runToken?: string,
  ) {
    const [row] = await this.db
      .update(documents)
      .set(values)
      .where(
        and(
          eq(documents.id, id),
          inArray(documents.status, [...statuses]),
          runToken ? eq(documents.runToken, runToken) : undefined,
        ),
      )
      .returning();
    return row;
  }

  /** Deletes the records' documents, and returns their files' keys. */
  async deleteOfRecords(subject: string, ids: readonly string[]) {
    const gone = await this.db
      .delete(documents)
      .where(
        and(
          eq(documents.subject, subject),
          inArray(documents.recordId, [...ids]),
        ),
      )
      .returning({ fileKey: documents.fileKey });
    return gone.flatMap((row) => (row.fileKey ? [row.fileKey] : []));
  }

  /** A page of the requester's documents, newest first, before `cursor`. */
  async ofRequester(
    requestedBy: string,
    cursor: string | undefined,
    limit: number,
  ) {
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.requestedBy, requestedBy),
          cursor ? lt(documents.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(documents.id))
      .limit(limit);
  }

  async renameRequester(from: string, to: string) {
    await this.db
      .update(documents)
      .set({ requestedBy: to })
      .where(eq(documents.requestedBy, from));
  }
}
