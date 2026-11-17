import { z } from 'zod';

const markSchema = z.string().trim().min(1).max(40);

/** What a record with marks shows: the response shape the feature's schemas spread in. */
export const MARKS_RESPONSE = {
  marks: z
    .array(z.string())
    .describe('Its marks, by name (PUT …/{id}/marks sets them).'),
  lastMark: z
    .string()
    .nullable()
    .describe('The last mark a create or an update set.'),
};

/** What marks read from a record's create and update bodies (each optional). */
export const MARKS_BODY = {
  marks: z
    .array(markSchema)
    .max(10)
    .describe('Its marks: replaces them on an update.'),
};

export const setMarksSchema = z.object({
  marks: z.array(markSchema).max(10),
});
