import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { WorkflowClient } from '@nestjs/workflows';
import { workflowsConfig } from './workflows.config.js';

/**
 * Deletes workflow instances that finished (completed, failed, cancelled)
 * more than WORKFLOWS_RETENTION_DAYS ago, with their journals, the signals
 * no unfinished instance can take and the ended rate-limit windows, every
 * night at 04:25 UTC, on one instance (`WorkflowClient.purge()`; the package
 * never ages them out itself). Unfinished instances and `compensation_failed`
 * ones (they wait for a person) stay. A signal's id deduplicates until it is
 * purged: the days outlast every transaction, and the app's signals are sent
 * in the transaction of the change, never redelivered.
 */
@Injectable()
export class WorkflowsRetentionJob {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(workflowsConfig.KEY)
    private readonly config: ConfigType<typeof workflowsConfig>,
    private readonly workflows: WorkflowClient,
  ) {}

  /** Returns how many instances, signals and rate-limit windows were deleted. */
  @Cron('25 4 * * *', { name: 'workflows-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'workflows:retention' })
  @WithoutOverlapping()
  async run() {
    const purged = await this.workflows.purge({
      olderThan: `${this.config.retentionDays}d`,
    });
    this.logger.log(
      `Old workflow records deleted: ${purged.instances} instances, ${purged.signals} signals, ${purged.rateLimits} rate-limit windows.`,
    );
    return purged;
  }
}
