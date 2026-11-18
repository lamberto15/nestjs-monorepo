import {
  StepFailedError,
  Workflow,
  type WorkflowContext,
  type WorkflowRetryOptions,
} from '@nestjs/workflows';
import { TenantWorkflow } from '../../core/workflows/tenant-workflow.js';
import { SystemContext } from '../../iam/access/system-context.js';
import {
  ApprovalEngine,
  type ApprovalPlan,
  type Ending,
} from './approval-engine.service.js';
import {
  APPROVALS_JOB,
  requestCancelled,
  requestResubmitted,
  stageDecided,
} from './approvals.events.js';
import { APPROVAL_STATUSES } from './approvals.tables.js';

type StagePlan = ApprovalPlan['stages'][number];

/**
 * The effect's retries (it calls the feature, maybe another system): eight
 * attempts over about twenty minutes before the request fails as
 * `apply_failed`.
 */
const APPLY_RETRY: WorkflowRetryOptions = {
  attempts: 8,
  backoff: { delay: '10s', factor: 2, maxDelay: '1h' },
};

/** A step's answer that is a request's status: the workflow concludes with it. */
const isEnding = (answer: string): answer is Ending =>
  answer !== 'pending' &&
  (APPROVAL_STATUSES as readonly string[]).includes(answer);

/**
 * One instance per request (`approval-<request id>`): the process from the
 * first stage to the outcome, durable across restarts. People's decisions
 * are made in their requests (ApprovalsService decides a stage under the
 * request's row lock, so two approvers can't both win) and reach the
 * instance as signals; the instance owns time and effects: it starts each
 * stage, reminds, escalates, expires and applies the outcome, each in a
 * step. Names carry the round and the stage, so a resubmitted request
 * journals each round apart. A step runs at least once, so each answers
 * from the request's state: what it did, or the status the request has now.
 */
@Workflow('approval')
export class ApprovalWorkflow extends TenantWorkflow<
  { requestId: string },
  { status: Ending | 'gone' }
