import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { REPORT_RUNNER_JOB } from './reports.permissions.js';
import { isRefusal, ReportsService } from './reports.service.js';

/** At most this many reports start in one run; the rest start in the next. */
const BATCH = 500;

/**
 * Starts the reports that are due, every hour at :10, on one instance, one
 * tenant at a time (`Tenancy.forEachTenant()`): each as its owner, checked
 * again (a deactivated owner's reports, or ones they may no longer export,
 * are made inactive), its next run computed from this run's moment, so an
 * hour missed (downtime) runs once, not twice. The runner is
 * `system:report-runner`: the actor of what it does itself (skipping,
 * deactivating). `run(now)` lets a test choose the moment; it returns how
 * many started.
 */
@Injectable()
export class ReportsRunner {
  private readonly logger = new Logger('Reports');

  constructor(
    private readonly reports: ReportsService,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('10 * * * *', { name: 'report-runner', timeZone: 'UTC' })
  @OnOneInstance({ key: 'report-runner' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const started = await this.tenancy.forEachTenant(
      REPORT_RUNNER_JOB.key,
      () => this.runTenant(now),
    );
    return [...started.values()].reduce((sum, count) => sum + count, 0);
  }

  private runTenant(now: Date) {
    return this.system.run(
      REPORT_RUNNER_JOB,
      async (system) => {
        const due = await this.reports.due(now, BATCH);
        let started = 0;
        for (const report of due) {
          const owner = await this.reports.owner(report);
          if (!owner) {
            await this.reports.deactivate(report, 'owner_inactive', system);
            continue;
          }
          if (!(await this.reports.mayRun(owner, report.exporter))) {
            await this.reports.deactivate(report, 'export_not_allowed', system);
            continue;
          }
          try {
            // Null: another run claimed it first.
            if (
              await this.reports.start(owner, report, {
                trigger: 'schedule',
                now,
              })
            ) {
              started++;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (isRefusal(error)) {
              // Its filters no longer parse (the list changed): waiting won't help.
              await this.reports.skip(report, now, message, system);
            } else {
              // Redis or the database away: tried again next hour.
              this.logger.error('A report could not start', {
                report: report.id,
                error: message,
              });
            }
          }
        }
        this.logger.log('Reports started', {
          tenant: this.tenancy.tenantId(),
          due: due.length,
          started,
        });
        return started;
      },
      { transaction: false },
    );
  }
}
