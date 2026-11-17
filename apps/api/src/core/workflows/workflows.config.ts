import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { flag, integer } from '../config/env.helpers.js';

export const schema = z.object({
  /** Workflow steps run in this process: off in a worker kept for the heavy queues (WORKER_QUEUES) and in tests. */
  WORKFLOWS_WORKER: flag('on'),
  /** Workflow instances this process executes at once. */
  WORKFLOW_CONCURRENCY: integer(10, { min: 1 }),
});

export const workflowsConfig = registerAs('workflows', () => {
  const env = readEnv(schema);
  return {
    worker: env.WORKFLOWS_WORKER,
    concurrency: env.WORKFLOW_CONCURRENCY,
  };
});
