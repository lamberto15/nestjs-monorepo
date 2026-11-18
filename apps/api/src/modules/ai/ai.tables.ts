import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

export const AI_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

/**
 * What the AI helper was asked, and what it cost: one row per request, kept
 * as the usage record. It holds no prompt and no output (they carry the
 * record's personal data): the output lives in the queue's result for an
 * hour, and the prompt is built again from the record on the worker. The
 * model id and the prompt-template version are stored so a change of either
 * can be traced to the runs it affects.
 */
export const aiRuns = tenantTable(
  'ai_runs',
  {
    id: uuidPk(),
    /** The record's collection (`notes`): which AiModule.forRecord() serves it. */
    source: text('source').notNull(),
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The task (`summarize`) and the version of its prompt template. */
    task: text('task').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** The exact model id the provider answered with (null until it did). */
    model: text('model'),
    status: text('status').$type<AiRunStatus>().notNull(),
    /** `user:<id>` or `client:<id>`. */
    requestedBy: text('requested_by').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Answered from the cache: no tokens were spent. */
    cached: boolean('cached').notNull().default(false),
    /** Why it failed: a code of `ai.errors` in the catalog. */
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('ai_runs_tenant_idx').on(t.tenantId),
    index('ai_runs_requested_by_idx').on(t.requestedBy),
    // One run at a time per record, task and requester.
    uniqueIndex('ai_runs_pending_idx')
      .on(t.tenantId, t.source, t.recordId, t.task, t.requestedBy)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export type AiRunRow = typeof aiRuns.$inferSelect;
