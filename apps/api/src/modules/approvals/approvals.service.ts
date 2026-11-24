import { AuthorizationService } from '@nestjs/authorization';
import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type Type,
} from '@nestjs/common';
import { WorkflowClient } from '@nestjs/workflows';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { assertUnchanged, etagOf } from '../../core/http/etag.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AccessService } from '../../iam/access/access.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { Records } from '../records/records.service.js';
import { holds } from './approval-modes.js';
import {
  actorOf,
  AfterCommit,
  ApprovalEngine,
  titleOf,
} from './approval-engine.service.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import { ApprovalWorkflow } from './approval.workflow.js';
import {
  APPROVAL_EVENTS,
  approvalWorkflowId,
  requestCancelled,
  requestResubmitted,
} from './approvals.events.js';
import { approvalList } from './approvals.list.js';
import { applyingEffect, ApprovalsRegistry } from './approvals.registry.js';
import type { ApprovalDetail, ApprovalView } from './approvals.schemas.js';
import { ApprovalsRepository } from './approvals.repository.js';
import { type ApprovalRequestRow, OPEN_STATUSES } from './approvals.tables.js';

type Decision = 'approved' | 'rejected' | 'changes_requested';

/** A workflow instance that may still apply an outcome: it runs, waits to retry, or undoes. */
const LIVE_WORKFLOW: readonly string[] = [
  'pending',
  'running',
  'suspended',
  'compensating',
];

/** What asking for an action answers: done at once, or waiting for the approvers. */
export type ActionResult =
  | { status: 'applied'; approvalId: null }
  | { status: 'pending'; approvalId: string };

