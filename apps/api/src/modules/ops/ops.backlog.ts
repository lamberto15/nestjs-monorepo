import { BadRequestException, Injectable } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { OutboxDeadLetters } from '@nestjs/outbox';
import type { Job, JobType } from 'bullmq';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import type { BacklogScope } from './ops.schemas.js';
import { OpsRepository } from './ops.repository.js';
import { OpsService } from './ops.service.js';

/** Rows per statement, jobs per Redis page: nothing grows with the backlog. */
const BATCH = 1_000;
/** The most one call discards or retries: call again while `more`. */
export const BACKLOG_LIMIT = 10_000;
/** Jobs a preview reads at most per mail state; past it the answer says `capped`. */
const MAX_SCAN = 250_000;
/** Mail that can go: anything but running (BullMQ refuses to remove a locked job). */
const DISCARDABLE: JobType[] = ['waiting', 'prioritized', 'delayed', 'failed'];
const PREVIEWED: JobType[] = [...DISCARDABLE, 'active'];

/** Essential mail (a security notice) is never discarded. */
const essential = (job: Job) =>
  (job.data as { essential?: boolean } | undefined)?.essential === true;

/**
 * Scoped recovery of the two places a notification storm piles up: the
 * outbox (pending messages and dead letters) and the `mail` queue. A
 * preview counts first; a discard deletes, a retry runs again, in bounded
 * batches and up to a limit per call. The caller audits what it did.
 *
 * The outbox keeps the tenant of each message in its headers, so a tenant's
 * share can be told; a mail job names none, so mail is only ever whole
 * (`global`), narrowed by template and age. Never discarded: a message
 * under a live lease (being delivered now), a running job, essential mail.
 */
@Injectable()
export class OpsBacklog {
  constructor(
    private readonly repository: OpsRepository,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly ops: OpsService,
  ) {}

  /** What a discard or a retry with this scope would touch, counted. */
  async preview(scope: BacklogScope) {
    const now = Date.now();
    const pending = await this.groups('messages', scope, now);
    const leased = await this.repository.countLeased(scope, now);
    const dead = await this.groups('deadLetters', scope, now);
    return {
      outbox: { pending, deadLetters: dead, leased },
      mail: scope.tenantId ? null : await this.previewMail(scope),
    };
  }

  /** Deletes up to `limit` of the backlog in scope. `more`: the limit was reached. */
  async discard(
    target: 'outbox' | 'mail',
    scope: BacklogScope,
    limit = BACKLOG_LIMIT,
  ) {
    if (target === 'mail') {
      this.mailScope(scope);
      return this.eachMailJob(scope, DISCARDABLE, limit, async (job) =>
        essential(job) ? false : (await this.mailQueue().remove(job.id!)) === 1,
      );
    }
    let done = 0;
    while (done < limit) {
      const size = Math.min(BATCH, limit - done);
      const now = Date.now();
      let removed = await this.repository.deletePending(scope, now, size);
      if (removed < size) {
        const letters = await this.letterIds(scope, size - removed);
        if (letters.length > 0)
          removed += await this.deadLetters.purge(letters);
      }
      done += removed;
      if (removed < size) break;
    }
    return { count: done, more: done >= limit };
  }

  /** Runs the failed work in scope again, up to `limit`: dead letters requeued with a fresh budget, or failed mail. */
  async retry(
    target: 'outbox' | 'mail',
    scope: BacklogScope,
    limit = BACKLOG_LIMIT,
  ) {
    if (target === 'mail') {
      this.mailScope(scope);
      return this.eachMailJob(scope, ['failed'], limit, async (job) => {
        await job.retry('failed');
        return true;
      });
    }
    let done = 0;
    while (done < limit) {
      const size = Math.min(BATCH, limit - done);
      const ids = await this.letterIds(scope, size);
      const requeued = ids.length ? await this.deadLetters.requeue(ids) : 0;
      done += requeued;
      if (requeued === 0 || ids.length < size) break;
    }
    return { count: done, more: done >= limit };
  }

  private letterIds(scope: BacklogScope, size: number) {
    return this.repository.deadLetterIds(scope, size);
  }

  private mailQueue() {
    return this.ops.queue(MAIL_QUEUE);
  }

  /** A mail job names no tenant: a tenant's share of the queue can't be told. */
  private mailScope(scope: BacklogScope) {
    if (scope.tenantId) {
      throw new BadRequestException({
        code: 'mail_not_tenant_scoped',
        message: t('ops.mailNotTenantScoped'),
      });
    }
  }

  private async groups(
    table: 'messages' | 'deadLetters',
    scope: BacklogScope,
    now: number,
  ) {
    const rows = await this.repository.countByTopic(table, scope, now);
    rows.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      groups: rows.slice(0, 100),
    };
  }

  private mailMatches(job: Job | undefined, scope: BacklogScope) {
    if (!job?.id) return false;
    if (scope.template && job.name !== scope.template) return false;
    if (scope.before && job.timestamp >= scope.before.getTime()) return false;
    return true;
  }

  /**
   * Walks the mail queue's jobs in `states` a page at a time, handing each
   * one in scope to `act` (true: it left the list), up to `limit`. The page
   * start moves past what stayed, so jobs that left don't make it skip others.
   */
  private async eachMailJob(
    scope: BacklogScope,
    states: JobType[],
    limit: number,
    act: (job: Job) => Promise<boolean>,
  ) {
    const queue = this.mailQueue();
    let done = 0;
    for (const state of states) {
      for (let start = 0; done < limit;) {
        const page = await queue.getJobs(
          [state],
          start,
          start + BATCH - 1,
          true,
        );
        let left = 0;
        for (const job of page) {
          if (
            done < limit &&
            this.mailMatches(job, scope) &&
            (await act(job))
          ) {
            done++;
            left++;
          }
        }
        if (page.length < BATCH) break;
        start += page.length - left;
      }
    }
    return { count: done, more: done >= limit };
  }

  private async previewMail(scope: BacklogScope) {
    const queue = this.mailQueue();
    const found = new Map<
      string,
      { state: string; template: string; count: number; essential: number }
    >();
    let capped = false;
    for (const state of PREVIEWED) {
      for (let start = 0; ; start += BATCH) {
        if (start >= MAX_SCAN) {
          capped = true;
          break;
        }
        const page = await queue.getJobs(
          [state],
          start,
          start + BATCH - 1,
          true,
        );
        for (const job of page) {
          if (!this.mailMatches(job, scope)) continue;
          const key = `${state}|${job.name}`;
          const group = found.get(key) ?? {
            state,
            template: job.name,
            count: 0,
            essential: 0,
          };
          group.count++;
          if (essential(job)) group.essential++;
          found.set(key, group);
        }
        if (page.length < BATCH) break;
      }
    }
    return {
      groups: [...found.values()].sort(
        (a, b) =>
          b.count - a.count ||
          a.state.localeCompare(b.state) ||
          a.template.localeCompare(b.template),
      ),
      capped,
    };
  }
}
