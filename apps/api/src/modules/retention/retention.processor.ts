import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SystemContext } from '../../iam/access/system-context.js';
import {
  type TenantEnvelope,
  TenantWorkerHost,
} from '../../core/tenancy/tenant-job.js';
import { RETENTION_JOB } from './retention.permissions.js';
import { RetentionRules } from './retention.rules.js';
import {
  RETENTION_QUEUE,
  type RetentionBatch,
  type RetentionJob,
  RetentionService,
} from './retention.service.js';

/**
 * Runs one batch of a retention rule (RetentionService.batch()) in the
 * job's tenant, as `system:retention`, then queues the next batch when
 * there is one. One at a time per worker: background work that may take its
 * time.
 */
@Processor(RETENTION_QUEUE, { concurrency: 1 })
export class RetentionProcessor extends TenantWorkerHost<
  RetentionJob,
  RetentionBatch
> {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly retention: RetentionService,
    private readonly rules: RetentionRules,
    private readonly system: SystemContext,
  ) {
    super();
  }

  async handle(job: Job<RetentionJob & TenantEnvelope>) {
    const { rule: name, total = 0 } = job.data;
    const rule = this.rules.find(name);
    if (!rule) {
      // A rule no longer declared: nothing to do, and retrying won't change that.
      this.logger.warn('Retention of a rule no longer declared', {
        rule: name,
      });
      return { count: 0, more: false };
    }
    // The tenant is the job's (TenantWorkerHost); batches commit on their own.
    const result = await this.system.run(
      RETENTION_JOB,
      (system) =>
        this.retention.batch(system, rule, job.data.total === undefined),
      { transaction: false },
    );
    const done = total + result.count;
    if (result.more) {
      await this.retention.queueNext(job.data, done);
    } else {
      await this.retention.finish(rule, done);
    }
    this.logger.log('Retention batch', {
      rule: name,
      tenant: job.data.tenantId,
      ...result,
    });
    return result;
  }
}