/**
 * Approvals as records use them and people take part in them: `act()`
 * (an approvable action's route), `assertNotPending()` and `withdraw()`
 * (the record's writes, through its extension), and the decisions,
 * cancellation and resubmission of the API. Each change is one transaction
 * with its timeline, audit entry, notifications and domain event; the
 * request's workflow (ApprovalWorkflow) takes it from there.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly repository: ApprovalsRepository,
    private readonly registry: ApprovalsRegistry,
    private readonly engine: ApprovalEngine,
    private readonly policies: ApprovalPoliciesService,
    private readonly workflows: WorkflowClient,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    private readonly records: Records,
    private readonly authorization: AuthorizationService,
  ) {}

  /** Nobody decides, withdraws, resubmits or delegates while acting as someone else. */
  assertNotImpersonating(principal: Principal) {
    if (principal.kind === 'user' && principal.impersonator) {
      throw this.engine.problem(
        HttpStatus.FORBIDDEN,
        'approval_impersonation',
        'impersonating',
      );
    }
  }

  /** `approvalId`: the open request (the problem's own `requestId` is the HTTP request's). */
  private pendingConflict(approvalId?: string) {
    return this.engine.problem(
      HttpStatus.CONFLICT,
      'approval_pending',
      'pending',
      {
        ...(approvalId && { approvalId }),
      },
    );
  }

  /** Locks the record's row for the transaction: a request and a write to the record take turns. */
  private async lockRecord(subject: string, id: string) {
    const { table } = this.records.of(subject).feature;
    const row = await this.repository.lockRecord(table, id);
    if (!row) throw new NotFoundException();
  }

  /**
   * An approvable action asked for on a record (its route), by whoever may
   * update the record: a 404 when they may not read it, a 403 when they may
   * read it but not change it. Done at once when
   * no approval is needed (the policy is off, the flag is off for the
   * requester, or the policy's `when` doesn't hold); otherwise a request
   * is made, and its workflow starts in the same transaction. A 409
   * `approval_pending` while one is open for this action on the record; a
   * 422 `approval_no_approvers` when a stage would find too few approvers.
   */
  async act(
    by: RequestPrincipal,
    subject: string,
    recordId: string,
    action: string,
    comment?: string,
    ip?: string,
  ): Promise<ActionResult> {
    const { store, feature } = this.records.of(subject);
    // Unreadable: the 404 of a missing one; readable but not theirs to change: a 403.
    const record = await store.findOne(recordId, { visibleTo: by });
    await this.authorization.authorize(
      feature.policy as unknown as Type<{
        update(...args: unknown[]): boolean;
      }>,
      'update',
      by,
      record,
    );
    const key = `${subject}.${action}`;
    const declared = this.registry.action(key);
    const { policy, version } = await this.policies.effective(key);
    const needed =
      policy.enabled &&
      (!declared.flag || (await this.settings.enabled(declared.flag, by)));
    const requester = { kind: by.kind, id: by.id } as const;
    const result = await this.engine
      .run(async (): Promise<ActionResult> => {
        await this.lockRecord(subject, recordId);
        const row = (await this.engine.recordOf(subject, recordId))!;
        const { declaration } = this.records.of(subject);
        const payload = { title: titleOf(declaration.noun, row) };
        if (!needed || !holds(policy.when, payload)) {
          return { status: 'applied', approvalId: null };
        }
        await this.assertNoneOpen(subject, recordId, action);
        const draft = {
          subject,
          recordId,
          action,
          requester: principalKey(requester),
        };
        // Every stage must find enough approvers now; who exactly is decided when each starts.
        const startable = await this.engine.startable(
          this.engine.context(draft),
          policy,
        );
        if (!startable.ok) {
          throw this.engine.problem(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'approval_no_approvers',
            'noApprovers',
            { stage: startable.stage },
          );
        }
        const created = await this.repository.insert({
          ...draft,
          payload,
          requesterName: by.name,
          title: payload.title,
          link: `/${declaration.path}/${recordId}`,
          policy,
          policyVersion: version,
          fingerprint: await this.engine.fingerprint(subject, recordId),
          comment: comment ?? null,
        });
        await this.engine.event(created, 'requested', actorOf(by), {
          policyVersion: version,
        });
        await this.engine.record(
          by,
          'approval.requested',
          created,
          {
            policyVersion: version,
          },
          ip,
        );
        await this.engine.publish(APPROVAL_EVENTS.requested, created);
        // The process exists if and only if the request does.
        await this.workflows.start(
          ApprovalWorkflow,
          withTenant({ requestId: created.id }),
          { id: approvalWorkflowId(created.id), transaction: this.engine.tx },
        );
        return { status: 'pending', approvalId: created.id };
      })
      .catch((error: unknown) => {
        // Two requests at once: the open-request index lets one through.
        if (databaseErrorKind(error) === 'unique_violation') {
          throw this.pendingConflict();
        }
        throw error;
      });
    if (result.status === 'applied') {
      await this.registry.apply(key, { id: recordId, actor: by });
    }
    return result;
  }

  private async assertNoneOpen(
    subject: string,
    recordId: string,
    action: string,
  ) {
    const [open] = await this.repository.open(subject, recordId, action);
    if (open) throw this.pendingConflict(open.id);
  }

  /**
   * For a write to the record, in its transaction (the record's row is
   * locked by then): a 409 `approval_pending` while a request of the record
   * waits for a decision, or was approved and its outcome isn't applied yet,
   * so what is applied is what was approved. Sent back for changes, the
   * record may change. An effect's own writes pass.
   */
  async assertNotPending(subject: string, recordId: string) {
    if (applyingEffect()) return;
    const open = await this.repository.blocking(subject, recordId);
    if (open) throw this.pendingConflict(open.id);
  }

  /**
   * The record is deleted: its open requests (sent back for changes) are
   * cancelled by whoever deleted it, so no approval acts on a record that
   * is gone. In the delete's transaction; realtime events are left out.
   */
  async withdraw(by: Principal, subject: string, recordId: string) {
    const open = await this.repository.open(subject, recordId);
    const after = new AfterCommit();
    for (const { id } of open) {
      const locked = (await this.engine.lock(id))!;
      await this.engine.end(after, locked, 'cancelled', by, {
        reason: 'record_deleted',
      });
      await this.signalCancelled(locked, principalKey(by));
    }
  }

  /** Records deleted for good take their requests along; the open ones' workflows are told. */
  async forget(subject: string, recordIds: readonly string[]) {
    const open = await this.repository.openOfRecords(subject, recordIds);
    for (const row of open) await this.signalCancelled(row, 'purge');
    await this.repository.deleteOfRecords(subject, recordIds);
  }

  private signalCancelled(row: ApprovalRequestRow, by: string) {
    return this.workflows.signal(
      requestCancelled,
      { by, tenantId: row.tenantId },
      { key: row.id, id: `${row.id}:cancelled`, transaction: this.engine.tx },
    );
  }

  /** The principal's Approval.read filter: what they may oversee beside what they take part in. */
  private oversee(principal: Principal) {
    return this.access.sqlFilter(principal, 'Approval', 'read');
  }

  /**
   * A page of the requests the caller may read, by the list's filters,
   * with `?fields=` applied: each item with the `can` and the `etag` its
   * `GET /approvals/{id}` would give the caller.
   */
  async page(principal: Principal, raw: Record<string, unknown>) {
    // The list bound to the caller: assignedToMe, requestedByMe and decidedByMe are theirs.
    const list = approvalList(principal);
    const query = list.parse(raw);
    const page = await this.repository.page(
      principal,
      await this.oversee(principal),
      list.where(query),
      query,
    );
    const details = await this.detailsOf(principal, page.items);
    const picked = list.pick({ ...page, items: page.items.map(view) }, query);
    return {
      ...picked,
      items: picked.items.map((item, index) => ({
        ...item,
        can: details[index]!.can,
        // The tag GET /approvals/{id} sends: a decision's If-Match compares it.
        etag: etagOf(details[index]!),
      })),
    };
  }

  /** The request, if the principal may read it; a 404 otherwise (its existence stays hidden). */
  async find(principal: Principal, id: string) {
    const row = await this.repository.findReadable(
      principal,
      await this.oversee(principal),
      id,
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  /** The request with its stages, assignments, timeline and what the caller may do. */
  async detail(principal: Principal, id: string): Promise<ApprovalDetail> {
    return (
      await this.detailsOf(principal, [await this.find(principal, id)])
    )[0]!;
  }

  /** The requests as `GET /approvals/{id}` shows them, in three queries whatever their number. */
  private async detailsOf(
    principal: Principal,
    rows: readonly ApprovalRequestRow[],
  ): Promise<ApprovalDetail[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const assignments = await this.repository.assignmentsOf(ids);
    const timeline = await this.repository.timelineOf(ids);
    const delegations =
      principal.kind === 'user'
        ? await this.engine.approvers.delegators(principal.id)
        : [];
    const details: ApprovalDetail[] = [];
    for (const row of rows) {
      const delegators = new Set(
        delegations
          .filter((d) => d.subject === null || d.subject === row.subject)
          .map((d) => d.from),
      );
      const mine = assignments.filter((a) => a.requestId === row.id);
      const decidable =
        row.status === 'pending' &&
        !row.stageOutcome &&
        principal.kind === 'user' &&
        row.requester !== principalKey(principal) &&
        mine.some(
          (a) =>
            a.round === row.round &&
            a.stage === row.currentStage &&
            (a.approverId === principal.id || delegators.has(a.approverId)) &&
            a.status === 'pending',
        );
      const requester = row.requester === principalKey(principal);
      const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
      details.push({
        ...view(row),
        stages: row.policy.stages.map((stage, index) => ({
          index,
          name: stage.name,
          mode: stage.mode,
          state:
            index < row.currentStage
              ? 'approved'
              : index > row.currentStage
                ? 'waiting'
                : row.status === 'pending'
                  ? row.stageStartedAt
                    ? ((row.stageOutcome as 'approved' | null) ?? 'active')
                    : 'waiting'
                  : row.status === 'approved' ||
                      row.status === 'rejected' ||
                      row.status === 'changes_requested'
                    ? row.status
                    : 'closed',
        })),
        assignments: mine.map((a) => ({
          id: a.id,
          round: a.round,
          stage: a.stage,
          approverId: a.approverId,
          approverName: a.approverName ?? '',
          status: a.status,
          comment: a.comment,
          decidedAt: a.decidedAt?.toISOString() ?? null,
          decidedBy: a.decidedBy,
          decidedByName: a.decidedByName,
          onBehalfOf: a.onBehalfOf,
          escalated: a.escalated,
        })),
        timeline: timeline
          .filter((event) => event.requestId === row.id)
          .map((event) => ({
            id: event.id,
            type: event.type,
            actor: event.actor,
            actorName: event.actorName,
            round: event.round,
            stage: event.stage,
            details: event.details,
            createdAt: event.createdAt.toISOString(),
          })),
        can: {
          decide: decidable,
          cancel:
            open &&
            (requester ||
              (await this.access.can(principal, 'cancel', 'Approval', row))),
          resubmit: requester && row.status === 'changes_requested',
          // abandon() also refuses while the workflow still runs: checked at call time.
          abandon:
            row.status === 'approved' &&
            !row.outcomeAppliedAt &&
            (await this.access.can(principal, 'abandon', 'Approval', row)),
        },
      });
    }
    return details;
  }

  /** The current stage's assignments the principal decides: their own, and those of whom they stand in for. */
  private async held(principal: Principal, row: ApprovalRequestRow) {
    const stage = await this.repository.stageAssignments(
      row.id,
      row.round,
      row.currentStage,
    );
    const delegators = new Set(
      (await this.engine.approvers.delegators(principal.id, row.subject)).map(
        (d) => d.from,
      ),
    );
    return stage.filter(
      (a) => a.approverId === principal.id || delegators.has(a.approverId),
    );
  }

  /** The request locked, readable by the principal, and as they read it (their If-Match: under the lock, a check before it would race). */
  private async locked(principal: Principal, id: string, ifMatch?: string) {
    const locked = await this.engine.lock(id);
    if (!locked) throw new NotFoundException();
    await this.find(principal, id);
    if (ifMatch) {
      assertUnchanged(ifMatch, (await this.detailsOf(principal, [locked]))[0]!);
    }
    return locked;
  }

  /**
   * An approver's decision, under the request's row lock, so decisions
   * take turns. One person, one decision per stage: it applies to every
   * assignment of the stage they hold or stand in for, each recorded
   * `onBehalfOf` whoever it was assigned to. The stage's mode then says
   * whether the stage is decided. Deciding again the same way changes
   * nothing.
   */
  async decide(
    principal: Principal,
    id: string,
    decision: Decision,
    comment: string | undefined,
    ip?: string,
    ifMatch?: string,
  ): Promise<ApprovalDetail> {
    this.assertNotImpersonating(principal);
    const row = await this.engine.run(async (after) => {
      const locked = await this.locked(principal, id, ifMatch);
      if (locked.requester === principalKey(principal)) {
        throw this.engine.problem(
          HttpStatus.FORBIDDEN,
          'approval_self_approval',
          'selfApproval',
        );
      }
      if (locked.status !== 'pending') {
        throw this.engine.problem(
          HttpStatus.CONFLICT,
          'approval_closed',
          'closed',
          {
            requestStatus: locked.status,
          },
        );
      }
      const held =
        principal.kind === 'user' ? await this.held(principal, locked) : [];
      if (!held.length) {
        throw this.engine.problem(
          HttpStatus.FORBIDDEN,
          'approval_not_assignee',
          'notAssignee',
        );
      }
      const pending = held.filter((a) => a.status === 'pending');
      const mine = held.filter((a) => a.decidedBy === principal.id);
      const other = mine.find((a) => a.status !== decision);
      if (other) {
        throw this.engine.problem(
          HttpStatus.CONFLICT,
          'approval_already_decided',
          'decidedOtherwise',
          { decision: other.status },
        );
      }
      if (!pending.length || locked.stageOutcome) {
        if (mine.length && !locked.stageOutcome) return locked; // the same decision again
        throw this.engine.problem(
          HttpStatus.CONFLICT,
          'approval_already_decided',
          'alreadyDecided',
        );
      }
      const decided = await this.repository.decide(
        pending.map((a) => a.id),
        decision,
        comment ?? null,
        principal,
      );
      const stage = locked.currentStage;
      const onBehalfOf = decided
        .map((a) => a.onBehalfOf)
        .filter((who): who is string => !!who);
      await this.engine.event(
        locked,
        'decided',
        actorOf(principal),
        {
          decision,
          ...(comment && { comment }),
          ...(onBehalfOf.length && { onBehalfOf }),
        },
        stage,
      );
      await this.engine.record(
        principal,
        'approval.decided',
        locked,
        { decision, stage, ...(onBehalfOf.length && { onBehalfOf }) },
        ip,
      );
      return this.engine.settleStage(after, locked, principal, {
        decision,
        comment,
        ip,
      });
    });
    return this.detail(principal, row.id);
  }

  /** The requester withdraws it, or someone who may cancel approvals (Approval.cancel). */
  async cancel(
    principal: Principal,
    id: string,
    reason?: string,
    ip?: string,
    ifMatch?: string,
  ) {
    this.assertNotImpersonating(principal);
    await this.engine.run(async (after) => {
      const locked = await this.locked(principal, id, ifMatch);
      if (
        locked.requester !== principalKey(principal) &&
        !(await this.access.can(principal, 'cancel', 'Approval', locked))
      ) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: this.engine.text('notRequester'),
        });
      }
      if (!(OPEN_STATUSES as readonly string[]).includes(locked.status)) {
        throw this.engine.problem(
          HttpStatus.CONFLICT,
          'approval_closed',
          'closed',
          {
            requestStatus: locked.status,
          },
        );
      }
      await this.engine.end(after, locked, 'cancelled', principal, {
        comment: reason,
        ip,
      });
      await this.signalCancelled(locked, principalKey(principal));
    });
    return this.detail(principal, id);
  }

  /**
   * After changes were requested, the requester sends it again: a new
   * round from the first stage, its approvers resolved again, its payload
   * and fingerprint read from the record as it is now. It keeps its policy.
   */
  async resubmit(
    principal: Principal,
    id: string,
    comment?: string,
    ip?: string,
    ifMatch?: string,
  ) {
    this.assertNotImpersonating(principal);
    const current = await this.find(principal, id);
    if (current.requester !== principalKey(principal)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: this.engine.text('notRequester'),
      });
    }
    const notSentBack = (status?: string) =>
      new ConflictException({
        code: 'approval_not_changes_requested',
        message: this.engine.text('notChangesRequested'),
        requestStatus: status,
      });
    if (current.status !== 'changes_requested')
      throw notSentBack(current.status);
    await this.engine.run(async () => {
      // The record's lock first (as act() and the record's writes take it), then the request's.
      await this.lockRecord(current.subject, current.recordId);
      const locked = await this.locked(principal, id, ifMatch);
      if (locked.status !== 'changes_requested')
        throw notSentBack(locked.status);
      const row = (await this.engine.recordOf(
        locked.subject,
        locked.recordId,
      ))!;
      const payload = {
        title: titleOf(this.records.of(locked.subject).declaration.noun, row),
      };
      const startable = await this.engine.startable(
        this.engine.context(locked),
        locked.policy,
      );
      if (!startable.ok) {
        throw this.engine.problem(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'approval_no_approvers',
          'noApprovers',
          { stage: startable.stage },
        );
      }
      const resubmitted = await this.repository.update(id, {
        status: 'pending',
        round: locked.round + 1,
        currentStage: 0,
        stageStartedAt: null,
        stageOutcome: null,
        dueAt: null,
        payload,
        title: payload.title,
        fingerprint: await this.engine.fingerprint(
          locked.subject,
          locked.recordId,
        ),
        // A new round: its outcome is still to be applied.
        outcomeAppliedAt: null,
        comment: comment ?? locked.comment,
      });
      await this.engine.event(resubmitted, 'resubmitted', actorOf(principal), {
        ...(comment && { comment }),
      });
      await this.engine.record(
        principal,
        'approval.resubmitted',
        resubmitted,
        { round: resubmitted.round },
        ip,
      );
      await this.workflows.signal(
        requestResubmitted,
        { round: resubmitted.round, tenantId: resubmitted.tenantId },
        {
          key: `${id}:${locked.round}`,
          id: `${id}:${locked.round}:resubmitted`,
          transaction: this.engine.tx,
        },
      );
    });
    return this.detail(principal, id);
  }

  /**
   * Gives up on an approved request whose outcome will never apply: its
   * workflow ended without applying it. Only then: while the workflow runs
   * or retries, the effect may be running right now (409
   * `approval_not_stuck`). Ends as `failed` (`abandoned`): the record is
   * unlocked and the requester told. Approval.abandon.
   */
  async abandon(
    principal: Principal,
    id: string,
    reason?: string,
    ip?: string,
    ifMatch?: string,
  ) {
    this.assertNotImpersonating(principal);
    const row = await this.engine.run(async (after) => {
      const locked = await this.locked(principal, id, ifMatch);
      if (!(await this.access.can(principal, 'abandon', 'Approval', locked))) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: this.engine.text('notOverseer'),
        });
      }
      const instance = await this.workflows.getStatus(approvalWorkflowId(id));
      const live = instance && LIVE_WORKFLOW.includes(instance.status);
      if (locked.status !== 'approved' || locked.outcomeAppliedAt || live) {
        throw this.engine.problem(
          HttpStatus.CONFLICT,
          'approval_not_stuck',
          'notStuck',
          {
            requestStatus: locked.status,
            ...(instance && { workflowStatus: instance.status }),
          },
        );
      }
      return this.engine.end(after, locked, 'failed', principal, {
        reason: 'abandoned',
        comment: reason,
        ip,
      });
    });
    await this.engine.conclude(id, 'failed', row.round);
    return this.detail(principal, id);
  }
}

/** A request as lists show it. */
export function view(row: ApprovalRequestRow): ApprovalView {
  const stage = row.policy.stages[row.currentStage];
  return {
    id: row.id,
    key: `${row.subject}.${row.action}`,
    subject: row.subject,
    recordId: row.recordId,
    action: row.action,
    status: row.status,
    requester: row.requester,
    requesterName: row.requesterName,
    title: row.title,
    link: row.link,
    payload: row.payload,
    policyVersion: row.policyVersion,
    round: row.round,
    currentStage: row.currentStage,
    stageCount: row.policy.stages.length,
    stageName: stage?.name ?? '',
    dueAt: row.dueAt?.toISOString() ?? null,
    comment: row.comment,
    outcomeReason: row.outcomeReason,
    endedAt: row.endedAt?.toISOString() ?? null,
    outcomeAppliedAt: row.outcomeAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
