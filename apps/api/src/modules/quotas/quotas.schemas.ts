import { z } from 'zod';

const amount = z.number().int().min(0);
const planName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'Lower case words joined by "-".');

export const planNameSchema = planName;

export const planSchema = z.object({
  name: z.string(),
  limits: z.record(z.string(), amount),
});

export const setPlanSchema = z.object({
  limits: z
    .record(z.string(), amount)
    .describe(
      'Quota key to limit; a quota left out falls back to its default.',
    ),
});

export const setTenantQuotasSchema = z
  .object({
    plan: planName
      .nullable()
      .optional()
      .describe('The plan the tenant is on; null: the default plan.'),
    limits: z
      .record(z.string(), amount.nullable())
      .optional()
      .describe(
        'The tenant’s own limits by quota key: a number sets one (0: none allowed), null removes it (its plan’s holds again), a key left out stays.',
      ),
  })
  .strict();
export type SetTenantQuotas = z.infer<typeof setTenantQuotasSchema>;

const statusSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['stock', 'rate']),
  period: z.enum(['day', 'month']).nullable(),
  used: z.number().int(),
  limit: z.number().int().nullable().describe('Null: unlimited.'),
  resetsAt: z.iso
    .datetime()
    .nullable()
    .describe('When a rate quota starts again.'),
});

export const tenantQuotasSchema = z.object({
  tenantId: z.uuid(),
  plan: z.string().nullable(),
  limits: z
    .record(z.string(), z.number().int())
    .describe("The tenant's own limits."),
  quotas: z.array(statusSchema),
});
