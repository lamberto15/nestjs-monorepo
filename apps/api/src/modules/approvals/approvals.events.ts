import { WorkflowSignal } from '@nestjs/workflows';
import { z } from 'zod';
import { defineEvent } from '../../core/outbox/events.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { defineSystemJob } from '../../iam/access/permissions.js';
import { defineNotifications } from '../notifications/notifications.types.js';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

/** The workflows' steps act as `system:approvals`: the actor of what they record, and of the effects. */
export const APPROVALS_JOB = defineSystemJob({
  key: 'approvals',
  permissions: [],
});

/** One workflow instance per request. */
export const approvalWorkflowId = (requestId: string) =>
  `approval-${requestId}`;

/** A stage has its outcome (sent in the deciding transaction). Key: `<request>:<round>:<stage>`. */
export const stageDecided = new WorkflowSignal<
  {
    /** `failed`: the stage can't be decided any more (too few approvers left). */
    outcome: 'approved' | 'rejected' | 'changes_requested' | 'failed';
  } & TenantEnvelope
>('approval.stage-decided');

/** The request was cancelled (or its record purged). Key: the request id. */
export const requestCancelled = new WorkflowSignal<
  { by: string } & TenantEnvelope
>('approval.cancelled');

/** The requester resubmitted after changes were requested. Key: `<request>:<round before>`. */
export const requestResubmitted = new WorkflowSignal<
  { round: number } & TenantEnvelope
>('approval.resubmitted');

/**
 * What a request's changes tell other modules (core/outbox, after the
 * commit): webhooks and automations subscribe here.
 */
export interface ApprovalEventPayload {
  requestId: string;
  subject: string;
  recordId: string;
  action: string;
  status: string;
  /** The API client that asked, when one did: the only one its webhook reaches. */
  clientId?: string;
}

/** What an approval webhook's `data` carries (the payload without who it is for). */
export const approvalWebhookData = z.object({
  requestId: z.uuid(),
  subject: z.string(),
  recordId: z.string(),
  action: z.string(),
  status: z.string(),
});
export const APPROVAL_EVENTS = {
  requested: defineEvent<ApprovalEventPayload>('approval.requested'),
  approved: defineEvent<ApprovalEventPayload>('approval.approved'),
  rejected: defineEvent<ApprovalEventPayload>('approval.rejected'),
  changes_requested: defineEvent<ApprovalEventPayload>(
    'approval.changes-requested',
  ),
  cancelled: defineEvent<ApprovalEventPayload>('approval.cancelled'),
  expired: defineEvent<ApprovalEventPayload>('approval.expired'),
  failed: defineEvent<ApprovalEventPayload>('approval.failed'),
};

/** Live events, after the commit. */
export const APPROVAL_REALTIME = {
  /** To an approver (and their delegates): a request waits for them. */
  assigned: defineRealtimeEvent(
    'approval.assigned',
    z.object({
      id: z.uuid(),
      subject: z.string(),
      recordId: z.string(),
      action: z.string(),
      stage: z.number().int(),
    }),
    'An approval request waits for you (or for someone you stand in for): GET /v1/approvals/{id}.',
  ),
  /** To the requester and the stage's approvers: a decision, or the request ended or moved on. */
  decided: defineRealtimeEvent(
    'approval.decided',
    z.object({
      id: z.uuid(),
      status: z.string(),
      round: z.number().int(),
      stage: z.number().int(),
      decision: z.string().nullable(),
    }),
    "A decision on a request you made or decide, or its end: status is the request's after it; decision is null when no person decided (cancelled, expired, failed).",
  ),
  /** To the requester and the round's approvers: the approved outcome was applied. */
  applied: defineRealtimeEvent(
    'approval.applied',
    z.object({
      id: z.uuid(),
      subject: z.string(),
      recordId: z.string(),
      outcomeAppliedAt: z.string(),
    }),
    "An approved request's outcome was applied: outcomeAppliedAt is now set on GET /v1/approvals/{id}.",
  ),
};

const requestData = z.object({
  requestId: z.uuid(),
  subject: z.string(),
  action: z.string(),
  title: z.string(),
});

/** What approvals tell people (texts: i18n/en.json, `notifications.approval`). */
export const APPROVAL_NOTIFICATIONS = defineNotifications([
  {
    // To each approver of a stage that starts (and their delegates).
    type: 'approval.requested',
    email: 'immediate',
    data: requestData.extend({ by: z.string(), stage: z.string() }),
  },
  {
    // To the approvers who haven't decided, when the stage's remindAfter passes.
    type: 'approval.reminder',
    email: 'immediate',
    data: requestData.extend({ by: z.string() }),
  },
  {
    // To the approvers an overdue stage added.
    type: 'approval.escalated',
    email: 'immediate',
    data: requestData.extend({ by: z.string() }),
  },
  {
    type: 'approval.approved',
    email: 'immediate',
    data: requestData.extend({ by: z.string() }),
  },
  {
    type: 'approval.rejected',
    email: 'immediate',
    data: requestData.extend({ by: z.string(), comment: z.string() }),
  },
  {
    type: 'approval.changesRequested',
    email: 'immediate',
    data: requestData.extend({ by: z.string(), comment: z.string() }),
  },
  { type: 'approval.expired', email: 'immediate', data: requestData },
  { type: 'approval.failed', email: 'immediate', data: requestData },
  {
    // To the approvers still waiting (and the requester, when someone else cancelled).
    type: 'approval.cancelled',
    email: false,
    data: requestData.extend({ by: z.string() }),
  },
]);
