import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { type AiRunStatus as RunStatus, aiRuns } from './ai.tables.js';

type NewRun = typeof aiRuns.$inferInsert;

/** The AI runs' queries, in the caller's transaction and tenant. */
@Injectable()
export class AiRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async insert(values: NewRun) {
    const [row] = await this.db.insert(aiRuns).values(values).returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(aiRuns).where(eq(aiRuns.id, id));
    return row;
  }

  /** The requester's run of a record and task in one of `statuses`. */
  async findOpen(
    run: Pick<NewRun, 'source' | 'recordId' | 'task' | 'requestedBy'>,
    statuses: readonly RunStatus[],
  ) {
    const [row] = await this.db
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.source, run.source),
          eq(aiRuns.recordId, run.recordId),
          eq(aiRuns.task, run.task),
          eq(aiRuns.requestedBy, run.requestedBy),
          inArray(aiRuns.status, [...statuses]),
        ),
      );
    return row;
  }

  /** Changes a run still in one of `statuses`; undefined when it no longer is. */
  async updateIn(
    id: string,
    statuses: readonly RunStatus[],
    values: Partial<NewRun>,
  ) {
    const [row] = await this.db
      .update(aiRuns)
      .set(values)
      .where(and(eq(aiRuns.id, id), inArray(aiRuns.status, [...statuses])))
      .returning();
    return row;
  }

  /** Deletes up to `limit` ended runs created before `before`; how many went. */
  async deleteEnded(before: Date, limit: number) {
    const rows = await this.db
      .delete(aiRuns)
      .where(
        inArray(
          aiRuns.id,
          this.db
            .select({ id: aiRuns.id })
            .from(aiRuns)
            .where(
              and(
                inArray(aiRuns.status, ['completed', 'failed']),
                lt(aiRuns.createdAt, before),
              ),
            )
            .limit(limit),
        ),
      )
      .returning({ id: aiRuns.id });
    return rows.length;
  }

  /** A page of the requester's runs, newest first, before `cursor`. */
  async ofRequester(
    requestedBy: string,
    cursor: string | undefined,
    limit: number,
  ) {
    return this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.requestedBy, requestedBy),
          cursor ? lt(aiRuns.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(aiRuns.id))
      .limit(limit);
  }

  async renameRequester(from: string, to: string) {
    await this.db
      .update(aiRuns)
      .set({ requestedBy: to })
      .where(eq(aiRuns.requestedBy, from));
  }
}
