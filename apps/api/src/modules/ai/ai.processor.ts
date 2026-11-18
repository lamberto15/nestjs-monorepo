import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { ActiveRequester } from '../../iam/api-clients/active-requester.js';
import { AI, type AiJob, AiService } from './ai.service.js';

/**
 * Does the AI runs asked for, on the workers, in the tenant it was asked
 * for in, as the principal who asked (checked again first). Two at once per
 * worker. `lockDuration` is 3 minutes, longer than the longest call
 * (AI_TIMEOUT_MS is at most 2 minutes): otherwise BullMQ would see the job
 * as stalled while the provider still works, retry it, and the call would
 * be paid for twice.
 */
@Processor(AI, { concurrency: 2, lockDuration: 180_000 })
export class AiProcessor extends TenantWorkerHost<AiJob> {
  private readonly logger = new Logger('Ai');

  constructor(
    private readonly ai: AiService,
    private readonly requester: ActiveRequester,
  ) {
    super();
  }

  async handle(job: Job<AiJob>) {
    const principal = await this.requester.of(job.data.principal);
    return this.ai.run(job.data, principal);
  }

  /** Every failure for good fails the run, whatever got it there; a retry leaves it open. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AiJob> | undefined, error: Error) {
    if (!job) return;
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      error.message.includes('stalled more than') ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final) return;
    await inTenantOf(job.data, () =>
      this.ai.fail(job.data, this.ai.reasonOf(error)),
    ).catch((failure: unknown) =>
      this.logger.error('A failed AI run could not be marked failed', {
        id: job.data.id,
        error: String(failure),
      }),
    );
  }
}
