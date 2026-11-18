import {
  type ConnectionOptions,
  type DefaultJobOptions,
  type QueueBase,
  Worker,
  type WorkerOptions,
} from 'bullmq';
import { consumesQueue, queuesConfig } from './queues.config.js';

/**
 * Every queue's job defaults, set on the root connection
 * (`QueuesModule`). A queue that sets its own `defaultJobOptions` in
 * `registerQueue()` replaces them wholesale, so it spreads these:
 * `{ ...DEFAULT_JOB_OPTIONS, removeOnComplete: … }`.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Finished jobs stay a while, for debugging.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // A failed job keeps its whole payload, so a storm of failures is capped
  // by count too, not only by age.
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

/**
 * How long a job id given to `onceJob()` keeps a second add out: past an
 * outbox handler's retries (20 attempts at most five minutes apart, about
 * an hour) with a margin, as long as a finished job may stay.
 */
export const ONCE_TTL_MS = 24 * 3600 * 1000;

/**
 * The options of a job a retried caller (an outbox handler, a job) adds
 * again with the same id: it runs once. A job id alone dedupes only while
 * the job is kept, and `removeOnComplete` drops it after 1000 newer ones,
 * so a retry after that would run it again. BullMQ's deduplication with a
 * `ttl` (its "throttle mode") keeps the id for `ONCE_TTL_MS` whatever
 * happened to the job.
 */
export const onceJob = (jobId: string) => ({
  jobId,
  deduplication: { id: jobId, ttl: ONCE_TTL_MS },
});

/**
 * The worker's connection from the queues' (producer) options: the offline
 * queue back on and `maxRetriesPerRequest: null`, which a worker needs to
 * wait out a Redis outage (https://docs.bullmq.io/guide/going-to-production).
 * BullMQ forces the latter on a worker's blocking connections anyway, but
 * prints a warning for every one when the options say otherwise.
 */
export function workerConnection(
  connection: WorkerOptions['connection'],
): WorkerOptions['connection'] {
  // A client instance is the caller's own: leave it.
  if (!connection || typeof connection !== 'object' || 'status' in connection) {
    return connection;
  }
  return {
    ...connection,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
}

/**
 * The class @nestjs/bullmq creates a `@Processor`'s worker from
 * (`BullModule.workerClass`, its documented hook): one root connection
 * serves queues and workers there, so the worker takes its own options here.
 * It is made outside dependency injection, so it reads the settings itself.
 */
export class QueueWorker extends Worker {
  constructor(
    name: string,
    processor: ConstructorParameters<typeof Worker>[1],
    options?: WorkerOptions,
  ) {
    super(
      name,
      processor,
      options && {
        ...options,
        connection: workerConnection(options.connection),
        // A queue another worker consumes is never started here.
        autorun:
          options.autorun !== false && consumesQueue(name, queuesConfig()),
      },
    );
  }
}

/** The variable that sets a queue's concurrency: `data-transfers` is `QUEUE_CONCURRENCY_DATA_TRANSFERS`. */
export const queueConcurrencyVariable = (queue: string) =>
  `QUEUE_CONCURRENCY_${queue.toUpperCase().replaceAll('-', '_')}`;

/**
 * Sets each worker's concurrency from its queue's variable, when one is set
 * to a whole number of 1 or more. `@Processor` options are static decorator
 * arguments, so the deployment's value is set on the running worker instead:
 * `concurrency` is a settable property of BullMQ's Worker
 * (https://docs.bullmq.io/guide/workers/concurrency).
 */
export function applyQueueConcurrency(
  workers: readonly Pick<Worker, 'name' | 'concurrency'>[],
  read: (variable: string) => string | undefined,
) {
  for (const worker of workers) {
    const value = Number(read(queueConcurrencyVariable(worker.name)));
    if (Number.isInteger(value) && value >= 1) {
      worker.concurrency = value;
    }
  }
}

/**
 * Makes `queue.close()` survive a producer connection that is down. A
 * producer has no offline queue, so with Redis unreachable its QUIT is
 * rejected ("Stream isn't writeable and enableOfflineQueue options is
 * false") where an offline-queued one would just disconnect; BullMQ passes
 * that error on, and @nestjs/bullmq's shutdown with it. Redis being gone,
 * there is nothing to quit: the connection is dropped (which also ends its
 * reconnect loop, so the process can exit).
 */
export function closeWhenRedisIsDown(
  queue: Pick<QueueBase, 'close' | 'getBackend'>,
) {
  const close = queue.close.bind(queue);
  queue.close = async () => {
    try {
      await close();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('enableOfflineQueue')
      ) {
        throw error;
      }
      // Not `queue.disconnect()`: it waits for the client's 'end', which a
      // client that is reconnecting only emits after its next attempt.
      const backend = queue.getBackend() as unknown as {
        connection: { client: Promise<{ disconnect(): void }> };
      };
      (await backend.connection.client).disconnect();
    }
  };
}
