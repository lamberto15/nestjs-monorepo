import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ApprovalsRepository } from './approvals.repository.js';

const JOB = 'approvals.metrics';
/**
 * A reading older than this (four of the job's 15-second ticks) is left
 * out: this instance no longer owns the job, and its last reading would
 * stand beside the new owner's.
 */
const STALE_MS = 60_000;

/**
 * Two gauges (core/metrics), across every tenant:
 *
 * - `approvals_overdue_seconds`: how far the most overdue pending stage is
 *   past its deadline (0: none). A stage past its deadline is expired by its
 *   workflow within a poll, so a value that stays means the workflows aren't
 *   running.
 * - `approvals_unapplied_seconds`: how long the oldest approved request has
 *   waited for its outcome to be applied (0: none).
 *
 * Every tenant's requests need the maintenance role, which `Tenancy.acrossTenants()`
 * refuses inside a request, so a job reads them every 15 seconds on one
 * instance (a worker: core/locks), not a timer on every one, and a collection
 * reports its last reading. Only the instance that read reports the gauges
 * (they appear on its first reading); without the maintenance role they
 * stay out. Aggregate with max().
 */
@Injectable()
export class ApprovalMetrics {
  private readonly logger = new Logger('ApprovalMetrics');
  private reading?: { overdue: number; unapplied: number; at: number };
  private collecting = false;

  constructor(
    private readonly metrics: MetricsService,
    private readonly tenancy: Tenancy,
    private readonly repository: ApprovalsRepository,
  ) {}

  /** The gauges, once this instance has read them: the others report none. */
  private collect() {
    if (this.collecting) return;
    this.collecting = true;
    const read = () => {
      if (!this.reading || Date.now() - this.reading.at > STALE_MS) {
        throw new Error('no recent reading');
      }
      return this.reading;
    };
    this.metrics.collect(
      'approvals_overdue_seconds',
      'How far the most overdue pending approval stage is past its deadline (0: none).',
      () => [{ value: read().overdue }],
      's',
    );
    this.metrics.collect(
      'approvals_unapplied_seconds',
      'How long the oldest approved request has waited for its outcome to be applied (0: none).',
      () => [{ value: read().unapplied }],
      's',
    );
  }

  @Cron('*/15 * * * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'approvals:metrics' })
  @WithoutOverlapping()
  async refresh() {
    try {
      this.reading = await this.tenancy.acrossTenants(JOB, async () => {
        const overdue = await this.repository.overdueSeconds();
        // Approved, its outcome not applied yet: the workflow applies it
        // within minutes, or fails it; one that stays is stuck.
        const unapplied = await this.repository.unappliedSeconds();
        return {
          overdue: overdue ?? 0,
          unapplied: unapplied ?? 0,
          at: Date.now(),
        };
      });
      this.collect();
    } catch (error) {
      // Absent, not a 0: the alerts read absence as "could not be read".
      this.reading = undefined;
      this.logger.warn(`Approval gauges not read: ${(error as Error).message}`);
    }
  }
}
