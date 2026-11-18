import { z } from 'zod';

const iso = z.iso.datetime();

/** A queue's jobs by state, as BullMQ counts them. */
const countsSchema = z.object({
  waiting: z.int(),
  active: z.int(),
  delayed: z.int(),
  completed: z.int(),
  failed: z.int(),
});

/** A job as the operators see it: never its payload (it may hold a person's data). */
export const jobSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string(),
    tenantId: z
      .string()
      .nullable()
      .describe('The tenant that queued it, when the job names one.'),
    attempts: z.int().describe('Attempts made so far.'),
    reason: z
      .string()
      .nullable()
      .describe(
        'Why the last attempt failed: masked as in the logs, cut, no stack trace.',
      ),
    queuedAt: iso,
    finishedAt: iso.nullable(),
  })
  .meta({ id: 'OpsJob' });

export const queueStateSchema = z
  .object({
    name: z.string(),
    paused: z.boolean(),
    workers: z
      .int()
      .describe(
        'Worker connections: 0 everywhere means no worker process runs.',
      ),
    counts: countsSchema,
  })
  .meta({ id: 'OpsQueue' });

export const queueListSchema = z
  .object({ items: z.array(queueStateSchema) })
  .meta({ id: 'OpsQueueList' });

export const JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'completed',
  'failed',
] as const;

export const jobsQuerySchema = z.object({
  state: z.enum(JOB_STATES).default('failed'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type JobsQuery = z.infer<typeof jobsQuerySchema>;

export const jobListSchema = z
  .object({ items: z.array(jobSchema) })
  .meta({ id: 'OpsJobList' });

export const pausedSchema = z
  .object({ name: z.string(), paused: z.boolean() })
  .meta({ id: 'OpsQueuePaused' });

export const retriedSchema = z
  .object({ retried: z.int() })
  .meta({ id: 'OpsRetried' });

export const discardedSchema = z
  .object({ discarded: z.int() })
  .meta({ id: 'OpsDiscarded' });

export const outboxSchema = z
  .object({
    pending: z.int().describe('Messages not yet published.'),
    ready: z.int().describe('Claimable now.'),
    leased: z.int(),
    inFlight: z.int().describe('Being published by this process right now.'),
    deadLetters: z.int(),
    lagMs: z
      .int()
      .describe(
        'How long the longest-waiting message has waited: the number to alert on.',
      ),
  })
  .meta({ id: 'OpsOutbox' });

export const deadLetterSchema = z
  .object({
    id: z.string(),
    topic: z.string(),
    key: z.string().nullable(),
    attempts: z.int(),
    reason: z.enum(['exhausted', 'rejected']),
    lastError: z.string().nullable().describe('Masked as in the logs and cut.'),
    createdAt: iso,
    failedAt: iso,
  })
  .meta({ id: 'OpsDeadLetter' });

export const deadLetterQuerySchema = z.object({
  topic: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DeadLetterQuery = z.infer<typeof deadLetterQuerySchema>;

export const deadLetterListSchema = z
  .object({ items: z.array(deadLetterSchema) })
  .meta({ id: 'OpsDeadLetterList' });

/** The body of retry and discard: these ids, or every dead letter when none is given. */
export const deadLettersTargetSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000).optional(),
});
export type DeadLettersTarget = z.infer<typeof deadLettersTargetSchema>;

export const WORKFLOW_STATUSES = [
  'pending',
  'running',
  'suspended',
  'compensating',
  'completed',
  'failed',
  'cancelled',
  'compensation_failed',
] as const;

export const workflowSchema = z
  .object({
    id: z.string(),
    workflow: z.string(),
    status: z.enum(WORKFLOW_STATUSES),
    createdAt: iso,
    wakeAt: iso
      .nullable()
      .describe(
        'When it is next due; null: only a signal or a cancel wakes it.',
      ),
    error: z.string().nullable().describe('Masked as in the logs and cut.'),
  })
  .meta({ id: 'OpsWorkflow' });

export const workflowsQuerySchema = z.object({
  status: z.enum(WORKFLOW_STATUSES).optional(),
  workflow: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type WorkflowsQuery = z.infer<typeof workflowsQuerySchema>;

export const workflowListSchema = z
  .object({ items: z.array(workflowSchema) })
  .meta({ id: 'OpsWorkflowList' });

// ---- Backlog ----

/**
 * Which backlog an operator acts on: exactly one of `tenantId` (that tenant's
 * outbox share) and `global: true`, so another tenant's work is never touched
 * by accident. `topic` narrows the outbox, `template` the mail queue, `before`
 * keeps to older work.
 */
export const backlogScopeSchema = z
  .object({
    tenantId: z.uuid().optional(),
    global: z.literal(true).optional(),
    topic: z.string().min(1).max(200).optional(),
    template: z.string().min(1).max(200).optional(),
    before: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
  })
  .refine(
    (scope) => (scope.tenantId === undefined) !== (scope.global === undefined),
    {
      message: 'Give exactly one of tenantId and global: true.',
    },
  );
export interface BacklogScope {
  tenantId?: string;
  global?: true;
  topic?: string;
  template?: string;
  before?: Date;
}

export const backlogActionSchema = z.object({
  target: z.enum(['outbox', 'mail']),
  scope: backlogScopeSchema,
  limit: z.int().min(1).max(10_000).default(10_000),
});
export type BacklogAction = z.infer<typeof backlogActionSchema>;

const topicGroups = z.object({
  total: z.int(),
  groups: z.array(z.object({ topic: z.string(), count: z.int() })),
});

export const backlogPreviewSchema = z
  .object({
    outbox: z.object({
      pending: topicGroups,
      deadLetters: topicGroups,
      leased: z.int().describe('Being delivered now: never discarded.'),
    }),
    mail: z
      .object({
        groups: z.array(
          z.object({
            state: z.string(),
            template: z.string(),
            count: z.int(),
            essential: z
              .int()
              .describe('Of them, essential mail: never discarded.'),
          }),
        ),
        capped: z.boolean(),
      })
      .nullable()
      .describe('Null for a tenant scope: mail jobs name no tenant.'),
  })
  .meta({ id: 'OpsBacklogPreview' });

export const backlogResultSchema = z
  .object({
    count: z.int(),
    more: z.boolean().describe('The limit was reached: call again.'),
  })
  .meta({ id: 'OpsBacklogResult' });

// ---- Diagnostics ----

export const diagnosticsSchema = z
  .object({
    items: z.array(
      z.object({
        name: z.string(),
        state: z
          .enum(['ok', 'configured', 'unavailable'])
          .describe(
            'ok: answered now; configured: set up, not probed (run its test); unavailable: did not answer.',
          ),
        driver: z
          .string()
          .nullable()
          .describe('A name (`smtp`, `s3`), never a URL or a credential.'),
        detail: z
          .string()
          .nullable()
          .describe('Masked as in the logs and cut.'),
        testable: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'OpsDiagnostics' });

export const diagnosticTestSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.int(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'OpsDiagnosticTest' });
