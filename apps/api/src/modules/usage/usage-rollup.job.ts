import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { inArray, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '../../core/database/database.js';
import { REDIS } from '../../core/redis/redis.js';
import { redisConfig } from '../../core/redis/redis.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { usageConfig } from './usage.config.js';
import {
  addDays,
  parseUsageKey,
  TOTAL_FIELD,
  usagePattern,
  utcDay,
} from './usage.keys.js';
import { apiUsage } from './usage.tables.js';

/** A live counter: its key (without the Redis prefix), tenant, client and day. */
type UsageKey = {
  key: string;
  tenantId: string;
  clientId: string;
  day: string;
};

/**
 * Copies API clients' daily counters from Redis into `api_usage`, every
 * night at 00:20 UTC on one instance, then deletes the copied counters and
 * the rows older than USAGE_RETENTION_DAYS. Copying sets each row to its
 * counter's value, so an interrupted run can run again, and a day rolled up
 * early (today) is overwritten by the next run. Each counter's key names its
 * tenant: its rows are written in that tenant's scope, one tenant at a time.
 */
@Injectable()
export class UsageRollupJob {
  private readonly logger = new Logger('Usage');

  constructor(
    @Inject(usageConfig.KEY)
    private readonly config: ConfigType<typeof usageConfig>,
    @Inject(redisConfig.KEY)
    private readonly redisSettings: ConfigType<typeof redisConfig>,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
  ) {}

  /**
   * Rolls up `day` (a UTC `yyyy-mm-dd`), or, without one, every day before
   * today still in Redis. Returns the rows written.
   */
  @Cron('20 0 * * *', { name: 'usage-rollup', timeZone: 'UTC' })
  @OnOneInstance({ key: 'usage:rollup' })
  @WithoutOverlapping()
  async run(day?: string, now = new Date()) {
    if (!this.config.enabled) {
      return 0;
    }
    const today = utcDay(now);
    const keys = await this.liveKeys(usagePattern(day));
    const days = day
      ? [day]
      : [...new Set(keys.map((key) => key.day))].filter((d) => d < today);
    let written = 0;
    const failed: unknown[] = [];
    for (const each of days) {
      try {
        written += await this.rollUp(
          each,
          keys.filter((key) => key.day === each),
          now,
        );
      } catch (error) {
        failed.push(error); // the other days and the retention still run
      }
    }
    const cutoff = addDays(today, -this.config.retentionDays);
    try {
      await this.tenancy.forEachTenant(
        'usage-rollup',
        () => this.db.delete(apiUsage).where(lt(apiUsage.day, cutoff)),
        { includeInactive: true },
      );
    } catch (error) {
      failed.push(error);
    }
    this.logger.log(
      `Usage rolled up: ${written} rows over ${days.length} days`,
    );
    if (failed.length > 0) {
      throw failed.length === 1
        ? failed[0]
        : new AggregateError(failed, 'usage-rollup failed');
    }
    return written;
  }

  /** One day's counters into the table, then deleted (not today's, which keep counting), tenant by tenant. */
  private async rollUp(day: string, found: UsageKey[], now: Date) {
    let written = 0;
    // A tenant's failure never stops the others: its counters stay in Redis for the next run.
    const failures: unknown[] = [];
    for (const tenantId of new Set(found.map((key) => key.tenantId))) {
      const ofTenant = found.filter((key) => key.tenantId === tenantId);
      try {
        written += await this.tenancy.run(tenantId, () =>
          this.rollUpTenant(day, ofTenant, now),
        );
      } catch (error) {
        failures.push(error);
        this.logger.error(
          `Usage not rolled up for tenant ${tenantId} on ${day}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `usage-rollup failed on ${day}`);
    }
    return written;
  }

  /** One tenant's counters of a day, in its scope: its clients only. */
  private async rollUpTenant(day: string, found: UsageKey[], now: Date) {
    // Counters of clients that no longer exist are dropped with the rest.
    const existing = new Set(
      (
        await this.db
          .select({ id: apiClients.id })
          .from(apiClients)
          .where(
            inArray(
              apiClients.id,
              found.map((key) => key.clientId),
            ),
          )
      ).map((client) => client.id),
    );
    const pipeline = this.redis.pipeline();
    for (const { key } of found) {
      pipeline.hgetall(key);
    }
    const hashes = (await pipeline.exec()) ?? [];
    const rows = found.flatMap(({ clientId }, index) => {
      const [error, hash] = hashes[index]!;
      if (error) {
        throw error;
      }
      if (!existing.has(clientId)) {
        return [];
      }
      return Object.entries(hash as Record<string, string>)
        .filter(([route]) => route !== TOTAL_FIELD)
        .map(([route, count]) => ({
          clientId,
          day,
          route,
          count: Number(count),
        }));
    });
    // In batches: a parameter list has its limits.
    for (let start = 0; start < rows.length; start += 1000) {
      await this.db
        .insert(apiUsage)
        .values(rows.slice(start, start + 1000))
        .onConflictDoUpdate({
          target: [
            apiUsage.tenantId,
            apiUsage.clientId,
            apiUsage.day,
            apiUsage.route,
          ],
          set: { count: sql`excluded.count`, updatedAt: new Date() },
        });
    }
    // Today's counters keep counting: the rows are a copy, the next run overwrites them.
    if (day < utcDay(now)) {
      await this.redis.del(...found.map(({ key }) => key));
    }
    return rows.length;
  }

  /**
   * The usage keys matching `pattern`, without the Redis prefix. SCAN's
   * pattern and its answers carry the prefix: ioredis's keyPrefix leaves
   * them alone.
   */
  private async liveKeys(pattern: string) {
    const prefix = `${this.redisSettings.prefix}:`;
    const keys: UsageKey[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}${pattern}`,
        'COUNT',
        500,
      );
      cursor = next;
      for (const full of batch) {
        const key = full.slice(prefix.length);
        const parsed = parseUsageKey(key);
        if (parsed) {
          keys.push({ key, ...parsed });
        }
      }
    } while (cursor !== '0');
    return keys;
  }
}
