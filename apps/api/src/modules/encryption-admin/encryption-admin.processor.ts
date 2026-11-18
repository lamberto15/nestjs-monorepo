import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  type TenantEnvelope,
  TenantWorkerHost,
} from '../../core/tenancy/tenant-job.js';
import {
  EncryptionAdminService,
  REENCRYPTION_QUEUE,
} from './encryption-admin.service.js';

/**
 * Runs one pass of the re-encryption in the job's tenant (none for the
 * tables of no tenant): the stale rows of every encrypted column, rewritten
 * under the current keys. One at a time per worker: background work that
 * may take its time.
 */
@Processor(REENCRYPTION_QUEUE, { concurrency: 1 })
export class EncryptionAdminProcessor extends TenantWorkerHost<
  object,
  { rewritten: number; failed: number }
> {
  private readonly logger = new Logger('Reencryption');

  constructor(private readonly admin: EncryptionAdminService) {
    super();
  }

  async handle(job: Job<object & TenantEnvelope>) {
    const result = await this.admin.pass();
    this.logger.log('Re-encryption pass', {
      tenant: job.data.tenantId,
      ...result,
    });
    return result;
  }
}
