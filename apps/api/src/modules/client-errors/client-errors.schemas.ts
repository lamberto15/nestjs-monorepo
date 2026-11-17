import { z } from 'zod';

/** The web app's error sources (apps/web/src/lib/report-error.ts's ErrorSource). */
export const errorSource = z.enum([
  'uncaught',
  'caught',
  'recoverable',
  'window',
  'rejection',
  'request',
  'route',
]);

/**
 * The web app's report: its own id (so a user can quote it), where it was
 * heard, the error's message and stack, and the route it happened on. Every
 * string is capped well under the JSON body limit (core/http/body-limit.ts):
 * a report is a few lines, not a dump.
 */
export const clientErrorReportSchema = z.object({
  id: z.string().min(1).max(32),
  source: errorSource,
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(2000),
});
