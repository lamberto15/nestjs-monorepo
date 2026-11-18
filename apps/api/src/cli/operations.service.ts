import { Injectable } from '@nestjs/common';
import { SystemContext } from '../iam/access/system-context.js';
import { AuditService } from '../iam/audit/audit.service.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { OpsBacklog } from '../modules/ops/ops.backlog.js';
import { SettingsService } from '../modules/settings/settings.service.js';
import { Accounts } from './accounts.service.js';
import { OPS_JOB } from './cli.jobs.js';
import { by, CliError, type Plan } from './plan.js';

/** Rows one settle pass takes: bounded statements, however big the backlog. */
const SETTLE_CHUNK = 1_000;

/** Which backlog a command acts on: one tenant (id or slug) or all of them. */
export interface BacklogOptions {
  tenant?: string;
  global?: boolean;
  topic?: string;
  template?: string;
  before?: string;
}

const dateOf = (text: string | undefined) => {
  if (!text) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new CliError(`"${text}" is not a date (2026-10-01T00:00:00Z).`);
  }
  return date;
};

/**
 * The operator commands that act through other modules' services (settings,
 * notifications, the ops backlog), as plans: shown, confirmed, applied as
 * `system:ops` with the audit entry naming the operator. It lives in
 * src/cli because it composes the app; it uses only what those modules export.
 */
@Injectable()
export class Operations {
  constructor(
    private readonly accounts: Accounts,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly backlog: OpsBacklog,
  ) {}

  /** Removes a stored setting value (a tenant's, or the platform's) to recover from a bad one. */
  async settingDelete(
    key: string,
    where: { tenant?: string; platform?: boolean },
  ): Promise<Plan<void>> {
    if (Boolean(where.tenant) === Boolean(where.platform)) {
      throw new CliError(
        'Name where: --tenant <id|slug> or --platform (exactly one).',
      );
    }
    const tenant = where.tenant
      ? await this.accounts.tenant(where.tenant)
      : undefined;
    const scope = tenant ? `tenant "${tenant.slug}"` : 'the platform';
    return {
      summary: [
        `Delete the stored value of "${key}" for ${scope}: the next scope's value, or the default, holds again.`,
      ],
      apply: (operator) =>
        this.system.run(
          OPS_JOB,
          async (system) => {
            try {
              if (tenant) {
                await this.settings.unset(system, key, 'tenant', undefined);
              } else {
                await this.settings.unsetPlatform(system, key);
              }
            } catch (error) {
              throw new CliError(
                error instanceof Error ? error.message : String(error),
              );
            }
            await this.audit.record(system, {
              action: 'ops.setting-deleted',
              targetType: 'setting',
              targetId: key,
              details: { scope: tenant?.slug ?? 'platform', ...by(operator) },
            });
          },
          { tenantId: tenant?.id ?? null },
        ),
    };
  }

  /** Every tenant: a person's notifications are per tenant. */
  private async tenantIds() {
    return (await this.accounts.tenantList()).map((tenant) => tenant.id);
  }

  /**
   * Drops a person's undelivered notification backlog in every tenant: no
   * push, mail or webhook goes out for it; mandatory types stay.
   */
  async notificationsSettle(
    emailInput: string,
    options: { before?: string },
  ): Promise<Plan<{ messages: number; notifications: number }>> {
    const user = await this.accounts.userByEmail(emailInput);
    const recipient = `user:${user.id}`;
    const before = dateOf(options.before);
    const tenantIds = await this.tenantIds();
    const found = { messages: 0, notifications: 0 };
    for (const tenantId of tenantIds) {
      const part = await this.system.run(
        OPS_JOB,
        () => this.notifications.backlog(recipient, before),
        { tenantId },
      );
      found.messages += part.messages;
      found.notifications += part.notifications;
    }
    return {
      summary: [
        `Delete ${found.messages} pending delivery message(s) of ${user.email}${before ? ` created before ${before.toISOString()}` : ''}, and mark ${found.notifications} notification(s) delivered and read: no push or mail goes out for them.`,
        'Mandatory (security) notification types are not touched.',
      ],
      apply: async (operator) => {
        const settled = { messages: 0, notifications: 0 };
        for (const tenantId of tenantIds) {
          for (;;) {
            const chunk = await this.system.run(
              OPS_JOB,
              () => this.notifications.settle(recipient, before, SETTLE_CHUNK),
              { tenantId },
            );
            settled.messages += chunk.messages;
            settled.notifications += chunk.notifications;
            if (chunk.notifications === 0) break;
          }
        }
        await this.system.run(
          OPS_JOB,
          (system) =>
            this.audit.record(system, {
              action: 'ops.notifications-settled',
              targetType: 'user',
              targetId: user.id,
              details: {
                ...settled,
                ...(before && { before }),
                ...by(operator),
              },
            }),
          { tenantId: null },
        );
        return settled;
      },
    };
  }

  private async scope(options: BacklogOptions) {
    if (Boolean(options.tenant) === Boolean(options.global)) {
      throw new CliError(
        'Name the scope: --tenant <id|slug> or --global (exactly one).',
      );
    }
    const tenant = options.tenant
      ? await this.accounts.tenant(options.tenant)
      : undefined;
    return {
      tenant,
      scope: {
        ...(tenant ? { tenantId: tenant.id } : { global: true as const }),
        topic: options.topic,
        template: options.template,
        before: dateOf(options.before),
      },
    };
  }

  /** What the backlog commands would touch, counted. */
  async backlogCount(options: BacklogOptions) {
    return this.backlog.preview((await this.scope(options)).scope);
  }

  /** Discards or retries the outbox or mail backlog, in batches, audited. */
  async backlogAction(
    action: 'discard' | 'retry',
    target: string,
    options: BacklogOptions,
  ): Promise<Plan<{ count: number; more: boolean }>> {
    if (target !== 'outbox' && target !== 'mail') {
      throw new CliError('The target is outbox or mail.');
    }
    const { tenant, scope } = await this.scope(options);
    const verb = action === 'discard' ? 'Discard' : 'Retry';
    return {
      summary: [
        `${verb} the ${target} backlog of ${tenant ? `tenant "${tenant.slug}"` : 'every tenant'}${scope.topic ? `, topic ${scope.topic}` : ''}${scope.template ? `, mail ${scope.template}` : ''}${scope.before ? `, created before ${scope.before.toISOString()}` : ''}.`,
        action === 'discard'
          ? 'Never touched: what is being delivered now, running jobs, essential mail.'
          : 'Dead letters (outbox) or failed jobs (mail) run again.',
      ],
      apply: async (operator) => {
        const result =
          action === 'discard'
            ? await this.backlog.discard(target, scope)
            : await this.backlog.retry(target, scope);
        await this.system.run(
          OPS_JOB,
          (system) =>
            this.audit.record(system, {
              action: `ops.backlog-${action === 'discard' ? 'discarded' : 'retried'}`,
              targetType: target,
              details: {
                scope: tenant?.slug ?? 'global',
                ...result,
                ...by(operator),
              },
            }),
          { tenantId: tenant?.id ?? null },
        );
        return result;
      },
    };
  }
}
