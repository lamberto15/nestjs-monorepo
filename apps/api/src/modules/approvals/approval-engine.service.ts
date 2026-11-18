import {
  InjectTransaction,
  Propagation,
  TransactionHost,
} from '@nestjs-cls/transactional';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { WorkflowClient } from '@nestjs/workflows';
import { createHash } from 'node:crypto';
import { and, eq, isNull, ne, notInArray, or } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { recordView } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { stageOutcome } from './approval-modes.js';
import {
  type ApprovalPolicy,
  type ApproverRule,
  millis,
} from './approval-policy.js';
import {
  APPROVAL_EVENTS,
  APPROVAL_REALTIME,
  APPROVALS_JOB,
  stageDecided,
} from './approvals.events.js';
import { ApprovalsRegistry } from './approvals.registry.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  type ApprovalRequestRow,
  approvalRequests,
  type ApprovalStatus,
} from './approvals.tables.js';
import { Approvers, requesterOf, type RuleContext } from './approvers.js';

export type Ending = Exclude<ApprovalStatus, 'pending'>;

/** Who did something to a request. */
export interface ApprovalActor {
  key: string;
  name: string;
}

export const actorOf = (principal: Principal): ApprovalActor => ({
  key: principalKey(principal),
  name: principal.name,
});

/** What an ended (or sent back) request tells the requester. */
const NOTIFY: Partial<Record<Ending, string>> = {
  approved: 'approval.approved',
  rejected: 'approval.rejected',
  changes_requested: 'approval.changesRequested',
  expired: 'approval.expired',
  failed: 'approval.failed',
};

/** Realtime pushes of a transaction: sent once it committed. */
export class AfterCommit {
  readonly pushes: (() => void)[] = [];
}

/** The request as the workflow plans it: its stages' timers, in milliseconds. */
export interface ApprovalPlan {
  stages: {
    remindAfterMs: number | null;
    dueAfterMs: number | null;
    escalationDueAfterMs: number | null;
  }[];
  resubmitWithinMs: number;
}

/** A record's title for the inbox: its `title` or `name`, else its noun and id. */
export const titleOf = (noun: string, row: Record<string, unknown>) => {
  const named = [row.title, row.name].find((v) => typeof v === 'string' && v);
  return ((named as string | undefined) ?? `${noun} ${String(row.id)}`).slice(
    0,
    200,
  );
};

/**
 * What changes a request's state, in one place: a stage starting (its
 * approvers resolved and assigned), reminders, escalations, expiries, the
 * end of a request with what it tells (notifications, realtime, the
 * timeline, the audit log, the domain events), each in the transaction of
 * the change; and the outcome's effect. The workflow's steps call it, and
 * so does ApprovalsService for people's decisions.
 */
