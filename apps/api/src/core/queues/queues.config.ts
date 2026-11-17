import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { choice, list } from '../config/env.helpers.js';

export const schema = z.object({
  /**
   * What this process runs: `api` serves HTTP only, `worker` runs the queue
   * workers and the scheduled jobs (`node dist/worker` sets it), `all` both
   * (development, small deployments).
   */
  APP_ROLE: choice(['all', 'api', 'worker'], 'all'),
  /**
   * Split the workers: the only queues this worker takes (unset: every
   * one), and the ones it leaves to another worker. So the heavy queues can
   * run in a worker of their own, whose memory spike leaves mail running.
   */
  WORKER_QUEUES: list(),
  WORKER_QUEUES_EXCLUDE: list(),
});

export const queuesConfig = registerAs('queues', () => {
  const env = readEnv(schema);
  return {
    role: env.APP_ROLE,
    only: env.WORKER_QUEUES,
    exclude: env.WORKER_QUEUES_EXCLUDE,
  };
});

export type QueuesSettings = ReturnType<typeof queuesConfig>;

/** Whether a process with this role runs the background work: queue workers and scheduled jobs. */
export const runsWorkers = (role: QueuesSettings['role']) => role !== 'api';

/** Whether this process consumes `queue`: not left to another worker by WORKER_QUEUES / WORKER_QUEUES_EXCLUDE. */
export const consumesQueue = (
  queue: string,
  { only, exclude }: Pick<QueuesSettings, 'only' | 'exclude'>,
) => (only.length === 0 || only.includes(queue)) && !exclude.includes(queue);
