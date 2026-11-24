import { z } from 'zod';
import { jobStatusFilter } from '../../core/jobs/job-status.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../core/http/pagination.js';
import { TRANSFER_FORMATS } from './data-transfer.types.js';
import {
  TRANSFER_KEPT_MS,
  TRANSFER_LINK_TTL_MS,
} from './transfer-retention.js';
import { isTimeZone } from '../../core/time/zoned-time.js';

/** At most this many saved mappings per import, and columns in one. */
export const MAX_MAPPINGS_PER_IMPORT = 50;
export const MAX_MAPPED_COLUMNS = 200;

export const timezoneSchema = z
  .string()
  .max(64)
  .refine(isTimeZone, { message: 'An IANA time zone, such as Asia/Manila.' })
  .meta({ example: 'Asia/Manila' });

/** The list filters of a record, as its list route takes them. */
export const filtersSchema = z
  .record(z.string(), z.string())
  .describe(
    'The list filters of that data, as on its list route: { "status": "draft" }, or the list\'s `filter` (JSON) and `q`.',
  );

export const exportSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .describe("What to export: a record's path (`GET /v1/data` lists yours).")
    .meta({ example: 'test-items' }),
  format: z.enum(TRANSFER_FORMATS).default('csv'),
  filters: filtersSchema.optional(),
  sort: z
    .string()
    .max(500)
    .optional()
    .describe(
      "The list's `sort` (`-createdAt,title`), so the file is in the order the list shows. Default: newest first.",
    ),
  timezone: timezoneSchema
    .optional()
    .describe(
      "The time zone of the file's dates. Default: the user's own, else the server's (TRANSFER_TIMEZONE).",
    ),
});
export type ExportDto = z.infer<typeof exportSchema>;

export const templateQuerySchema = z.object({
  format: z.enum(TRANSFER_FORMATS).default('csv'),
  timezone: timezoneSchema
    .optional()
    .describe(
      "The time zone of the template's date-time columns. Default: the user's own, else the server's.",
    ),
});

/** A mapping as the import route's `mapping` field takes it (a JSON object). */
export const importMappingSchema = z
  .record(z.string().min(1).max(200), z.string().min(1).max(200).nullable())
  .refine((value) => Object.keys(value).length <= MAX_MAPPED_COLUMNS, {
    message: `At most ${MAX_MAPPED_COLUMNS} columns.`,
  })
  .describe(
    'The file\'s headers to the template\'s columns: `{ "Surname": "lastName", "Notes": null }` (null: ignore the column). A header not named keeps its own name. A date-time column takes the zone of the file\'s times: `{ "When": "dueAt (Asia/Dubai)" }`.',
  )
  .meta({ example: { Title: 'title', Internal: null } });

export const importFieldsSchema = z.object({
  name: z.string().min(1).max(80).meta({ example: 'test-items' }),
  matchOn: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Update the record this column finds (one of the import's `matchKeys`) instead of creating one.",
    ),
  mapping: z
    .string()
    .optional()
    .describe(
      'A JSON object: the file\'s headers to the template\'s columns (`{"Surname": "lastName", "Notes": null}`; null ignores a column).',
    ),
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('true: check every row, write nothing.'),
  // Documents the upload: the interceptor has taken it out of the body by
  // the time this validates, hence optional; the route answers 400 without it.
  file: z.unknown().optional().meta({
    type: 'string',
    format: 'binary',
    description:
      'Required. CSV or Excel (.xlsx). GET /v1/data/imports/{name}/template gives one to fill.',
  }),
});

export const importColumnSchema = z.object({
  name: z.string(),
  type: z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'list']),
  required: z.boolean(),
  description: z.string().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  example: z.unknown().optional(),
});

export const catalogSchema = z.object({
  importLimits: z.object({ maxBytes: z.number(), maxRows: z.number() }),
  exports: z
    .array(
      z.object({
        name: z.string().meta({ example: 'test-items' }),
        subject: z
          .string()
          .describe(
            'The permission subject of the data: the one of its list (`GET /v1/lists/{subject}`).',
          ),
        columns: z.array(z.string()).describe("The file's columns, in order."),
        formats: z.array(z.enum(TRANSFER_FORMATS)),
      }),
    )
    .describe('The data you may export: POST /v1/data/exports { name }.'),
  imports: z
    .array(
      z.object({
        name: z.string(),
        formats: z.array(z.enum(TRANSFER_FORMATS)),
        matchKeys: z
          .array(z.string())
          .describe('The keys `matchOn` accepts (with the update permission).'),
        columns: z
          .array(importColumnSchema)
          .describe(
            'The columns you may fill (fields your permissions hide left out).',
          ),
        template: z
          .string()
          .meta({ example: '/v1/data/imports/test-items/template' }),
      }),
    )
    .describe('The data you may import: POST /v1/data/imports (name, file).'),
});

export const transfersQuerySchema = z.object({
  kind: z.enum(['export', 'import']).optional(),
  status: jobStatusFilter,
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z
    .uuid()
    .optional()
    .describe('`nextCursor` of the previous page (the same `kind`).'),
});
export type TransfersQuery = z.infer<typeof transfersQuerySchema>;

/** The 202 of a transfer started: follow it by its id. */
export const startedSchema = z.object({
  id: z.string().describe('Follow it at GET /v1/data/transfers/{id}.'),
  status: z.literal('queued'),
});

/** A transfer as GET /v1/data/transfers/{id} (and each item of the list) tells it. */
export const statusSchema = z.object({
  id: z.string(),
  kind: z.enum(['export', 'import']),
  name: z.string(),
  format: z.enum(TRANSFER_FORMATS),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z.record(z.string(), z.number()),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe(
      `When it is no longer kept (${TRANSFER_KEPT_MS / 86_400_000} days after it ended).`,
    ),
  result: z
    .object({
      rows: z.number(),
      url: z
        .url()
        .optional()
        .describe(
          `The file, for ${TRANSFER_LINK_TTL_MS / 60_000} minutes at most and never past \`expiresAt\`. Absent once the transfer has expired, or when you no longer hold the right it was started with.`,
        ),
      imported: z.number().optional(),
      failed: z.number().optional(),
      dryRun: z.boolean().optional(),
      errorsUrl: z
        .url()
        .optional()
        .describe(
          'A CSV of the refused rows: row, field, message. Absent when `url` would be.',
        ),
    })
    .optional(),
  error: z.string().optional(),
});
export type TransferStatus = z.infer<typeof statusSchema>;

export const createImportMappingSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'CRM export' }),
  mapping: importMappingSchema,
});
export type CreateImportMappingDto = z.infer<typeof createImportMappingSchema>;

export const savedImportMappingSchema = z.object({
  id: z.string(),
  importer: z.string(),
  name: z.string(),
  mapping: importMappingSchema,
  stale: z
    .array(z.string())
    .describe(
      'Targets that are no longer columns you may import: using the mapping as it is would be refused.',
    ),
  createdAt: z.iso.datetime(),
});

export const importMappingListSchema = z.object({
  items: z.array(savedImportMappingSchema),
});
