import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { TransactionHost } from '@nestjs-cls/transactional';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Events, OnDomainEvent } from '../../core/outbox/events.js';
import { SystemContext } from '../../iam/access/system-context.js';
import type { SystemPrincipal } from '../../iam/auth/principal.js';
import {
  type RecordDeclaration,
  type RecordRow,
  recordView,
} from '../records/record.js';
import { type AutomationDue, automationDue } from './automations.events.js';
import { AUTOMATIONS_JOB } from './automations.permissions.js';
import {
  AutomationRefused,
  AutomationsService,
  MAX_ACTIVE_RULES,
  MAX_FAILURES,
  MAX_RUNS_PER_HOUR,
  type Planned,
} from './automations.service.js';
import { AutomationsRepository } from './automations.repository.js';

/**
 * Set while a rule's actions run: the writes they make start no rule
 * (`changed()` skips them), so rules never trigger themselves or each
 * other in a loop. Custom code: the record's domain event can't tell a
 * rule's write from anyone else's, the async context of the write can.
 */
const AUTOMATING = new AsyncLocalStorage<true>();

/**
 * When rules run. A record's write (the hooks of AutomationsModule.forRecord())
 * calls `changed()` in its transaction: each active rule whose trigger
 * holds becomes an `automation.due` event, delivered if and only if the
 * write commits. The worker runs it (`run()`), in the event's tenant, once
 * (the consumer's inbox).
 */
@Injectable()
export class AutomationRunner {
  private readonly logger = new Logger('Automations');

  constructor(
    private readonly repository: AutomationsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly events: Events,
    private readonly automations: AutomationsService,
    private readonly system: SystemContext,
  ) {}

  /**
   * A record was written: queues a run of each active rule of its subject
   * on this trigger (`updated` with a field: only when that field's value
   * changed). Nothing while a rule's own actions write.
   */
  async changed(
    record: RecordDeclaration,
    event: 'created' | 'updated',
    after: RecordRow,
    before?: RecordRow,
  ) {
    if (AUTOMATING.getStore()) return;
    const rules = await this.repository.activeRules(
      record.subject,
      event,
      MAX_ACTIVE_RULES,
    );
    if (!rules.length) return;
    // As the API shows them: a money field is one value there.
    const now = recordView(record, after) as Record<string, unknown>;
    const then =
      before && (recordView(record, before) as Record<string, unknown>);
    for (const rule of rules) {
      if (
        event === 'updated' &&
        rule.field &&
        isDeepStrictEqual(then?.[rule.field], now[rule.field])
      ) {
        continue;
      }
      await this.events.publish(
        automationDue,
        { ruleId: rule.id, version: rule.version, recordId: after.id },
        { key: after.id },
      );
    }
  }

  @OnDomainEvent(automationDue, { consumer: 'automations' })
  run(payload: AutomationDue, ctx: OutboxHandlerContext) {
    return this.system.run(
      AUTOMATIONS_JOB,
      (system) => this.execute(payload, ctx, system),
      { transaction: false },
    );
  }

  /**
   * One rule's run on one record: the rule as it is now (disabled, deleted
   * or changed since: nothing), its owner as they are now (gone: the rule
   * is disabled), the hourly limit, then the evaluator as the owner, and
   * every action in one transaction with the run's record and the inbox.
   * A refusal is a failed run, kept; MAX_FAILURES in a row disable the
   * rule. Anything else (the database away) is retried by the outbox.
   */
  private async execute(
    message: AutomationDue,
    ctx: OutboxHandlerContext,
    system: SystemPrincipal,
  ) {
    const rule = await this.automations.current(message.ruleId);
    if (!rule || rule.status !== 'active' || rule.version !== message.version) {
      return;
    }
    const once = (work: () => Promise<unknown>) =>
      this.txHost.withTransaction(async () => {
        await ctx.processInTransaction(this.txHost.tx, work);
      });
    const disable = (reason: string) =>
      once(() => this.automations.setDisabled(rule, reason, system));
    const target = this.automations.target(rule.subject);
    if (!target) return disable('subject_gone');
    const owner = await this.automations.owner(rule);
    if (!owner) return disable('owner_inactive');
    if ((await this.automations.recentRuns(rule.id)) >= MAX_RUNS_PER_HOUR) {
      return disable('run_limit');
    }
    let planned: Planned[] = [];
    try {
      await once(async () => {
        const { expression } = await this.automations.check(owner, rule);
        const [row] = await this.automations.readable(target, owner, {
          ids: [message.recordId],
          limit: 1,
        });
        // Gone, hidden from the owner, or the condition doesn't hold: no run.
        if (!row || !this.automations.holds(target, expression, row)) return;
        planned = await this.automations.plan(target, owner, rule, row);
        const refused = planned.find((p) => !p.result.allowed);
        if (refused) {
          throw new AutomationRefused(
            `${refused.result.type}: ${refused.result.reason}`,
          );
        }
        await AUTOMATING.run(true, async () => {
          for (const { apply } of planned) await apply?.();
        });
        await this.automations.recordRun(rule, message.recordId, planned, null);
      });
    } catch (error) {
      if (!(
        error instanceof AutomationRefused || error instanceof HttpException
      )) {
        throw error;
      }
      this.logger.warn('An automation rule failed', {
        rule: rule.id,
        record: message.recordId,
        error: error.message,
      });
      await once(async () => {
        const failures = await this.automations.recordRun(
          rule,
          message.recordId,
          planned,
          error.message,
        );
        if (failures >= MAX_FAILURES) {
          await this.automations.setDisabled(rule, 'failing', system);
        }
      });
    }
  }
}
