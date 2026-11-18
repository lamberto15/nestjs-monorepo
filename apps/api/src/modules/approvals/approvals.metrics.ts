import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { queuesConfig, runsWorkers } from '../../core/queues/queues.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { approvalRequests } from './approvals.tables.js';

const JOB = 'approvals.metrics';
/** How often the gauges are read again. */
const EVERY_MS = 15_000;

/**
 * Two gauges on `/metrics`, across every tenant:
 *
 * - `approvals_overdue_seconds`: how far the most overdue pending stage is
 *   past its deadline (0: none). A stage past its deadline is expired by its
 *   workflow within a poll, so a value that stays means the workflows aren't
 *   running.
 * - `approvals_unapplied_seconds`: how long the oldest approved request has
 *   waited for its outcome to be applied (0: none).
 *
 * Every tenant's requests need the maintenance role, which `Tenancy.acrossTenants()`
 * refuses inside a request, so a timer reads them (workers only) and a scrape
 * serves the last reading; without the maintenance role the gauges stay out.
 * Shared state: every worker reports the same, aggregate with max().
 */
@Injectable()
export class ApprovalMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ApprovalMetrics');
  private timer?: NodeJS.Timeout;
  private reading?: { overdue: number; unapplied: number };

  constructor(
    private readonly metrics: MetricsService,
    private readonly tenancy: Tenancy,
    @InjectTransaction() private readonly db: Database,
    @Inject(queuesConfig.KEY)
    private readonly queues: ConfigType<typeof queuesConfig>,
  ) {}

  onModuleInit() {
    if (!runsWorkers(this.queues.role)) {
      return;
    }
    const read = () => {
      if (!this.reading) throw new Error('not read yet');
      return this.reading;
    };
    this.metrics.collect(
      'approvals_overdue_seconds',
      'How far the most overdue pending approval stage is past its deadline (0: none).',
      () => [{ value: read().overdue }],
    );
    this.metrics.collect(
      'approvals_unapplied_seconds',
      'How long the oldest approved request has waited for its outcome to be applied (0: none).',
      () => [{ value: read().unapplied }],
    );
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async refresh() {
    try {
      this.reading = await this.tenancy.acrossTenants(JOB, async () => {
        const [overdue] = await this.db
          .select({
            seconds: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.dueAt})) filter (where ${approvalRequests.dueAt} < now()), 0)::float8`,
          })
          .from(approvalRequests)
          .where(eq(approvalRequests.status, 'pending'));
        // Approved, its outcome not applied yet: the workflow applies it
        // within minutes, or fails it; one that stays is stuck.
        const [unapplied] = await this.db
          .select({
            seconds: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.endedAt})), 0)::float8`,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.status, 'approved'),
              isNull(approvalRequests.outcomeAppliedAt),
            ),
          );
        return {
          overdue: overdue?.seconds ?? 0,
          unapplied: unapplied?.seconds ?? 0,
        };
      });
    } catch (error) {
      // Absent, not a 0: the alerts read absence as "could not be read".
      this.reading = undefined;
      this.logger.warn(`Approval gauges not read: ${(error as Error).message}`);
    }
  }
}
