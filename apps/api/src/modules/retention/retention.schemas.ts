import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';

/** A declared rule and the tenant's choice for it. */
export const retentionRuleSchema = z
  .object({
    name: z.string().meta({ example: 'note' }),
    label: z.string().meta({ example: 'Notes' }),
    subject: z.string().meta({ example: 'Note' }),
    action: z.enum(['purge', 'anonymise']),
    defaultDays: z.int(),
    minDays: z.int(),
    enabled: z.boolean().describe('False until the tenant turns the rule on.'),
    days: z
      .int()
      .describe('The days in force: the tenant’s, else the default.'),
    lastRunAt: z.iso.datetime().nullable(),
    lastCount: z
      .int()
      .nullable()
      .describe('Records the last run purged or anonymised.'),
  })
  .meta({ id: 'RetentionRule' });

export const retentionRuleListSchema = listSchema(retentionRuleSchema).meta({
  id: 'RetentionRuleList',
});

/** Body of `PUT /retention/rules/{name}`. */
export const setRetentionSchema = z.object({
  enabled: z.boolean(),
  days: z
    .int()
    .min(1)
    .max(36_500)
    .optional()
    .describe('Left out: the days already in force.'),
});
export type SetRetentionDto = z.infer<typeof setRetentionSchema>;

/** Query of `GET /retention/rules/{name}/preview`. */
export const previewRetentionSchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(36_500)
    .optional()
    .describe('Try other days; left out: the days in force.'),
});
export type PreviewRetentionDto = z.infer<typeof previewRetentionSchema>;

/** What a run would do now (`GET /retention/rules/{name}/preview`). */
export const retentionPreviewSchema = z
  .object({
    name: z.string(),
    days: z.int().describe('The days the count is for.'),
    before: z.iso.datetime().describe('Records dated before this are due.'),
    due: z.int().describe('Records a run would purge or anonymise now.'),
    held: z
      .int()
      .describe('Due records a legal hold keeps, which a run leaves alone.'),
  })
  .meta({ id: 'RetentionPreview' });
