import { z } from 'zod';

/** GET /search's query. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).meta({ example: 'dark mode -legacy' }),
    subject: z
      .string()
      .max(100)
      .optional()
      .describe('Only this kind of record (`Note`); default: every kind.'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    // The language switch of @nestjs/i18n (`?lang=`, core/i18n): the
    // subjects' labels come in it. Listed because the schema is strict.
    lang: z.string().max(35).optional(),
  })
  .strict();

/** One hit of GET /search. */
export const hitSchema = z.object({
  subject: z.string(),
  id: z.string(),
  title: z.string(),
  snippet: z.string().nullable(),
  score: z.number(),
  link: z.string().nullable(),
  subjectLabel: z
    .object({
      singular: z.string().meta({ example: 'Note' }),
      plural: z.string().meta({ example: 'Notes' }),
    })
    .describe('How the subject is named: one record and several.'),
});
