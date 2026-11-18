import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../core/http/pagination.js';
import { JOB_STATUSES, jobStatusFilter } from '../../core/jobs/job-status.js';
import { fieldSchemas } from '../fields/fields.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  BULK_ACTIONS,
  type BulkAction,
  MAX_BULK_IDS,
  MAX_BULK_RESULTS,
} from './bulk.types.js';

/** The actions a record's bulk route offers: `restore` only with a recycle bin. */
export const actionsOf = (record: RecordDeclaration): readonly BulkAction[] =>
  BULK_ACTIONS.filter((action) => action !== 'restore' || record.softDelete);

/** What `update` takes: the PATCH body of the record's fields, checked once for every item. */
export const bulkInputSchema = (record: RecordDeclaration) =>
  fieldSchemas(record.fields).update;

/** The body of a record's `POST /<path>/bulk`. */
export const bulkRequestSchema = (record: RecordDeclaration) =>
  z.object({
    action: z.enum(actionsOf(record) as [BulkAction, ...BulkAction[]]),
    ids: z
      .array(z.uuid())
      .min(1)
      .optional()
      // Documented, not enforced here: BulkService answers bulk_too_many.
      .meta({ maxItems: MAX_BULK_IDS })
      .describe(
        `These records (1 to ${MAX_BULK_IDS}); those you may not act on are skipped. Send ids or filter.`,
      ),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Every record matching these list filters, as on the list route: { "status": "draft", "title.startsWith": "Old" }. Always a background job.',
      ),
    input: bulkInputSchema(record)
      .optional()
      .describe('What the action takes (update: the PATCH body).'),
  });

const itemErrorSchema = z.object({
  code: z.string().meta({ example: 'field_forbidden' }),
  message: z.string(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

/** What a run did: exact counts, then one result per item. */
export const bulkResultSchema = z.object({
  done: z.number(),
  failed: z.number(),
  skipped: z
    .number()
    .describe('Ids not found, or not yours to act on (code not_found).'),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['done', 'failed', 'skipped']),
      error: itemErrorSchema
        .optional()
        .describe(
          "Why it failed: the problem the record's own route would have answered.",
        ),
    }),
  ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      `A background job keeps ${MAX_BULK_RESULTS} results; true when there were more.`,
    ),
});

/** A run handed to the workers: follow it at GET /v1/bulk/{id}. */
export const bulkStartedSchema = z.object({
  id: z.string(),
  status: z.literal('queued'),
});

/** GET /v1/bulk/{id}. */
export const bulkStatusSchema = z.object({
  id: z.string(),
  subject: z.string().describe('The record it acts on: TestItem.'),
  action: z.enum(BULK_ACTIONS),
  status: z.enum(JOB_STATUSES),
  progress: z
    .record(z.string(), z.number())
    .describe('processed, done, failed: every 100 items.'),
  createdAt: z.iso.datetime().describe('When it was handed to the workers.'),
  startedAt: z.iso
    .datetime()
    .nullable()
    .describe('When a worker took it up; null while it is queued.'),
  finishedAt: z.iso
    .datetime()
    .nullable()
    .describe('When it completed or failed; null while it waits or runs.'),
  result: bulkResultSchema.optional(),
  error: z.string().optional(),
});

/** An item of GET /v1/bulk: a run as GET /v1/bulk/{id} tells it, without the result per item. */
export const bulkRunSchema = bulkStatusSchema.extend({
  result: bulkResultSchema
    .omit({ results: true })
    .optional()
    .describe('The counts; GET /v1/bulk/{id} has the result per item.'),
});

/** GET /v1/bulk's query. */
export const runsQuerySchema = z.object({
  status: jobStatusFilter,
  kind: z
    .enum(BULK_ACTIONS)
    .optional()
    .describe('Only runs of this action. Default: all.'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.uuid().optional().describe('`nextCursor` of the previous page.'),
});
export type RunsQuery = z.infer<typeof runsQuerySchema>;
