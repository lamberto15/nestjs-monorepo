import { createHash } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { Counter as MetricCounter } from '@opentelemetry/api';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { messagingConfig } from './messaging.config.js';
import {
  allowedPrefix,
  smsCost,
  utcDay,
  utcMonthStart,
} from './messaging.policy.js';
import { messagingUsage } from './messaging.tables.js';

/** Why an SMS was not sent. */
export type SmsBlock =
  | 'prefix_not_allowed'
  | 'tenant_limit'
  | 'prefix_limit'
  | 'user_limit'
  | 'ip_limit'
  | 'budget_exceeded';

/** The share of the monthly budget at which the alert is raised. */
const BUDGET_WARNING = 0.8;

const SPEND_COUNTER = 'spend';

/** One counter a send takes from: its row (`day`, `counter`), the cap, and how much one send adds. */
interface Counter {
  day: string;
  counter: string;
  limit: number;
  reason: SmsBlock;
  step?: number;
}

/** Rolls the reservation's transaction back when a cap is hit. */
class CapHit extends Error {
  constructor(readonly reason: SmsBlock) {
    super(reason);
  }
}

/**
 * The toll-fraud caps of SMS (docs/notifications.md, "Push and SMS"), checked
 * by the worker just before each send, in the job's tenant:
 *
 * - the destination must start with an allowed prefix (SMS_ALLOWED_PREFIXES);
 * - per day (UTC), at most SMS_DAILY_LIMIT_PER_TENANT in the tenant,
 *   SMS_DAILY_LIMIT_PER_PREFIX to one prefix in it, and
 *   SMS_DAILY_LIMIT_PER_USER to one user;
 * - per UTC month, spend within SMS_MONTHLY_BUDGET_MINOR (the segments of the
 *   text times the prefix's price, SMS_PRICES), logged as an error when it
 *   passes 80 %;
 * - per client IP, at most SMS_DAILY_LIMIT_PER_IP codes a day (`reserveIp`,
 *   asked when the code is requested).
 *
 * The counters are incremented in one transaction with an atomic upsert, so
 * the caps hold under concurrent workers, and the transaction rolls back
 * when one is hit: a refused SMS uses none of the allowance. A refusal is
 * counted apart (`blocked:<reason>`), which the metrics show, and logged as
 * an error: the signal to alert on.
 */
@Injectable()
export class MessagingLimits {
  private readonly logger = new Logger('Messaging');

