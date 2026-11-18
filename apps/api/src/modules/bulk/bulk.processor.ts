import { InjectTransaction } from '@nestjs-cls/transactional';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { Realtime } from '../realtime/realtime.service.js';
import { bulkFailed, bulkFinished, bulkProgress } from './bulk.events.js';
import { PRINCIPAL_GONE, BulkService, publicReason } from './bulk.service.js';
import {
  BULK,
  type BulkJob,
  type BulkResult,
  MAX_BULK_RESULTS,
} from './bulk.types.js';

/**
 * Runs the bulk runs too large for a request, on the workers (APP_ROLE
 * worker or all), in the tenant the run was started in (TenantWorkerHost
 * restores it from the job). The principal is checked again when the job
 * starts: a user deactivated in the meantime, or no longer a member of
 * the tenant, gets nothing done.
 */
// maxStalledCount 0: a run whose worker was lost (a redeploy mid-way) fails
// instead of starting over; items done stay done (the audit says which).
@Processor(BULK, { concurrency: 2, maxStalledCount: 0 })
export class BulkProcessor extends TenantWorkerHost<BulkJob, BulkResult> {
  private readonly logger = new Logger('Bulk');

  constructor(
    private readonly bulk: BulkService,
    private readonly realtime: Realtime,
    private readonly users: UsersRepository,
    @InjectTransaction() private readonly db: Database,
  ) {
    super();
  }

  async handle(job: Job<BulkJob>): Promise<BulkResult> {
    const principal = await this.stillActive(job.data.principal);
    if (!principal) throw new Error(PRINCIPAL_GONE);
    const { subject, action } = job.data;
    const registration = this.bulk.registration(subject);
    // Parsed here, not at enqueue: the job is JSON. The request checked them.
    const { selection, input } = await this.bulk.parse(
      principal,
      registration,
      job.data,
    );
    const run = { id: job.id!, subject, action };
    const result = await this.bulk.execute(
      principal,
      registration,
      action,
      selection,
      input,
      {
        cap: MAX_BULK_RESULTS,
        progress: async (tally) => {
          const counts = {
            processed: tally.processed,
            done: tally.done,
            failed: tally.failed,
          };
          await job.updateProgress(counts);
          // Every BULK_PROGRESS_EVERY items: coarse enough to push as it is.
          this.realtime.toPrincipal(principal, bulkProgress, {
            ...run,
            ...counts,
          });
        },
      },
    );
    await job.updateProgress({
      processed: result.done + result.failed,
      done: result.done,
      failed: result.failed,
    });
    await this.bulk.finished(job.data, job.id!, result);
    this.realtime.toPrincipal(principal, bulkFinished, {
      ...run,
      done: result.done,
      failed: result.failed,
    });
    this.logger.log('Bulk run done', {
      ...run,
      done: result.done,
      failed: result.failed,
    });
    return result;
  }

  /**
   * A run that failed for good (runs get one attempt; a stalled one is
   * failed by BullMQ without `handle()`): its starter hears it. Items done
   * before it stay done.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<BulkJob> | undefined, error: Error) {
    if (!job) return;
    await inTenantOf(job.data, async () => {
      this.realtime.toPrincipal(job.data.principal, bulkFailed, {
        id: job.id!,
        subject: job.data.subject,
        action: job.data.action,
        error: publicReason(error.message),
      });
    }).catch((failure: unknown) =>
      this.logger.error('A failed bulk run could not be announced', {
        id: job.id,
        error: String(failure),
      }),
    );
  }

  /**
   * The principal as it is now, or null when it was deactivated since the
   * run was queued, or no longer acts in the run's tenant. A job's
   * principal is data: only a user or a client of this very tenant.
   */
  private async stillActive(
    principal: RequestPrincipal,
  ): Promise<RequestPrincipal | null> {
    const tenantId = requireTenantId('A bulk run');
    if (principal.tenantId !== tenantId) return null;
    if (principal.kind === 'user') {
      const user = await this.users.inTenant(principal.id, tenantId);
      if (!user) return null;
      // Started while impersonating: the audit keeps who really did it.
      return principal.impersonator
        ? { ...user, impersonator: principal.impersonator }
        : user;
    }
    if (principal.kind !== 'client') return null;
    // Row-level security: another tenant's client is none.
    const [client] = await this.db
      .select({ active: apiClients.active, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.id, principal.id));
    return client?.active ? { ...principal, name: client.name } : null;
  }
}