> {
  constructor(
    private readonly engine: ApprovalEngine,
    private readonly system: SystemContext,
  ) {
    super();
  }

  /** A step's work as `system:approvals`; the engine opens its own transactions. */
  private asSystem<T>(work: () => Promise<T>): Promise<T> {
    return this.system.run(APPROVALS_JOB, work, { transaction: false });
  }

  async execute(
    ctx: WorkflowContext,
    { requestId }: { requestId: string },
  ): Promise<{ status: Ending | 'gone' }> {
    const plan = await ctx.step('plan', () =>
      this.asSystem(() => this.engine.plan(requestId)),
    );
    if (!plan) return { status: 'gone' }; // purged with its record
    for (let round = 0; ; round++) {
      let ending: Ending | 'gone' = 'approved';
      for (let stage = 0; stage < plan.stages.length; stage++) {
        ctx.setStatus({ round, stage });
        const started = await ctx.step(`start-${round}-${stage}`, () =>
          this.asSystem(() => this.engine.startStage(requestId, round, stage)),
        );
        if (started === 'gone' || isEnding(started)) {
          ending = started;
          break;
        }
        const outcome = await this.stage(
          ctx,
          requestId,
          round,
          stage,
          plan.stages[stage]!,
        );
        if (outcome !== 'approved') {
          ending = outcome;
          break;
        }
      }
      if (ending === 'gone') return { status: 'gone' };
      ctx.setStatus({ round, ending });
      const concluded = await this.conclude(ctx, requestId, round, ending);
      if (concluded !== 'changes_requested') return { status: concluded };
      // Back to the requester: they resubmit (a new round), cancel, or let it expire.
      const next = await this.resubmission(ctx, requestId, round, plan);
      if (next === 'gone') return { status: 'gone' };
      if (next !== 'resubmitted') {
        const final = await ctx.step(
          `conclude-${round}-${next}`,
          () =>
            this.asSystem(() => this.engine.conclude(requestId, next, round)),
          { retry: APPLY_RETRY },
        );
        return { status: final };
      }
    }
  }

  /** Applies the outcome; when its attempts run out the request fails (`apply_failed`). */
  private async conclude(
    ctx: WorkflowContext,
    requestId: string,
    round: number,
    status: Ending,
  ): Promise<Ending | 'gone'> {
    try {
      return await ctx.step(
        `conclude-${round}`,
        () =>
          this.asSystem(() => this.engine.conclude(requestId, status, round)),
        { retry: APPLY_RETRY },
      );
    } catch (error) {
      if (!(error instanceof StepFailedError)) throw error; // the engine's own control flow
      const failed = await ctx.step(`apply-failed-${round}`, () =>
        this.asSystem(() => this.engine.applyFailed(requestId, round)),
      );
      if (failed !== 'failed') {
        return failed === 'gone' || failed === 'raced' ? 'gone' : failed;
      }
      return ctx.step(
        `conclude-${round}-apply-failed`,
        () =>
          this.asSystem(() => this.engine.conclude(requestId, 'failed', round)),
        { retry: APPLY_RETRY },
      );
    }
  }

  /** Waits for a stage's outcome, reminding and handling the deadline on the way. */
  private async stage(
    ctx: WorkflowContext,
    requestId: string,
    round: number,
    stage: number,
    plan: StagePlan,
  ): Promise<Ending | 'gone'> {
    const name = `${round}-${stage}`;
    const ends = () => ({
      decided: ctx.signalWait(stageDecided, {
        key: `${requestId}:${round}:${stage}`,
      }),
      cancelled: ctx.signalWait(requestCancelled, { key: requestId }),
    });
    const ended = (result: { key: string; value: unknown }): Ending =>
      result.key === 'decided'
        ? (result.value as { outcome: Ending }).outcome
        : 'cancelled';
    // Timers count from the stage's start: journaled, so a replay waits for the same moments.
    const startedAt = ctx.now();
    if (
      plan.remindAfterMs !== null &&
      (plan.dueAfterMs === null || plan.remindAfterMs < plan.dueAfterMs)
    ) {
      const first = await ctx.waitForAny(`await-${name}-reminder`, {
        ...ends(),
        remind: ctx.timer({ until: startedAt + plan.remindAfterMs }),
      });
      if (first.key !== 'remind') return ended(first);
      const reminded = await ctx.step(`remind-${name}`, () =>
        this.asSystem(() => this.engine.remind(requestId, round, stage)),
      );
      if (reminded === 'gone' || isEnding(reminded)) return reminded;
    }
    if (plan.dueAfterMs !== null) {
      const due = await ctx.waitForAny(`await-${name}-due`, {
        ...ends(),
        overdue: ctx.timer({ until: startedAt + plan.dueAfterMs }),
      });
      if (due.key !== 'overdue') return ended(due);
      const overdue = await ctx.step(`overdue-${name}`, () =>
        this.asSystem(() => this.engine.overdue(requestId, round, stage)),
      );
      if (overdue === 'gone' || isEnding(overdue)) return overdue;
      if (overdue === 'escalated' && plan.escalationDueAfterMs !== null) {
        const escalatedAt = ctx.now();
        const late = await ctx.waitForAny(`await-${name}-escalated`, {
          ...ends(),
          overdue: ctx.timer({
            until: escalatedAt + plan.escalationDueAfterMs,
          }),
        });
        if (late.key !== 'overdue') return ended(late);
        const expired = await ctx.step(`expire-${name}`, () =>
          this.asSystem(() => this.engine.expireStage(requestId, round, stage)),
        );
        if (expired === 'gone' || isEnding(expired)) return expired;
      }
      // Raced by a decision (or escalated without a deadline): its signal ends the wait below.
    }
    return ended(await ctx.waitForAny(`await-${name}`, ends()));
  }

  /** After changes were requested: resubmitted, or how it ended (cancelled, expired). */
  private async resubmission(
    ctx: WorkflowContext,
    requestId: string,
    round: number,
    plan: ApprovalPlan,
  ): Promise<'resubmitted' | 'gone' | Ending> {
    const signals = () => ({
      resubmitted: ctx.signalWait(requestResubmitted, {
        key: `${requestId}:${round}`,
      }),
      cancelled: ctx.signalWait(requestCancelled, { key: requestId }),
    });
    const sentBackAt = ctx.now();
    const first = await ctx.waitForAny(`await-resubmit-${round}`, {
      ...signals(),
      expired: ctx.timer({ until: sentBackAt + plan.resubmitWithinMs }),
    });
    if (first.key !== 'expired') return first.key;
    const expired = await ctx.step(`expire-resubmit-${round}`, () =>
      this.asSystem(() => this.engine.expireResubmission(requestId, round)),
    );
    if (expired === 'gone' || isEnding(expired)) return expired;
    // Raced by a resubmission: its signal ends the wait.
    return (await ctx.waitForAny(`await-resubmit-${round}-late`, signals()))
      .key;
  }
}