  private readonly sent: MetricCounter;
  private readonly spend: MetricCounter;
  private readonly blocked: MetricCounter;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @Inject(messagingConfig.KEY)
    private readonly config: ConfigType<typeof messagingConfig>,
    metrics: MetricsService,
  ) {
    this.sent = metrics.counter('sms_sent', {
      description:
        'SMS reserved against the toll-fraud caps (every tenant), by this process.',
    });
    this.spend = metrics.counter('sms_spend_minor', {
      description:
        'SMS spend of every tenant, in minor units of the price table, by this process.',
    });
    this.blocked = metrics.counter('sms_blocked', {
      description:
        'SMS refused by the toll-fraud caps or the country allowlist, by reason. Alert on it rising.',
    });
  }

  /** The allowed prefix of `phone`, or null. */
  prefixOf(phone: string) {
    return allowedPrefix(phone, this.config.sms.allowedPrefixes);
  }

  /**
   * Takes one SMS from today's allowance and the month's budget: `{ ok: true }`,
   * or the reason it may not go. Call it right before sending, with the text
   * (its length sets the cost).
   */
  async reserve(
    userId: string,
    phone: string,
    text: string,
    now = new Date(),
  ): Promise<{ ok: true } | { ok: false; reason: SmsBlock }> {
    const prefix = this.prefixOf(phone);
    if (!prefix) {
      await this.countBlocked('prefix_not_allowed', now);
      return { ok: false, reason: 'prefix_not_allowed' };
    }
    const day = utcDay(now);
    const sms = this.config.sms;
    const counters: Counter[] = [
      {
        day,
        counter: 'tenant',
        limit: sms.dailyLimitPerTenant,
        reason: 'tenant_limit',
      },
      {
        day,
        counter: `prefix:${prefix}`,
        limit: sms.dailyLimitPerPrefix,
        reason: 'prefix_limit',
      },
      {
        day,
        counter: `user:${userId}`,
        limit: sms.dailyLimitPerUser,
        reason: 'user_limit',
      },
    ];
    const budget = sms.monthlyBudgetMinor;
    const cost = smsCost(text, prefix, sms.prices, sms.priceDefaultMinor);
    if (budget > 0 && cost > 0) {
      counters.push({
        day: utcMonthStart(now),
        counter: SPEND_COUNTER,
        limit: budget,
        reason: 'budget_exceeded',
        step: cost,
      });
    }
    let spent: number | undefined;
    try {
      await this.txHost.withTransaction(async () => {
        for (const entry of counters) {
          const count = await this.increment(entry);
          if (count > entry.limit) {
            throw new CapHit(entry.reason);
          }
          if (entry.counter === SPEND_COUNTER) spent = count;
        }
      });
    } catch (error) {
      if (error instanceof CapHit) {
        await this.countBlocked(error.reason, now);
        return { ok: false, reason: error.reason };
      }
      throw error;
    }
    this.sent.add(1);
    this.spend.add(cost);
    if (
      spent !== undefined &&
      spent >= budget * BUDGET_WARNING &&
      spent - cost < budget * BUDGET_WARNING
    ) {
      // Crossed on this send: said once a month per tenant.
      this.logger.error('SMS spend passed 80 % of the monthly budget', {
        spent,
        budget,
      });
    }
    return { ok: true };
  }

  /**
   * Takes one code from the client IP's allowance for today (the IP is kept
   * only hashed): false when the cap is used up. Asked when a number is set,
   * so the refusal reaches the person in the request.
   */
  async reserveIp(ip: string, now = new Date()): Promise<boolean> {
    const limit = this.config.sms.dailyLimitPerIp;
    const counter = `ip:${createHash('sha256').update(ip).digest('hex').slice(0, 24)}`;
    try {
      await this.txHost.withTransaction(async () => {
        const count = await this.increment({
          day: utcDay(now),
          counter,
          limit,
          reason: 'ip_limit',
        });
        if (count > limit) throw new CapHit('ip_limit');
      });
    } catch (error) {
      if (error instanceof CapHit) {
        await this.countBlocked('ip_limit', now);
        return false;
      }
      throw error;
    }
    return true;
  }

  /** The counter after adding `step` (default 1): an atomic upsert. */
  private async increment({
    day,
    counter,
    step = 1,
  }: Counter): Promise<number> {
    const [row] = await this.db
      .insert(messagingUsage)
      .values({ day, counter, count: step })
      .onConflictDoUpdate({
        target: [
          messagingUsage.tenantId,
          messagingUsage.day,
          messagingUsage.counter,
        ],
        set: { count: sql`${messagingUsage.count} + ${step}` },
      })
      .returning({ count: messagingUsage.count });
    return row?.count ?? 0;
  }

  /** Counts a refusal and logs it as an error (what an alert reads). */
  private async countBlocked(reason: SmsBlock, now: Date) {
    this.logger.error('SMS blocked by the toll-fraud caps', { reason });
    this.blocked.add(1, { reason });
    await this.db
      .insert(messagingUsage)
      .values({ day: utcDay(now), counter: `blocked:${reason}`, count: 1 })
      .onConflictDoUpdate({
        target: [
          messagingUsage.tenantId,
          messagingUsage.day,
          messagingUsage.counter,
        ],
        set: { count: sql`${messagingUsage.count} + 1` },
      });
  }
}
