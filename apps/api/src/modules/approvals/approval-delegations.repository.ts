import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import { approvalDelegations } from './approvals.tables.js';

const d = approvalDelegations;

/** Subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

/**
 * The user (a column holding their id) is an active member of the current
 * tenant: who may decide, or stand in, here. Memberships are a global
 * table, so the tenant is named.
 */
const activeMember = (userId: AnyColumn) =>
  exists(
    subquery
      .select({ one: sql`1` })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, requireTenantId('An approver')),
          eq(memberships.active, true),
        ),
      ),
  );

/** Active now, for every subject or for `subject` (none: any). */
const activeNow = (subject?: string) =>
  and(
    lte(d.startsAt, sql`now()`),
    gt(d.endsAt, sql`now()`),
    subject === undefined
      ? undefined
      : or(isNull(d.subject), eq(d.subject, subject)),
  );

/**
 * The queries of delegations (out of office) and of the users they name.
 * The transaction and the tenant are the caller's.
 */
@Injectable()
export class ApprovalDelegationsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Given or received by the user, newest first. */
  listOf(userId: string, limit: number) {
    return this.db
      .select()
      .from(d)
      .where(or(eq(d.fromUserId, userId), eq(d.toUserId, userId)))
      .orderBy(desc(d.id))
      .limit(limit);
  }

  /** Given by the user, in order. */
  givenBy(userId: string) {
    return this.db
      .select()
      .from(d)
      .where(eq(d.fromUserId, userId))
      .orderBy(asc(d.id));
  }

  /** The user, when active and a member of this tenant (users are global). */
  async findActiveMember(userId: string) {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.active, true),
          activeMember(users.id),
        ),
      );
    return user;
  }

  async insert(values: typeof d.$inferInsert) {
    const [created] = await this.db.insert(d).values(values).returning();
    return created!;
  }

  /** Removes one the user gave; answers it, or none. */
  async deleteGiven(id: string, fromUserId: string) {
    const [removed] = await this.db
      .delete(d)
      .where(and(eq(d.id, id), eq(d.fromUserId, fromUserId)))
      .returning();
    return removed;
  }

  /** Every delegation the user gave or holds. */
  async deleteOf(userId: string) {
    await this.db
      .delete(d)
      .where(or(eq(d.fromUserId, userId), eq(d.toUserId, userId)));
  }

  /** The users' names, by id. */
  namesOf(ids: readonly string[]) {
    return this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...ids]));
  }

  /** Who stands in for these users now, active members, for requests of `subject`. */
  delegatesOf(userIds: readonly string[], subject: string) {
    return this.db
      .select({ from: d.fromUserId, to: d.toUserId })
      .from(d)
      .where(
        and(
          inArray(d.fromUserId, [...userIds]),
          activeNow(subject),
          activeMember(d.toUserId),
        ),
      );
  }

  /** Whom the user stands in for now, of every subject or of `subject`. */
  delegators(userId: string, subject?: string) {
    return this.db
      .select({ from: d.fromUserId, subject: d.subject })
      .from(d)
      .where(and(eq(d.toUserId, userId), activeNow(subject)));
  }
}
