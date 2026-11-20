import { z } from 'zod';
import { FILTER_OPS } from '../../core/http/list-query.js';

/** One field of a list: what it may be filtered and sorted by. */
export const listFieldSchema = z.object({
  name: z
    .string()
    .describe(
      'The name in the query: `?<name>.<operator>=`, `{ "field": <name> }` in `filter`, `sort=<name>`. Custom fields are `custom.<key>`.',
    )
    .meta({ example: 'status' }),
  type: z
    .enum(['string', 'uuid', 'datetime', 'date', 'number', 'boolean', 'enum'])
    .describe(
      'How values are written: datetime ISO 8601 with an offset, date YYYY-MM-DD, enum one of `options`.',
    ),
  options: z
    .array(z.string())
    .optional()
    .describe('The values an enum takes.')
    .meta({ example: ['draft', 'published'] }),
  operators: z
    .array(z.enum(FILTER_OPS))
    .describe('The operators it may be filtered with; empty: none.')
    .meta({ example: ['eq', 'ne', 'in', 'notIn'] }),
  ref: z
    .string()
    .optional()
    .describe(
      "What the field's values are ids of, for a picker instead of a text box: `tag` (GET /v1/tags), `unit` (GET /v1/organizational-units: search with `q`, name ids with `id=`), `principal` (a user's or an API client's key, `user:<id>` or `client:<id>`: GET /v1/people searches users with `q`, names keys with `key=`) or a record's subject (`Invoice`: GET its list). Absent for any other field.",
    )
    .meta({ example: 'tag' }),
  sortable: z.boolean().describe('`sort` may name it.'),
  custom: z
    .boolean()
    .describe("A custom field of the caller's tenant (GET /v1/custom-fields)."),
  label: z
    .string()
    .optional()
    .describe("A custom field's label, as its administrators named it."),
});

/** Which add-ons a subject's records take, in this deployment. */
export const listCapabilitiesSchema = z
  .record(z.string(), z.boolean())
  .describe(
    "What the subject's records take, by add-on (`tags`, `comments`…): each add-on its feature module imports names itself here, false when this deployment has it off. A client shows a record's panels only where they are true. Whether the caller may use one on a record is the record's `can` (`?include=can`) and the routes' answers.",
  )
  .meta({ example: { tags: true, comments: true, pdf: false } });

/** Records that refer to the subject's: a related panel of its records (record-relations.ts). */
export const listRelatedSchema = z.object({
  subject: z
    .string()
    .describe(
      'The referring records: their own list is GET /v1/lists/{subject}.',
    )
    .meta({ example: 'InvoiceLine' }),
  path: z
    .string()
    .describe(
      "Their list, under /v1: a record's related ones are `GET /v1/<path>?<field>=<id>` (paginated, newest first, only those the caller may read).",
    )
    .meta({ example: 'invoice-lines' }),
  field: z
    .string()
    .describe("Their field holding the record's id.")
    .meta({ example: 'invoiceId' }),
  title: z
    .string()
    .nullable()
    .describe(
      'The field a client names each one by (their first text field); null when none.',
    )
    .meta({ example: 'title' }),
  required: z
    .boolean()
    .describe(
      'Required: the field is never empty, and a record they refer to stays until they go (409 `record_referenced`, those in the recycle bin included). Optional: the field empties when its record is deleted for good.',
    ),
  onDelete: z
    .enum(['restrict', 'keep'])
    .describe(
      'Deleting a record they refer to: `restrict` refuses it while live ones do (409 `record_referenced`); `keep` moves it to the recycle bin with their field kept, so a restore brings the relation back.',
    ),
});
/**
 * The record views a subject declares (`views` of its record or list
 * source), each naming list fields: a board of an enum field's values, a
 * calendar of date fields, a timeline of a start and an end.
 */
export const listViewsSchema = z
  .object({
    board: z
      .object({
        field: z
          .string()
          .describe("The enum field whose values are the board's columns.")
          .meta({ example: 'status' }),
        readOnly: z
          .boolean()
          .describe(
            'The cards are not moved: the field is not changed through `PATCH`.',
          ),
      })
      .optional(),
    calendar: z
      .object({
        fields: z
          .array(z.string())
          .describe(
            'The `date` (all-day) and `datetime` fields to plan by, one at a time.',
          )
          .meta({ example: ['dueAt'] }),
        readOnly: z
          .boolean()
          .describe('The dates are not changed through `PATCH`.'),
      })
      .optional(),
    timeline: z
      .object({
        start: z.string().describe('The field a bar starts at.'),
        end: z
          .string()
          .describe('The field a bar ends at; empty: the bar is still open.'),
      })
      .optional(),
  })
  .nullable()
  .describe(
    'The views besides the table that this subject declares and this caller can use: a field they may not filter by leaves its view out. Null when none. Fetch their records with the list route, bounded by `filter` on the fields named here.',
  );

/** What a record or list source declares as `views` (readOnly defaults to false). */
export interface ListViewsDeclaration {
  board?: { field: string; readOnly?: boolean };
  calendar?: { fields: readonly string[]; readOnly?: boolean };
  timeline?: { start: string; end: string };
}

/** What GET /v1/lists/{subject} answers. */
export const listMetadataSchema = z
  .object({
    subject: z.string().meta({ example: 'Note' }),
    fields: z
      .array(listFieldSchema)
      .describe(
        'The fields the list may be filtered or sorted by, as this caller may read them: a field their permissions hide is not here; one they may read on some records only has no operators and is not sortable (still in `select`).',
      ),
    select: z
      .array(z.string())
      .describe('What `fields=` may pick (id always comes).')
      .meta({ example: ['title', 'status', 'custom.region'] }),
    search: z
      .boolean()
      .describe(
        '`q=` searches the text, and `sort=-rank` puts the best match first. False when the search reads a field this caller may not read on every record.',
      ),
    recycleBin: z
      .boolean()
      .describe(
        '`deleted=true` lists the recycle bin for this caller (they may restore).',
      ),
    defaultSort: z
      .string()
      .nullable()
      .describe('The order without `sort`: the newest first.')
      .meta({ example: '-createdAt' }),
    limits: z
      .object({
        defaultLimit: z
          .number()
          .int()
          .describe('Rows a page holds without `limit`.'),
        maxLimit: z.number().int().describe('The largest `limit`.'),
        maxOffset: z
          .number()
          .int()
          .describe(
            'No `page` starts past this row: narrow the filters, or page by cursor.',
          ),
        countCap: z
          .number()
          .int()
          .describe('`count=true` counts up to this (then `totalCapped`).'),
        maxSort: z.number().int().describe('Fields `sort` may name.'),
        maxConditions: z.number().int().describe('Conditions in one `filter`.'),
        maxDepth: z.number().int().describe('Groups nested in one `filter`.'),
        maxValues: z.number().int().describe('Values of one `in` or `notIn`.'),
      })
      .describe("The list's limits, the same on every list."),
    capabilities: listCapabilitiesSchema,
    related: z
      .array(listRelatedSchema)
      .describe(
        "The records that refer to this subject's (a `ref` field of theirs), which the caller may list and filter by that field, at a list route of their own (`GET /v1/<path>`; a record reached only through another's routes is left out): a record's related panels.",
      ),
    views: listViewsSchema,
  })
  .catchall(z.unknown())
  .describe(
    "A subject's list. Add-ons its records take add keys of their own (`attachmentLimits`, `documentTemplates`), each documented by its module.",
  );

export type ListField = z.infer<typeof listFieldSchema>;
export type ListMetadata = z.infer<typeof listMetadataSchema>;
