import { z } from 'zod';
import { BREAK_GLASS_MAX_MINUTES } from './break-glass.service.js';

export const breakGlassGrantSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

export const startBreakGlassSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(10)
    .max(1000)
    .describe('Why: kept with the grant and in both tenants’ logs.'),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(BREAK_GLASS_MAX_MINUTES)
    .optional()
    .describe(
      `At most ${BREAK_GLASS_MAX_MINUTES}, the default; never extended.`,
    ),
});

export const breakGlassGrantsSchema = z.object({
  items: z.array(breakGlassGrantSchema),
});
