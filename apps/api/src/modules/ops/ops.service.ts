import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { OutboxDeadLetters, OutboxRelay } from '@nestjs/outbox';
import { WorkflowClient, type WorkflowStatus } from '@nestjs/workflows';
import { type Job, Queue } from 'bullmq';
import { logRedaction } from '../../core/logging/redaction.js';
import type {
  DeadLetterQuery,
  DeadLettersTarget,
  JobsQuery,
  WorkflowsQuery,
} from './ops.schemas.js';

/** A failure's text as an operator sees it: secrets masked as in the logs, one line's worth. */
const reasonOf = (text: unknown) =>
  typeof text === 'string' && text
    ? logRedaction.redactText(text).slice(0, 500)
    : null;

const iso = (epochMs: number) => new Date(epochMs).toISOString();

/**
 * What the operators see of the background work, across every tenant: the
 * queues (found by discovery: whichever module registered one), the outbox
 * and its dead letters, the workflows. Nothing here holds a payload: a job's
 * or a message's data may be a person's, so only its metadata and its
 * masked failure are shown.
 */
@Injectable()
export class OpsService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly relay: OutboxRelay,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly workflows: WorkflowClient,
  ) {}

  // Queues

  /** Every BullMQ queue a module of this process registered, by name. */
  private queues(): Queue[] {
    const found = new Map<string, Queue>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) {
        found.set(instance.name, instance);
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A queue by name; 404 for another. */
  queue(name: string): Queue {
    const queue = this.queues().find((candidate) => candidate.name === name);
    if (!queue) {
      throw new NotFoundException({
        code: 'queue_not_found',
        message: t('ops.queueNotFound', { args: { name } }),
      });
    }
    return queue;
  }

  async queueStates() {
    return Promise.all(
      this.queues().map(async (queue) => {
        const [counts, paused, workers] = await Promise.all([
          queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed',
          ),
          queue.isPaused(),
          queue.getWorkersCount(),
        ]);
        return {
          name: queue.name,
          paused,
          workers,
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0,
          },
        };
      }),
    );
  }

  /** A queue's latest jobs in a state, newest first. */
  async jobs(name: string, { state, limit }: JobsQuery) {
    const jobs = await this.queue(name).getJobs([state], 0, limit - 1, false);
    return jobs.filter((job): job is Job => Boolean(job)).map(summary);
  }

  async pause(name: string) {
    await this.queue(name).pause();
    return { name, paused: true };
  }

  async resume(name: string) {
    await this.queue(name).resume();
    return { name, paused: false };
  }

  /** Puts a queue's failed jobs back to run again; returns how many. */
  async retryFailed(name: string) {
    const queue = this.queue(name);
    const retried = await queue.getFailedCount();
    await queue.retryJobs({ state: 'failed' });
    return retried;
  }

  // Outbox

  async outbox() {
    const { pending, ready, leased, inFlight, deadLetters, lagMs } =
      await this.relay.stats();
    return { pending, ready, leased, inFlight, deadLetters, lagMs };
  }

  async listDeadLetters({ topic, limit, offset }: DeadLetterQuery) {
    const letters = await this.deadLetters.list({ topic, limit, offset });
    return letters.map((letter) => ({
      id: letter.id,
      topic: letter.topic,
      key: letter.key,
      attempts: letter.attempts,
      reason: letter.reason,
      lastError: reasonOf(letter.lastError),
      createdAt: iso(letter.createdAt),
      failedAt: iso(letter.failedAt),
    }));
  }

  /** Dead letters moved back to the outbox with a fresh retry budget: these ids, or all. */
  retryDeadLetters({ ids }: DeadLettersTarget) {
    return this.deadLetters.requeue(ids ?? { all: true });
  }

  /** Dead letters deleted for good: these ids, or all. */
  discardDeadLetters({ ids }: DeadLettersTarget) {
    return this.deadLetters.purge(ids ?? { all: true });
  }

  // Workflows

  async listWorkflows({ status, workflow, limit, offset }: WorkflowsQuery) {
    const instances = await this.workflows.list({
      status: status as WorkflowStatus | undefined,
      workflow,
      limit,
      offset,
    });
    return instances.map(workflowView);
  }

  async workflow(id: string) {
    const instance = await this.workflows.getStatus(id);
    if (!instance) {
      throw new NotFoundException({
        code: 'workflow_not_found',
        message: t('ops.workflowNotFound'),
      });
    }
    return workflowView(instance);
  }

  /** Runs a failed workflow again from its journal, once its cause is fixed. */
  async retryWorkflow(id: string) {
    const current = await this.workflow(id);
    if (
      current.status !== 'failed' &&
      current.status !== 'compensation_failed'
    ) {
      throw new ConflictException({
        code: 'workflow_not_retryable',
        message: t('ops.workflowNotRetryable'),
      });
    }
    return workflowView(await this.workflows.retry(id));
  }
}

function summary(job: Job) {
  const data = job.data as { tenantId?: unknown } | null;
  return {
    id: job.id ?? null,
    name: job.name,
    tenantId: typeof data?.tenantId === 'string' ? data.tenantId : null,
    attempts: job.attemptsMade,
    reason: reasonOf(job.failedReason),
    queuedAt: iso(job.timestamp),
    finishedAt: job.finishedOn ? iso(job.finishedOn) : null,
  };
}

function workflowView(instance: {
  id: string;
  workflow: string;
  status: string;
  createdAt: number;
  wakeAt: number | null;
  error?: { message?: string } | null;
}) {
  return {
    id: instance.id,
    workflow: instance.workflow,
    status: instance.status,
    createdAt: iso(instance.createdAt),
    wakeAt: instance.wakeAt === null ? null : iso(instance.wakeAt),
    error: reasonOf(instance.error?.message),
  };
}