@Injectable()
export class ApprovalEngine {
  private readonly logger = new Logger('Approvals');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    readonly registry: ApprovalsRegistry,
    readonly approvers: Approvers,
    private readonly notifications: NotificationsService,
    private readonly realtime: Realtime,
    private readonly audit: AuditService,
    private readonly events: Events,
    private readonly workflows: WorkflowClient,
    private readonly system: SystemContext,
    private readonly records: Records,
    private readonly i18n: I18nService,
  ) {}

  /** An error with its `code` and its text from the catalog (`approvals.errors.<key>`). */
  problem(
    status: HttpStatus,
    code: string,
    key: string,
    extra: Record<string, unknown> = {},
  ) {
    return new HttpException(
      { code, message: this.text(key, extra), ...extra },
      status,
    );
  }

  /** A text of the catalog: `approvals.errors.<key>`. */
  text(key: string, args: Record<string, unknown> = {}): string {
    return this.i18n.translate(`approvals.errors.${key}`, { args });
  }

  /**
   * Who acts when no person does: `system:approvals` in the workflow's
   * steps. Never a fallback for a request: a request passes its principal.
   */
  private systemPrincipal(): SystemPrincipal {
    const current = this.system.current();
    if (!current) {
      throw new Error(
        `Approvals: no system job is running and no principal was passed: a request acts as its own principal, never as system:${APPROVALS_JOB.key}.`,
      );
    }
    return current;
  }

  private actorFor(by: Principal | null) {
    return actorOf(by ?? this.systemPrincipal());
  }

  /** Runs a change in a transaction, then sends what it pushes. */
  async run<T>(work: (after: AfterCommit) => Promise<T>) {
    const after = new AfterCommit();
    const result = await this.txHost.withTransaction(() => work(after));
    for (const push of after.pushes) push();
    return result;
  }

  /** The current transaction, for the workflow client's writes that must commit with it. */
  get tx() {
    return this.txHost.tx;
  }

  /** The request, locked for the rest of the transaction: its changes take turns. */
  async lock(id: string) {
    const [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .for('update');
    return row;
  }

  /** The record as stored, or null when it is gone. */
  async recordOf(subject: string, id: string) {
    return this.records
      .of(subject)
      .store.findOne(id)
      .catch((error: unknown) => {
        if (error instanceof NotFoundException) return null;
        throw error;
      });
  }

  /** A hash of the record as the API shows it: a change behind the approvers isn't applied. */
  async fingerprint(subject: string, id: string) {
    const row = await this.recordOf(subject, id);
    if (!row) return null;
    const { declaration } = this.records.of(subject);
    return createHash('sha256')
      .update(JSON.stringify(recordView(declaration, row)))
      .digest('base64url');
  }

  /** What the rules see of a request; the record is loaded once, when asked for. */
  context(row: {
    subject: string;
    recordId: string;
    requester: string;
  }): RuleContext {
    let record: Promise<Record<string, unknown> | null> | undefined;
    return {
      subject: row.subject,
      requester: requesterOf(row.requester),
      record: () => (record ??= this.recordOf(row.subject, row.recordId)),
    };
  }

  /** A line of the request's timeline. */
  async event(
    row: ApprovalRequestRow,
    type: string,
    actor: ApprovalActor,
    details?: Record<string, unknown>,
    stage?: number,
  ) {
    await this.db.insert(approvalEvents).values({
      requestId: row.id,
      type,
      actor: actor.key,
      actorName: actor.name,
      round: row.round,
      stage: stage ?? null,
      details: details ?? null,
    });
  }

  /** The audit entry of a change: the person's, or (null) the system job's. */
  async record(
    by: Principal | null,
    action: string,
    row: ApprovalRequestRow,
    details: Record<string, unknown> = {},
    ip?: string,
  ) {
    await this.audit.record(by ?? this.systemPrincipal(), {
      action,
      targetType: 'approval',
      targetId: row.id,
      details: {
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        ...details,
      },
      ip,
    });
  }

  /** The domain event of a request's change, in its transaction. */
  async publish(
    event: (typeof APPROVAL_EVENTS)[keyof typeof APPROVAL_EVENTS],
    row: ApprovalRequestRow,
  ) {
    await this.events.publish(
      event,
      {
        requestId: row.id,
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        status: row.status,
        ...(row.requester.startsWith('client:') && {
          clientId: row.requester.slice('client:'.length),
        }),
      },
      { key: row.id },
    );
  }

  private data(row: ApprovalRequestRow) {
    return {
      requestId: row.id,
      subject: row.subject,
      action: row.action,
      title: row.title,
    };
  }

  private push(
    after: AfterCommit,
    to: readonly { kind: 'user' | 'client'; id: string }[],
    send: (to: readonly { kind: 'user' | 'client'; id: string }[]) => void,
  ) {
    if (to.length) after.pushes.push(() => send(to));
  }

  /**
   * Assigns users to a stage (one row each; one already assigned is
   * skipped) and tells them, and whoever stands in for them.
   */
  async assign(
    after: AfterCommit,
    row: ApprovalRequestRow,
    stage: number,
    userIds: readonly string[],
    { escalated, type }: { escalated: boolean; type: string },
  ) {
    const created = userIds.length
      ? await this.db
          .insert(approvalAssignments)
          .values(
            userIds.map((approverId) => ({
              requestId: row.id,
              round: row.round,
              stage,
              approverId,
              escalated,
            })),
          )
          .onConflictDoNothing()
          .returning()
      : [];
    const assigned = created.map((assignment) => assignment.approverId);
    const delegates = await this.approvers.delegatesOf(assigned, row.subject);
    const recipients = [
      ...new Set([...assigned, ...[...delegates.values()].flat()]),
    ];
    if (recipients.length) {
      await this.notifications.notify({
        type,
        to: recipients.map((id) => `user:${id}`),
        data: {
          ...this.data(row),
          by: row.requesterName,
          ...(type === 'approval.requested' && {
            stage: row.policy.stages[stage]!.name,
          }),
        },
        link: `/approvals/${row.id}`,
      });
    }
    this.push(
      after,
      recipients.map((id) => ({ kind: 'user' as const, id })),
      (to) =>
        this.realtime.toPrincipals(to, APPROVAL_REALTIME.assigned, {
          id: row.id,
          subject: row.subject,
          recordId: row.recordId,
          action: row.action,
          stage,
        }),
    );
    return created;
  }

  /** The request's stage plan (a workflow step: replays get the same). */
  async plan(requestId: string): Promise<ApprovalPlan | null> {
    const [row] = await this.db
      .select({ policy: approvalRequests.policy })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    if (!row) return null;
    const ms = (duration?: string) => (duration ? millis(duration) : null);
    return {
      stages: row.policy.stages.map((stage) => ({
        remindAfterMs: ms(stage.remindAfter),
        dueAfterMs: ms(stage.dueAfter),
        escalationDueAfterMs: ms(stage.escalationDueAfter),
      })),
      resubmitWithinMs: millis(row.policy.resubmitWithin),
    };
  }

  /**
   * What a step answers when the request is no longer where it expected:
   * its status when it ended (the workflow concludes with that), `raced`
   * when it goes on (a signal is on its way), `gone` when it was purged.
   * Steps run at least once: a retry lands here and answers what the
   * committed attempt produced.
   */
  private where(
    row: ApprovalRequestRow | undefined,
    round: number,
  ): 'gone' | 'raced' | Ending {
    if (!row) return 'gone';
    if (row.round !== round || row.status === 'pending') return 'raced';
    return row.status;
  }

  async votes(row: ApprovalRequestRow, stage: number) {
    return this.db
      .select({
        approverId: approvalAssignments.approverId,
        status: approvalAssignments.status,
        decidedAt: approvalAssignments.decidedAt,
        decidedBy: approvalAssignments.decidedBy,
      })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.round, row.round),
          eq(approvalAssignments.stage, stage),
        ),
      );
  }

  /**
   * Asks the stage's mode where it stands, and settles it when decided:
   * the outcome recorded, the workflow signalled, the request ended (or,
   * approved with stages left, the stage's other approvers closed out).
   * `unreachable` ends it as `failed`. In the change's transaction, on the
   * locked row.
   */
  async settleStage(
    after: AfterCommit,
    row: ApprovalRequestRow,
    by: Principal | null,
    {
      decision = null,
      comment,
      ip,
      tolerant = false,
    }: {
      decision?: string | null;
      comment?: string;
      ip?: string;
      tolerant?: boolean;
    } = {},
  ): Promise<ApprovalRequestRow> {
    const stage = row.currentStage;
    const votes = await this.votes(row, stage);
    const outcome = stageOutcome(row.policy.stages[stage]!.mode, votes);
    const voters = votes
      .filter((vote) => vote.status !== 'closed')
      .map((vote) => vote.approverId);
    if (outcome === 'pending') {
      if (decision !== null) this.pushDecided(after, row, decision, voters);
      return row;
    }
    const ending = outcome === 'unreachable' ? 'failed' : outcome;
    const [settled] = await this.db
      .update(approvalRequests)
      .set({ stageOutcome: ending })
      .where(eq(approvalRequests.id, row.id))
      .returning();
    const key = `${row.id}:${row.round}:${stage}`;
    await this.workflows.signal(
      stageDecided,
      { outcome: ending, tenantId: row.tenantId },
      { key, id: key, transaction: this.tx },
    );
    if (ending === 'approved' && stage < row.policy.stages.length - 1) {
      // The stage's other approvers needn't decide; the workflow starts the next stage.
      await this.db
        .update(approvalAssignments)
        .set({ status: 'closed' })
        .where(
          and(
            eq(approvalAssignments.requestId, row.id),
            eq(approvalAssignments.status, 'pending'),
          ),
        );
      await this.event(
        settled!,
        'stage_approved',
        this.actorFor(by),
        {},
        stage,
      );
      this.pushDecided(after, settled!, decision, voters);
      return settled!;
    }
    return this.end(after, settled!, ending, by, {
      ...(outcome === 'unreachable' && { reason: 'no_approvers' }),
      comment,
      ip,
      decision,
      voters,
      tolerant,
    });
  }

  /** Whether every stage of a policy finds enough approvers now: a request is refused otherwise (422). */
  async startable(context: RuleContext, policy: ApprovalPolicy) {
    for (const stage of policy.stages) {
      const ids = await this.approvers.resolve(context, stage.approvers);
      const pending = ids.map((approverId) => ({
        approverId,
        status: 'pending' as const,
        decidedAt: null,
        decidedBy: null,
      }));
      if (!ids.length || stageOutcome(stage.mode, pending) === 'unreachable') {
        return { ok: false as const, stage: stage.name };
      }
    }
    return { ok: true as const };
  }

  /**
   * Starts a stage: resolves its approvers now (later role changes don't
   * change who decides it) and assigns them. Too few ends the request as
   * `failed` (`no_approvers`).
   */
  startStage(requestId: string, round: number, stage: number) {
    return this.run(
      async (after): Promise<'started' | 'gone' | 'raced' | Ending> => {
        const row = await this.lock(requestId);
        if (!row || row.status !== 'pending' || row.round !== round) {
          return this.where(row, round);
        }
        if (row.currentStage === stage && row.stageStartedAt) return 'started';
        const policyStage = row.policy.stages[stage]!;
        const ids = await this.approvers.resolve(
          this.context(row),
          policyStage.approvers,
        );
        if (!ids.length) {
          const ended = await this.end(
            after,
            { ...row, currentStage: stage },
            'failed',
            null,
            { reason: 'no_approvers' },
          );
          return ended.status as Ending;
        }
        const now = new Date();
        const [started] = await this.db
          .update(approvalRequests)
          .set({
            currentStage: stage,
            stageStartedAt: now,
            stageOutcome: null,
            dueAt: policyStage.dueAfter
              ? new Date(now.getTime() + millis(policyStage.dueAfter))
              : null,
          })
          .where(eq(approvalRequests.id, requestId))
          .returning();
        await this.assign(after, started!, stage, ids, {
          escalated: false,
          type: 'approval.requested',
        });
        await this.event(
          started!,
          'stage_started',
          this.actorFor(null),
          { name: policyStage.name, approvers: ids },
          stage,
        );
        // Too few for the mode (a quorum above the approvers found): it can't be decided.
        const settled = await this.settleStage(after, started!, null);
        return settled.status === 'pending'
          ? 'started'
          : (settled.status as Ending);
      },
    );
  }

  /** The request, still deciding this stage; none when it moved on. */
  private deciding(
    row: ApprovalRequestRow | undefined,
    round: number,
    stage: number,
  ) {
    return row &&
      row.status === 'pending' &&
      row.round === round &&
      row.currentStage === stage &&
      !row.stageOutcome
      ? row
      : undefined;
  }

  private async happened(row: ApprovalRequestRow, type: string, stage: number) {
    const [found] = await this.db
      .select({ id: approvalEvents.id })
      .from(approvalEvents)
      .where(
        and(
          eq(approvalEvents.requestId, row.id),
          eq(approvalEvents.round, row.round),
          eq(approvalEvents.stage, stage),
          eq(approvalEvents.type, type),
        ),
      )
      .limit(1);
    return !!found;
  }

  private async pendingApprovers(row: ApprovalRequestRow, stage: number) {
    return (await this.votes(row, stage))
      .filter((vote) => vote.status === 'pending')
      .map((vote) => vote.approverId);
  }

  /** Reminds the approvers of a stage who haven't decided (once: a retry finds it sent). */
  remind(requestId: string, round: number, stage: number) {
    return this.run(
      async (): Promise<'reminded' | 'gone' | 'raced' | Ending> => {
        const locked = await this.lock(requestId);
        const row = this.deciding(locked, round, stage);
        if (!row) return this.where(locked, round);
        if (await this.happened(row, 'reminded', stage)) return 'reminded';
        const pending = await this.pendingApprovers(row, stage);
        const delegates = await this.approvers.delegatesOf(
          pending,
          row.subject,
        );
        const recipients = [
          ...new Set([...pending, ...[...delegates.values()].flat()]),
        ];
        if (recipients.length) {
          await this.notifications.notify({
            type: 'approval.reminder',
            to: recipients.map((id) => `user:${id}`),
            data: { ...this.data(row), by: row.requesterName },
            link: `/approvals/${row.id}`,
          });
        }
        await this.event(
          row,
          'reminded',
          this.actorFor(null),
          { approvers: pending },
          stage,
        );
        return 'reminded';
      },
    );
  }

  /**
   * The stage is overdue: escalate (the `escalateTo` approvers take over
   * its undecided part; the decisions made still count) or expire.
   */
  overdue(requestId: string, round: number, stage: number) {
    return this.run(
      async (after): Promise<'escalated' | 'gone' | 'raced' | Ending> => {
        const locked = await this.lock(requestId);
        const row = this.deciding(locked, round, stage);
        if (!row) return this.where(locked, round);
        const policyStage = row.policy.stages[stage]!;
        if (policyStage.onOverdue === 'escalate' && policyStage.escalateTo) {
          if (await this.happened(row, 'escalated', stage)) return 'escalated';
          const ids = await this.approvers.resolve(
            this.context(row),
            policyStage.escalateTo,
          );
          const assigned = new Set(
            (await this.votes(row, stage)).map((vote) => vote.approverId),
          );
          if (ids.some((id) => !assigned.has(id))) {
            // Those who didn't answer in time are closed out: an `all` stage
            // then waits for the escalation's approvers, not for them.
            await this.db
              .update(approvalAssignments)
              .set({ status: 'closed' })
              .where(
                and(
                  eq(approvalAssignments.requestId, row.id),
                  eq(approvalAssignments.round, row.round),
                  eq(approvalAssignments.stage, stage),
                  eq(approvalAssignments.status, 'pending'),
                  notInArray(approvalAssignments.approverId, ids),
                ),
              );
            const assignments = await this.assign(after, row, stage, ids, {
              escalated: true,
              type: 'approval.escalated',
            });
            const [escalated] = await this.db
              .update(approvalRequests)
              .set({
                dueAt: policyStage.escalationDueAfter
                  ? new Date(
                      Date.now() + millis(policyStage.escalationDueAfter),
                    )
                  : null,
              })
              .where(eq(approvalRequests.id, row.id))
              .returning();
            const approvers = assignments.map((a) => a.approverId);
            await this.event(
              escalated!,
              'escalated',
              this.actorFor(null),
              { approvers },
              stage,
            );
            await this.record(null, 'approval.escalated', escalated!, {
              stage,
              approvers,
            });
            // The votes changed: the stage may be decided now (or out of reach).
            const settled = await this.settleStage(after, escalated!, null);
            if (settled.status !== 'pending') return settled.status as Ending;
            return settled.stageOutcome ? 'raced' : 'escalated';
          }
          // Nobody new to escalate to: the request expires.
        }
        const ended = await this.end(after, row, 'expired', null, {
          reason: 'overdue',
        });
        return ended.status as Ending;
      },
    );
  }

  /** After an escalation's own deadline: the request expires, unless decided meanwhile. */
  expireStage(requestId: string, round: number, stage: number) {
    return this.run(async (after): Promise<'gone' | 'raced' | Ending> => {
      const locked = await this.lock(requestId);
      const row = this.deciding(locked, round, stage);
      if (!row) return this.where(locked, round);
      const ended = await this.end(after, row, 'expired', null, {
        reason: 'overdue',
      });
      return ended.status as Ending;
    });
  }

  /** Changes were requested and the requester never resubmitted: the request expires. */
  expireResubmission(requestId: string, round: number) {
    return this.run(async (after): Promise<'gone' | 'raced' | Ending> => {
      const row = await this.lock(requestId);
      if (!row || row.status !== 'changes_requested' || row.round !== round) {
        return this.where(row, round);
      }
      const ended = await this.end(after, row, 'expired', null, {
        reason: 'not_resubmitted',
      });
      return ended.status as Ending;
    });
  }

  /**
   * A user can't decide any more (their membership deactivated): their
   * pending assignments close and each stage is settled again; their
   * delegations end. In the deactivation's transaction, as who did it.
   * Requests are locked in id order, so two deactivations can't deadlock.
   */
  async release(userId: string, by: Principal) {
    const held = await this.db
      .selectDistinct({ requestId: approvalAssignments.requestId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.approverId, userId),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .orderBy(approvalAssignments.requestId);
    const after = new AfterCommit(); // realtime is left out: the caller's transaction hasn't committed
    for (const { requestId } of held) {
      const locked = await this.lock(requestId);
      if (!locked || locked.status !== 'pending' || locked.stageOutcome)
        continue;
      const closed = await this.db
        .update(approvalAssignments)
        .set({ status: 'closed' })
        .where(
          and(
            eq(approvalAssignments.requestId, requestId),
            eq(approvalAssignments.round, locked.round),
            eq(approvalAssignments.stage, locked.currentStage),
            eq(approvalAssignments.approverId, userId),
            eq(approvalAssignments.status, 'pending'),
          ),
        )
        .returning({ id: approvalAssignments.id });
      if (!closed.length) continue;
      await this.event(
        locked,
        'approver_removed',
        actorOf(by),
        { approverId: userId },
        locked.currentStage,
      );
      await this.settleStage(after, locked, by, { tolerant: true });
    }
    // Nobody stands in for them, and they stand in for nobody.
    await this.db
      .delete(approvalDelegations)
      .where(
        or(
          eq(approvalDelegations.fromUserId, userId),
          eq(approvalDelegations.toUserId, userId),
        ),
      );
  }

  /**
   * The request ended (or was sent back for changes): its status, its
   * pending approvers closed out, and everything it tells, in the
   * transaction of the change. `tolerant`: an ending nobody may refuse (a
   * deactivation): what it tells runs in a savepoint, and a failure there
   * is logged instead of rolling the change back.
   */
  async end(
    after: AfterCommit,
    row: ApprovalRequestRow,
    status: Ending,
    by: Principal | null,
    {
      reason,
      comment,
      ip,
      decision = null,
      voters = [],
      tolerant = false,
    }: {
      reason?: string;
      comment?: string;
      ip?: string;
      decision?: string | null;
      voters?: readonly string[];
      tolerant?: boolean;
    } = {},
  ) {
    const actor = this.actorFor(by);
    const closed = await this.db
      .update(approvalAssignments)
      .set({ status: 'closed' })
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .returning({ approverId: approvalAssignments.approverId });
    const [ended] = await this.db
      .update(approvalRequests)
      .set({
        status,
        currentStage: row.currentStage,
        // Sent back for changes, it stays open: it may come back.
        endedAt: status === 'changes_requested' ? null : new Date(),
        outcomeReason: reason ?? null,
      })
      .where(eq(approvalRequests.id, row.id))
      .returning();
    await this.event(
      ended!,
      status,
      actor,
      { ...(reason && { reason }), ...(comment && { comment }) },
      ended!.currentStage,
    );
    await this.record(
      by,
      `approval.${status}`,
      ended!,
      { ...(reason && { reason }) },
      ip,
    );
    const tell = async () => {
      const type = NOTIFY[status];
      if (type) {
        await this.notifications.notify({
          type,
          to: ended!.requester,
          data: {
            ...this.data(ended!),
            ...(status !== 'expired' &&
              status !== 'failed' && { by: actor.name }),
            ...((status === 'rejected' || status === 'changes_requested') && {
              comment: comment ?? '',
            }),
          },
          link: `/approvals/${ended!.id}`,
        });
      } else if (closed.length || actor.key !== ended!.requester) {
        // Withdrawn: the approvers still waiting needn't decide, and the
        // requester is told when someone else withdrew it.
        await this.notifications.notify({
          type: 'approval.cancelled',
          to: [
            ...closed.map(({ approverId }) => `user:${approverId}`),
            ...(actor.key !== ended!.requester ? [ended!.requester] : []),
          ],
          data: { ...this.data(ended!), by: actor.name },
          link: `/approvals/${ended!.id}`,
        });
      }
      await this.publish(APPROVAL_EVENTS[status], ended!);
    };
    if (tolerant) {
      try {
        await this.txHost.withTransaction(Propagation.Nested, tell);
      } catch (error) {
        this.logger.error(
          `Telling of approval ${ended!.id}'s ending failed; the change went ahead: ${(error as Error).message}`,
        );
      }
    } else {
      await tell();
    }
    this.pushDecided(after, ended!, decision, [
      ...voters,
      ...closed.map((a) => a.approverId),
    ]);
    return ended!;
  }

  /** `approval.decided` to the requester and to these approvers: one event per change. */
  pushDecided(
    after: AfterCommit,
    row: ApprovalRequestRow,
    decision: string | null,
    approverIds: readonly string[],
  ) {
    const to = [
      requesterOf(row.requester),
      ...[...new Set(approverIds)].map((id) => ({ kind: 'user' as const, id })),
    ];
    this.push(after, to, (all) =>
      this.realtime.toPrincipals(all, APPROVAL_REALTIME.decided, {
        id: row.id,
        status: row.status,
        round: row.round,
        stage: row.currentStage,
        decision,
      }),
    );
  }

  /**
   * Runs the outcome of round `round` (a workflow step: at least once):
   * approved, the record's fingerprint is compared first (a record changed
   * since the request ends it as `failed`, `record_changed`), then the
   * feature's effect runs, its writes let through the record's lock.
   * `outcomeAppliedAt` marks a final outcome of the round (a resubmission
   * clears it). Answers the status it concluded, or `gone`.
   */
  async conclude(
    requestId: string,
    status: Ending,
    round: number,
  ): Promise<Ending | 'gone'> {
    let [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    if (!row) return 'gone';
    const sameRound = row.round === round;
    if (
      sameRound &&
      row.status === 'approved' &&
      !row.outcomeAppliedAt &&
      row.fingerprint !== null &&
      (await this.fingerprint(row.subject, row.recordId)) !== row.fingerprint
    ) {
      row = await this.run(async (after) => {
        const locked = (await this.lock(requestId))!;
        return locked.status === 'approved' && !locked.outcomeAppliedAt
          ? this.end(after, locked, 'failed', null, {
              reason: 'record_changed',
            })
          : locked;
      });
    }
    // The request's own status: a cancellation, or a record that changed, concludes as what it became.
    const concluded =
      !sameRound || row.status === 'pending' ? status : (row.status as Ending);
    if (sameRound && row.outcomeAppliedAt) return concluded; // a retry: applied before
    if (concluded === 'approved') {
      await this.registry.apply(`${row.subject}.${row.action}`, {
        id: row.recordId,
        actor: this.systemPrincipal(),
      });
    }
    if (sameRound && concluded !== 'changes_requested') {
      const [applied] = await this.db
        .update(approvalRequests)
        .set({ outcomeAppliedAt: new Date() })
        .where(
          and(
            eq(approvalRequests.id, requestId),
            eq(approvalRequests.round, round),
            isNull(approvalRequests.outcomeAppliedAt),
            // Still what was concluded: one abandoned meanwhile isn't marked applied.
            eq(approvalRequests.status, concluded),
          ),
        )
        .returning();
      // Only the attempt that set it tells; a page also reads the field.
      if (applied && concluded === 'approved') await this.pushApplied(applied);
    }
    return concluded;
  }

  /** `approval.applied` to the requester and the round's approvers (best effort). */
  private async pushApplied(row: ApprovalRequestRow) {
    const assignments = await this.db
      .select({ approverId: approvalAssignments.approverId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.round, row.round),
          ne(approvalAssignments.status, 'closed'),
        ),
      );
    this.realtime.toPrincipals(
      [
        requesterOf(row.requester),
        ...[...new Set(assignments.map((a) => a.approverId))].map((id) => ({
          kind: 'user' as const,
          id,
        })),
      ],
      APPROVAL_REALTIME.applied,
      {
        id: row.id,
        subject: row.subject,
        recordId: row.recordId,
        outcomeAppliedAt: row.outcomeAppliedAt!.toISOString(),
      },
    );
  }

  /**
   * The approved outcome's effect gave up (its attempts ran out): the
   * request ends as `failed` (`apply_failed`), so the record isn't locked
   * for good and the requester is told.
   */
  applyFailed(requestId: string, round: number) {
    return this.run(async (after): Promise<'gone' | 'raced' | Ending> => {
      const row = await this.lock(requestId);
      if (
        !row ||
        row.round !== round ||
        row.status !== 'approved' ||
        row.outcomeAppliedAt
      ) {
        return this.where(row, round);
      }
      const ended = await this.end(after, row, 'failed', null, {
        reason: 'apply_failed',
      });
      return ended.status as Ending;
    });
  }

  /** The users a list of rules names now (the escalation's, a stage's). */
  resolve(row: ApprovalRequestRow, rules: readonly ApproverRule[]) {
    return this.approvers.resolve(this.context(row), rules);
  }
}
