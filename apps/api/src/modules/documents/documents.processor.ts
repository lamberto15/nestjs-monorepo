import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { ActiveRequester } from '../../iam/api-clients/active-requester.js';
import {
  DocumentClaimLost,
  DOCUMENT_ERRORS,
  DOCUMENTS,
  type DocumentJob,
  DocumentsService,
} from './documents.service.js';

/**
 * Renders the documents asked for, on the workers, in the tenant it was
 * asked for in (TenantWorkerHost restores it from the job), as the
 * principal who asked, checked again first: a user deactivated in the
 * meantime, or no longer a member of the tenant, gets nothing issued. Two
 * at once per worker: each is a Chromium page in Gotenberg, whose own
 * limits are the real bound.
 */
@Processor(DOCUMENTS, { concurrency: 2 })
export class DocumentsProcessor extends TenantWorkerHost<DocumentJob> {
  private readonly logger = new Logger('Documents');

  constructor(
    private readonly documents: DocumentsService,
    private readonly requester: ActiveRequester,
  ) {
    super();
  }

  async handle(job: Job<DocumentJob>) {
    const principal = await this.requester.of(job.data.principal);
    return this.documents.issue(job.data, principal, {
      final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
  }

  /**
   * Every failure for good fails the document, whatever got it there:
   * `issue()` has done so with the precise reason (then this is a no-op:
   * `fail()` changes only a queued or rendering document), but a render
   * whose worker died mid-way stalls, and past the limit the next worker
   * fails it without calling `process()`. No document stays queued or
   * rendering for ever.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DocumentJob> | undefined, error: Error) {
    if (!job || error instanceof DocumentClaimLost) {
      return; // another run holds the document: its outcome is that run's
    }
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      error.message.includes('stalled more than') ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final) return;
    // Outside process(): the document is the job's tenant's.
    await inTenantOf(job.data, () =>
      this.documents.fail(job.data, DOCUMENT_ERRORS.unavailable),
    ).catch((failure: unknown) =>
      this.logger.error('A failed document could not be marked failed', {
        id: job.data.id,
        error: String(failure),
      }),
    );
  }
}
