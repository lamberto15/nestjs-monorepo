import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, eq, inArray, isNull, lt, not, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { BacklogScope } from './ops.schemas.js';
import { outboxDeadLetters, outboxMessages } from './outbox-store.view.js';

type OutboxColumns = Pick<
  typeof outboxMessages | typeof outboxDeadLetters,
  'topic' | 'headers' | 'createdAt'
>;

/** A message no relay holds: never leased, or its lease ran out. */
const notLeased = (now: number) =>
  or(isNull(outboxMessages.leaseUntil), lt(outboxMessages.leaseUntil, now))!;

/** The outbox rows of a scope. The tenant is in the message's headers. */
const inScope = (columns: OutboxColumns, scope: BacklogScope) =>
  and(
    scope.tenantId
      ? eq(sql`${columns.headers}->>'tenantId'`, scope.tenantId)
      : undefined,
    scope.topic ? eq(columns.topic, scope.topic) : undefined,
    scope.before ? lt(columns.createdAt, scope.before.getTime()) : undefined,
  );

/**
 * The outbox's queries for an operator's recovery. Outside any tenant
 * (`@InjectDrizzle()`): the outbox is global, and a scope narrows it to a
 * tenant by the messages' headers.
 */
@Injectable()
export class OpsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Pending messages (no live lease) or dead letters in scope, counted by topic. */
  countByTopic(
    table: 'messages' | 'deadLetters',
    scope: BacklogScope,
    now: number,
  ) {
    const from = table === 'messages' ? outboxMessages : outboxDeadLetters;
    return this.db
      .select({ topic: from.topic, count: count() })
      .from(from)
      .where(
        and(
          inScope(from, scope),
          table === 'messages' ? notLeased(now) : undefined,
        ),
      )
      .groupBy(from.topic);
  }

  /** Messages in scope a relay holds now (under a live lease). */
  async countLeased(scope: BacklogScope, now: number) {
    const [row] = await this.db
      .select({ count: count() })
      .from(outboxMessages)
      .where(and(inScope(outboxMessages, scope), not(notLeased(now))));
    return row?.count ?? 0;
  }

  /** Deletes up to `limit` pending messages in scope (none under a live lease): how many it chose. */
  async deletePending(scope: BacklogScope, now: number, limit: number) {
    const ids = (
      await this.db
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(and(inScope(outboxMessages, scope), notLeased(now)))
        .limit(limit)
    ).map((row) => row.id);
    if (ids.length > 0) {
      // Leased again between the statements: left alone.
      await this.db
        .delete(outboxMessages)
        .where(and(inArray(outboxMessages.id, ids), notLeased(now)));
    }
    return ids.length;
  }

  /** The ids of up to `limit` dead letters in scope, the oldest first. */
  async deadLetterIds(scope: BacklogScope, limit: number) {
    const rows = await this.db
      .select({ id: outboxDeadLetters.id })
      .from(outboxDeadLetters)
      .where(inScope(outboxDeadLetters, scope))
      .orderBy(outboxDeadLetters.createdAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }
}
