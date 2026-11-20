import { z } from 'zod';

/** Records GET /v1/lists/{subject}/options answers at most, and the ids `id=` names at most. */
export const MAX_OPTIONS = 20;

/** `a,b,c`: the items, trimmed, without empty ones. */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/** The query of GET /v1/lists/{subject}/options. */
export const recordOptionsQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Part of the title, any case (`%` and `_` are themselves). Absent: the first by title. Not with `id`.',
      )
      .meta({ example: 'acme' }),
    id: commaList
      .pipe(z.array(z.uuid()).min(1).max(MAX_OPTIONS))
      .optional()
      .describe(
        `Ids to name instead of a search, comma-separated, ${MAX_OPTIONS} at most. One you may not read, or no record has, is left out (no error). Not with \`q\`; \`limit\` doesn't apply.`,
      ),
    limit: z.coerce.number().int().min(1).max(MAX_OPTIONS).default(10),
    lang: z.string().max(35).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.q !== undefined && query.id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: '`q` searches, `id` names: send one of them',
        input: query.id,
      });
    }
  });

export type RecordOptionsQuery = z.infer<typeof recordOptionsQuerySchema>;

/** A record as a picker shows it. */
export const recordOptionSchema = z.object({
  id: z.uuid(),
  title: z
    .string()
    .nullable()
    .describe(
      "What it is called: its first text field, null when it has none or you may not read it (name it by its id then). The same `title` as a reference's `?include=`.",
    ),
});
