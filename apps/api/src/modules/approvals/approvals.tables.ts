import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import type { ApprovalPolicy } from './approval-policy.js';

/** Where a request stands. `pending` and `changes_requested` are open; the rest have ended. */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled',
  'expired',
  'failed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/** The statuses during which the record still waits on the request. */
export const OPEN_STATUSES = ['pending', 'changes_requested'] as const;

/** Where one approver stands in their stage. `closed`: the stage or the request ended without them. */
export type AssignmentStatus =
  'pending' | 'approved' | 'rejected' | 'changes_requested' | 'closed';

/**
 * One request for approval: "this action on this record", what it proposes
 * (`payload`, read from the record) and the policy it runs under, copied
 * when it was made, so a policy changed later never changes a running
 * request. `round` counts resubmissions; `currentStage` is the stage of
 * that round being decided.
 */
export const approvalRequests = tenantTable(
  'approval_requests',
  {
    id: uuidPk(),
    /** The record's permission subject: `Invoice`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The approvable action: `publish`. */
    action: text('action').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    /** `user:<id>` or `client:<id>`: never one of its approvers. */
    requester: text('requester').notNull(),
    requesterName: text('requester_name').notNull(),
    /** What the record is called, for the inbox and the notifications. */
    title: text('title').notNull(),
    /** The record in the web app, a path. */
    link: text('link'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    policy: jsonb('policy').$type<ApprovalPolicy>().notNull(),
    /** 0: the code's default; 1, 2…: the administrators' versions (approval_policies). */
    policyVersion: integer('policy_version').notNull(),
    round: integer('round').notNull().default(0),
    currentStage: integer('current_stage').notNull().default(0),
    /** When the current stage's approvers were assigned (null until the workflow started it). */
    stageStartedAt: at('stage_started_at'),
    /** Set once the current stage has an outcome, until the next stage starts. */
    stageOutcome: text('stage_outcome'),
    /** The current stage's deadline, when its policy has one. */
    dueAt: at('due_at'),
    /** The requester's note to the approvers. */
    comment: text('comment'),
    /** Why it ended without a person's decision: `overdue`, `no_approvers`, `record_changed`… */
    outcomeReason: text('outcome_reason'),
    endedAt: at('ended_at'),
    /** A hash of the record when it was asked for, compared before the outcome is applied. */
    fingerprint: text('fingerprint'),
    /** When the feature's effect of the outcome ran (a workflow step). */
    outcomeAppliedAt: at('outcome_applied_at'),
    ...timestamps(),
  },
  (t) => [
    index('approval_requests_record_idx').on(t.subject, t.recordId),
    index('approval_requests_requester_idx').on(t.requester),
    index('approval_requests_status_idx').on(t.status),
    // One open request per action on a record: a second one is a 409 approval_pending.
    uniqueIndex('approval_requests_open_idx')
      .on(t.tenantId, t.subject, t.recordId, t.action)
      .where(sql`status in ('pending', 'changes_requested')`),
  ],
  { referenced: true },
);

/**
 * Who decides a stage: resolved once, when the stage starts, so later role
 * changes don't change who decides it. One row per request, round, stage
 * and approver.
 */
export const approvalAssignments = tenantTable(
  'approval_assignments',
  {
    id: uuidPk(),
    requestId: uuid('request_id').notNull(),
    round: integer('round').notNull(),
    stage: integer('stage').notNull(),
    approverId: uuid('approver_id').notNull(),
    status: text('status')
      .$type<AssignmentStatus>()
      .notNull()
      .default('pending'),
    comment: text('comment'),
    decidedAt: at('decided_at'),
    /** Who decided: the approver, or their delegate (`onBehalfOf` is then the approver). */
    decidedBy: uuid('decided_by'),
    decidedByName: text('decided_by_name'),
    onBehalfOf: uuid('on_behalf_of'),
    /** Added when the stage was overdue (escalation). */
    escalated: boolean('escalated').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('approval_assignments_unique_idx').on(
      t.tenantId,
      t.requestId,
      t.round,
      t.stage,
      t.approverId,
    ),
    index('approval_assignments_approver_idx').on(t.approverId, t.status),
    index('approval_assignments_decided_by_idx').on(t.decidedBy),
    tenantReference(
      'approval_assignments_request_fk',
      [t.tenantId, t.requestId],
      [approvalRequests.tenantId, approvalRequests.id],
    ),
  ],
);

/**
 * Out of office: `fromUserId`'s pending approvals may be decided by
 * `toUserId` between `startsAt` and `endsAt`, of every subject or one.
 */
export const approvalDelegations = tenantTable(
  'approval_delegations',
  {
    id: uuidPk(),
    fromUserId: uuid('from_user_id').notNull(),
    toUserId: uuid('to_user_id').notNull(),
    startsAt: at('starts_at').notNull(),
    endsAt: at('ends_at').notNull(),
    /** Only requests of this subject; null: all of them. */
    subject: text('subject'),
    ...timestamps(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('approval_delegations_tenant_idx').on(t.tenantId),
    index('approval_delegations_from_idx').on(t.fromUserId),
    index('approval_delegations_to_idx').on(t.toUserId, t.endsAt),
  ],
);

/**
 * The administrators' versions of an action's policy, numbered per action:
 * the newest applies to new requests; `definition` null is back to the
 * code's default. Rows are never changed, so every version stays.
 */
export const approvalPolicies = tenantTable(
  'approval_policies',
  {
    id: uuidPk(),
    /** The action: `Invoice.publish`. */
    key: text('key').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<ApprovalPolicy>(),
    changedBy: text('changed_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('approval_policies_version_idx').on(
      t.tenantId,
      t.key,
      t.version,
    ),
  ],
);

/** What happened to a request, in order: its timeline. */
export const approvalEvents = tenantTable(
  'approval_events',
  {
    id: uuidPk(),
    requestId: uuid('request_id').notNull(),
    /** `requested`, `stage_started`, `decided`, `approved`… */
    type: text('type').notNull(),
    /** `user:<id>`, `client:<id>` or `system:approvals`. */
    actor: text('actor').notNull(),
    actorName: text('actor_name').notNull(),
    round: integer('round').notNull(),
    stage: integer('stage'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('approval_events_tenant_idx').on(t.tenantId),
    index('approval_events_request_idx').on(t.requestId),
    tenantReference(
      'approval_events_request_fk',
      [t.tenantId, t.requestId],
      [approvalRequests.tenantId, approvalRequests.id],
    ),
  ],
);

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type ApprovalAssignmentRow = typeof approvalAssignments.$inferSelect;
export type ApprovalDelegationRow = typeof approvalDelegations.$inferSelect;
