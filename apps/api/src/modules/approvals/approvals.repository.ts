import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getColumns,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
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
  toPage,
} from '../../core/http/pagination.js';
import { apiClients, users } from '../../iam/auth/auth.tables.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordTable } from '../records/record.js';
import { assignedTo, participates } from './approvals.list.js';
import {
  approvalAssignments,
  approvalEvents,
  approvalRequests,
  type ApprovalStatus,
  OPEN_STATUSES,
} from './approvals.tables.js';

type RequestValues = typeof approvalRequests.$inferInsert;
type AssignmentValues = typeof approvalAssignments.$inferInsert;
type EventValues = typeof approvalEvents.$inferInsert;

/**
 * The queries of approval requests, their assignments and their timeline.
 * The transaction is the caller's (`@InjectTransaction()`), and so is the
 * tenant it runs in.
 */
@Injectable()
export class ApprovalsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  // Requests

  /** The request, locked for the rest of the transaction. */
  async lock(id: string) {
    const [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .for('update');
    return row;
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    return row;
  }

  async policyOf(id: string) {
    const [row] = await this.db
      .select({ policy: approvalRequests.policy })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    return row?.policy;
  }

  async insert(values: RequestValues) {
    const [created] = await this.db
      .insert(approvalRequests)
      .values(values)
      .returning();
    return created!;
  }

  async update(id: string, values: Partial<RequestValues>) {
    const [updated] = await this.db
      .update(approvalRequests)
      .set(values)
      .where(eq(approvalRequests.id, id))
      .returning();
    return updated!;
  }

  /** Marks round `round`'s outcome applied, if it still has `status` and isn't marked yet. */
  async markApplied(id: string, round: number, status: ApprovalStatus) {
    const [applied] = await this.db
      .update(approvalRequests)
      .set({ outcomeAppliedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.id, id),
          eq(approvalRequests.round, round),
          isNull(approvalRequests.outcomeAppliedAt),
          eq(approvalRequests.status, status),
        ),
      )
      .returning();
    return applied;
  }

  /** The open requests of the record (of one action, or all). */
  open(subject: string, recordId: string, action?: string) {
    return this.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          action === undefined
            ? undefined
            : eq(approvalRequests.action, action),
          inArray(approvalRequests.status, [...OPEN_STATUSES]),
        ),
      );
  }

  /** A request of the record that waits for a decision, or was approved and isn't applied yet. */
  async blocking(subject: string, recordId: string) {
    const [open] = await this.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          or(
            eq(approvalRequests.status, 'pending'),
            and(
              eq(approvalRequests.status, 'approved'),
              isNull(approvalRequests.outcomeAppliedAt),
            ),
          ),
        ),
      );
    return open;
  }

  openOfRecords(subject: string, recordIds: readonly string[]) {
    return this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          inArray(approvalRequests.recordId, [...recordIds]),
          inArray(approvalRequests.status, [...OPEN_STATUSES]),
        ),
      );
  }

  async deleteOfRecords(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          inArray(approvalRequests.recordId, [...recordIds]),
        ),
      );
  }

  /**
   * What the principal may read: what they take part in, or what
   * `oversee` (their Approval.read filter) lets through; none: everything.
   */
  private readable(principal: Principal, oversee: SQL | undefined) {
    return oversee === undefined
      ? undefined
      : or(participates(principal), oversee);
  }

  /** The request, if the principal may read it. */
  async findReadable(
    principal: Principal,
    oversee: SQL | undefined,
    id: string,
  ) {
    const [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, id), this.readable(principal, oversee)),
      );
    return row;
  }

  /** A page of the requests the principal may read, by the list's filter. */
  async page(
    principal: Principal,
    oversee: SQL | undefined,
    where: SQL | undefined,
    query: ListQuery,
  ) {
    const filter = and(this.readable(principal, oversee), where);
    const [rows, total] = await Promise.all([
      this.db
        .select(getColumns(approvalRequests))
        .from(approvalRequests)
        .where(and(filter, afterCursor(approvalRequests.id, query)))
        .orderBy(...pageOrder(approvalRequests.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, approvalRequests, filter, query),
    ]);
    return toPage(rows, query, total);
  }

  /** The inbox's requests: waiting on the user now, or theirs sent back for changes. */
  inbox(
    userId: string,
    requester: string,
    page: { limit: number; after?: string },
  ) {
    const r = approvalRequests;
    return this.db
      .select()
      .from(r)
      .where(
        and(
          or(
            assignedTo(userId),
            and(eq(r.status, 'changes_requested'), eq(r.requester, requester)),
          ),
          page.after ? lt(r.id, page.after) : undefined,
        ),
      )
      .orderBy(desc(r.id))
      .limit(page.limit);
  }

  /** Requests whose outcome isn't applied yet: their workflow may still run. */
  unapplied() {
    return this.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(isNull(approvalRequests.outcomeAppliedAt));
  }

  /** How far the most overdue pending stage is past its deadline, in seconds (0: none). */
  async overdueSeconds() {
    const [overdue] = await this.db
      .select({
        seconds: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.dueAt})) filter (where ${approvalRequests.dueAt} < now()), 0)::float8`,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.status, 'pending'));
    return overdue?.seconds;
  }

  /** How long the oldest approved request has waited for its outcome, in seconds (0: none). */
  async unappliedSeconds() {
    const [unapplied] = await this.db
      .select({
        seconds: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.endedAt})), 0)::float8`,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, 'approved'),
          isNull(approvalRequests.outcomeAppliedAt),
        ),
      );
    return unapplied?.seconds;
  }

  requestsOf(requester: string) {
    return this.db
      .select({
        id: approvalRequests.id,
        subject: approvalRequests.subject,
        recordId: approvalRequests.recordId,
        action: approvalRequests.action,
        status: approvalRequests.status,
        title: approvalRequests.title,
        comment: approvalRequests.comment,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.requester, requester))
      .orderBy(asc(approvalRequests.id));
  }

  /** Replaces the requester's, the decider's and the actor's names copied onto the rows. */
  async renamePerson(key: string, userId: string, name: string) {
    await this.db
      .update(approvalRequests)
      .set({ requesterName: name })
      .where(eq(approvalRequests.requester, key));
    await this.db
      .update(approvalAssignments)
      .set({ decidedByName: name })
      .where(eq(approvalAssignments.decidedBy, userId));
    await this.db
      .update(approvalEvents)
      .set({ actorName: name })
      .where(eq(approvalEvents.actor, key));
  }

  /** Locks a record's row (a record table of another feature) for the transaction. */
  async lockRecord(table: RecordTable, id: string) {
    const [row] = await this.db
      .select({ id: table.id })
      .from(table as unknown as PgTable)
      .where(eq(table.id, id))
      .for('update');
    return row;
  }

  /** The requester's name as it is now: the user's or the API client's. */
  async requesterName(kind: 'user' | 'client', id: string) {
    const [row] =
      kind === 'user'
        ? await this.db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, id))
        : await this.db
            .select({ name: apiClients.name })
            .from(apiClients)
            .where(eq(apiClients.id, id));
    return row?.name;
  }

  // Assignments

  /** One row each; one already assigned is skipped. */
  assign(values: AssignmentValues[]) {
    if (!values.length) return Promise.resolve([]);
    return this.db
      .insert(approvalAssignments)
      .values(values)
      .onConflictDoNothing()
      .returning();
  }

  /** A stage's assignments of the round, in order. */
  stageAssignments(requestId: string, round: number, stage: number) {
    return this.db
      .select()
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, requestId),
          eq(approvalAssignments.round, round),
          eq(approvalAssignments.stage, stage),
        ),
      )
      .orderBy(asc(approvalAssignments.id));
  }

  /** Closes the request's pending assignments; answers whose they were. */
  closePending(requestId: string) {
    return this.db
      .update(approvalAssignments)
      .set({ status: 'closed' })
      .where(
        and(
          eq(approvalAssignments.requestId, requestId),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .returning({ approverId: approvalAssignments.approverId });
  }

  /** Closes a stage's pending assignments of anyone but `keep`. */
  async closePendingExcept(
    requestId: string,
    round: number,
    stage: number,
    keep: readonly string[],
  ) {
    await this.db
      .update(approvalAssignments)
      .set({ status: 'closed' })
      .where(
        and(
          eq(approvalAssignments.requestId, requestId),
          eq(approvalAssignments.round, round),
          eq(approvalAssignments.stage, stage),
          eq(approvalAssignments.status, 'pending'),
          notInArray(approvalAssignments.approverId, [...keep]),
        ),
      );
  }

  /** Closes one approver's pending assignment of a stage; answers what it closed. */
  closeApprover(
    requestId: string,
    round: number,
    stage: number,
    approverId: string,
  ) {
    return this.db
      .update(approvalAssignments)
      .set({ status: 'closed' })
      .where(
        and(
          eq(approvalAssignments.requestId, requestId),
          eq(approvalAssignments.round, round),
          eq(approvalAssignments.stage, stage),
          eq(approvalAssignments.approverId, approverId),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .returning({ id: approvalAssignments.id });
  }

  /** The requests where the user has a pending assignment, in id order. */
  pendingRequestsOf(approverId: string) {
    return this.db
      .selectDistinct({ requestId: approvalAssignments.requestId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.approverId, approverId),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .orderBy(approvalAssignments.requestId);
  }

  /** The round's assignments not closed out. */
  liveAssignments(requestId: string, round: number) {
    return this.db
      .select({ approverId: approvalAssignments.approverId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, requestId),
          eq(approvalAssignments.round, round),
          ne(approvalAssignments.status, 'closed'),
        ),
      );
  }

  /** The requests' assignments with their approver's name, in order. */
  assignmentsOf(requestIds: readonly string[]) {
    return this.db
      .select({ ...getColumns(approvalAssignments), approverName: users.name })
      .from(approvalAssignments)
      .leftJoin(users, eq(users.id, approvalAssignments.approverId))
      .where(inArray(approvalAssignments.requestId, [...requestIds]))
      .orderBy(asc(approvalAssignments.id));
  }

  /**
   * Records one person's decision on these assignments (those still
   * pending), `onBehalfOf` whoever each was assigned to when not them.
   */
  decide(
    ids: readonly string[],
    decision: 'approved' | 'rejected' | 'changes_requested',
    comment: string | null,
    by: { id: string; name: string },
  ) {
    return this.db
      .update(approvalAssignments)
      .set({
        status: decision,
        comment,
        decidedAt: new Date(),
        decidedBy: by.id,
        decidedByName: by.name,
        onBehalfOf: sql`case when ${approvalAssignments.approverId} = ${by.id} then null else ${approvalAssignments.approverId} end`,
      })
      .where(
        and(
          inArray(approvalAssignments.id, [...ids]),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .returning();
  }

  decisionsOf(userId: string) {
    return this.db
      .select({
        id: approvalAssignments.id,
        requestId: approvalAssignments.requestId,
        decision: approvalAssignments.status,
        comment: approvalAssignments.comment,
        onBehalfOf: approvalAssignments.onBehalfOf,
        decidedAt: approvalAssignments.decidedAt,
      })
      .from(approvalAssignments)
      .where(eq(approvalAssignments.decidedBy, userId))
      .orderBy(asc(approvalAssignments.id));
  }

  // Timeline

  async insertEvent(values: EventValues) {
    await this.db.insert(approvalEvents).values(values);
  }

  /** Whether the stage's timeline of the round has an event of this type. */
  async hasEvent(
    requestId: string,
    round: number,
    stage: number,
    type: string,
  ) {
    const [found] = await this.db
      .select({ id: approvalEvents.id })
      .from(approvalEvents)
      .where(
        and(
          eq(approvalEvents.requestId, requestId),
          eq(approvalEvents.round, round),
          eq(approvalEvents.stage, stage),
          eq(approvalEvents.type, type),
        ),
      )
      .limit(1);
    return !!found;
  }

  timelineOf(requestIds: readonly string[]) {
    return this.db
      .select()
      .from(approvalEvents)
      .where(inArray(approvalEvents.requestId, [...requestIds]))
      .orderBy(asc(approvalEvents.id));
  }
}
