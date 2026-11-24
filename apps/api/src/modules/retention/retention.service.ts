import { TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { onceJob } from '../../core/queues/queues.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal, SystemPrincipal } from '../../iam/auth/principal.js';
import { RecordPurges } from './record-purge.js';
import { RETENTION_JOB } from './retention.permissions.js';
import { type RetentionRule, RetentionRules } from './retention.rules.js';
import type { SetRetentionDto } from './retention.schemas.js';
import { RetentionRepository } from './retention.repository.js';

/** The retention queue. */
export const RETENTION_QUEUE = 'retention';

/** Rows purged or anonymised per job: short transactions, short locks. */
export const RETENTION_BATCH = 500;

const DAY = 86_400_000;

/** One batch of one rule; the tenant comes with the envelope. */
export interface RetentionJob {
  /** The rule's name: `note`. */
  rule: string;
  /** The night's UTC day (`2026-11-25`): with the rule and tenant, the run's job ids. */
  day: string;
  /** This batch's place in the run: 0 for the first. */
  batch?: number;
  /** Rows handled by the earlier batches of this run. */
  total?: number;
}

/**
 * A batch's job id, from the work: the tenant, the rule, the night and the
 * batch's place. The scheduler run again that night, or a batch retried
 * after it queued its next, queues nothing new.
 */
const retentionJobId = (job: RetentionJob & TenantEnvelope) =>
  `retention-${job.tenantId}-${job.rule}-${job.day}-${job.batch ?? 0}`;

/** What one batch did. */
export interface RetentionBatch {
  /** Rows purged or anonymised. */
  count: number;
  /** Due rows left alone because of a legal hold (first batch only). */
  held?: number;
  /** Another batch is due. */
  more: boolean;
}

/**
 * Retention (README.md): the declared rules (RetentionRules), each
 * tenant's choice of days, and the work. The work is heavy and destructive,
 * so never in a request: the nightly RetentionScheduler queues one job per
 * tenant and enabled rule, and each job handles one batch of
 * RETENTION_BATCH rows and queues the next.
 *
 * - **Legal holds win:** a held record is left out of the batch's SQL
 *   (`notHeld`), and checked again, locked, inside the batch's transaction.
 * - **Resumable:** a purged or anonymised row leaves the rule's condition,
 *   so a job that dies is retried and the next night finds what is left.
 * - **Audited:** each batch's transaction writes `retention.purged` or
 *   `retention.anonymised` as `system:retention`, in the tenant's log; a
 *   tenant's choice is `retention.policy-changed`.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly repository: RetentionRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly rules: RetentionRules,
    private readonly purges: RecordPurges,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    @InjectQueue(RETENTION_QUEUE)
    private readonly queue: Queue<RetentionJob & TenantEnvelope>,
  ) {}

  private find(name: string) {
    const rule = this.rules.find(name);
    if (!rule) {
      throw new NotFoundException(`Retention rule "${name}" not found.`);
    }
    return rule;
  }

  /** The declared rules with this tenant's choice for each. */
  async list() {
    const policies = await this.repository.policies();
    const byRule = new Map(policies.map((policy) => [policy.rule, policy]));
    return {
      items: this.rules.all().map((rule) => {
        const policy = byRule.get(rule.name);
        return {
          name: rule.name,
          label: rule.label,
          subject: rule.subject,
          action: rule.action,
          defaultDays: rule.defaultDays,
          minDays: rule.minDays ?? 1,
          enabled: policy?.enabled ?? false,
          days: policy?.days ?? rule.defaultDays,
          lastRunAt: policy?.lastRunAt?.toISOString() ?? null,
          lastCount: policy?.lastCount ?? null,
        };
      }),
    };
  }

  /** The days a rule may not go below, as a 400 `validation_failed`. */
  private assertDays(rule: RetentionRule, days: number | undefined) {
    const minimum = rule.minDays ?? 1;
    if (days !== undefined && days < minimum) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: [
          {
            path: 'days',
            message: `${rule.label} are kept at least ${minimum} days.`,
          },
        ],
      });
    }
  }

  /** Turns a rule on or off for this tenant, and sets its days (not below the rule's minimum). */
  async set(
    principal: Principal,
    name: string,
    dto: SetRetentionDto,
    ip?: string,
  ) {
    const rule = this.find(name);
    this.assertDays(rule, dto.days);
    await this.txHost.withTransaction(async () => {
      const before = await this.repository.findPolicy(name);
      const days = dto.days ?? before?.days ?? rule.defaultDays;
      await this.repository.savePolicy(name, days, dto.enabled);
      await this.audit.record(principal, {
        action: 'retention.policy-changed',
        targetType: 'retentionRule',
        targetId: name,
        details: {
          from: before ? { enabled: before.enabled, days: before.days } : null,
          to: { enabled: dto.enabled, days },
        },
        ip,
      });
    });
    return (await this.list()).items.find((item) => item.name === name)!;
  }

  /**
   * A dry run: what a run would purge or anonymise in this tenant now, and
   * what a legal hold would keep. `days` tries other days than the ones in
   * force. Changes nothing.
   */
  async preview(name: string, days?: number) {
    const rule = this.find(name);
    this.assertDays(rule, days);
    const policy = await this.repository.findPolicy(name);
    const used = days ?? policy?.days ?? rule.defaultDays;
    const before = new Date(Date.now() - used * DAY);
    const counted = await this.repository.countDue(rule, before);
    return { name, days: used, before: before.toISOString(), ...counted };
  }

  /**
   * Queues a first batch for every tenant's enabled rule: what the
   * scheduler runs. Returns how many jobs it queued.
   */
  async schedule(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const perTenant = await this.tenancy.forEachTenant(
      RETENTION_JOB.key,
      async () => {
        let queued = 0;
        for (const rule of await this.repository.enabledRules()) {
          if (!this.rules.find(rule)) {
            continue; // a rule no longer declared
          }
          const job = withTenant({ rule, day });
          await this.queue.add('batch', job, onceJob(retentionJobId(job)));
          queued++;
        }
        return queued;
      },
      // A deactivated tenant's old records still age out.
      { includeInactive: true },
    );
    let queued = 0;
    for (const count of perTenant.values()) {
      queued += count;
    }
    if (queued > 0) {
      this.logger.log(`Retention queued for ${queued} rule(s)`);
    }
    return queued;
  }

  /** Queues the next batch of a job's rule, in its tenant. */
  queueNext(job: RetentionJob & TenantEnvelope, total: number) {
    const next = { ...job, batch: (job.batch ?? 0) + 1, total };
    return this.queue.add('batch', next, onceJob(retentionJobId(next)));
  }

  /**
   * One batch of `rule` in the current tenant, as `system`: the due rows
   * (older than the tenant's days, not held, still pending) purged or
   * anonymised in one transaction with their audit entry. Does nothing for
   * a rule the tenant has turned off since it was queued.
   */
  async batch(
    system: SystemPrincipal,
    rule: RetentionRule,
    first: boolean,
  ): Promise<RetentionBatch> {
    const policy = await this.repository.findPolicy(rule.name);
    if (!policy?.enabled) {
      return { count: 0, more: false };
    }
    const cutoff = new Date(Date.now() - policy.days * DAY);
    // Counted before the first batch only: how many due rows a hold keeps.
    const held = first
      ? (await this.repository.countDue(rule, cutoff)).held
      : undefined;
    const done = await this.txHost.withTransaction(async () => {
      // Locked, and checked for holds in the same statement.
      const ids = await this.repository.lockDue(rule, cutoff, RETENTION_BATCH);
      if (ids.length === 0) {
        return { count: 0, more: false };
      }
      if (rule.action === 'purge') {
        await this.purges.forget(rule.subject, ids);
        await this.repository.deleteRows(rule, ids);
      } else {
        await this.repository.anonymiseRows(rule, ids);
      }
      await this.audit.record(system, {
        action:
          rule.action === 'purge' ? 'retention.purged' : 'retention.anonymised',
        targetType:
          rule.subject.charAt(0).toLowerCase() + rule.subject.slice(1),
        details: { rule: rule.name, ids, retentionDays: policy.days },
      });
      return { count: ids.length, more: ids.length === RETENTION_BATCH };
    });
    if ((held ?? 0) > 0) {
      this.logger.warn('Records kept by a legal hold', {
        rule: rule.name,
        tenant: requireTenantId(),
        held,
      });
    }
    return { ...done, held };
  }

  /** Records a finished run on the tenant's policy. */
  async finish(rule: RetentionRule, total: number) {
    await this.repository.finish(rule.name, total);
  }
}
