import { z } from 'zod';

/** At most this many people in one request, and per version of a document. */
export const MAX_RECIPIENTS = 100;
export const MAX_PER_VERSION = 500;

/** Body of `POST /v1/<records>/{id}/acknowledgment-requests`. */
export const acknowledgmentRequestSchema = z.object({
  recipients: z
    .array(z.string().regex(/^user:[0-9a-f-]{36}$/))
    .min(1)
    .max(MAX_RECIPIENTS)
    .describe('The people asked, as `user:<id>`.'),
  dueAt: z.iso
    .datetime()
    .optional()
    .describe('The deadline; in the future. Asking again replaces it.'),
});
export type AcknowledgmentRequestDto = z.infer<
  typeof acknowledgmentRequestSchema
>;

/** Body of `POST /v1/<records>/{id}/acknowledgments/remind`. */
export const acknowledgmentRemindSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    recipients: z
      .array(z.string())
      .max(MAX_RECIPIENTS)
      .optional()
      .describe('Only these; default: everyone who has not acknowledged.'),
  }),
);
export type AcknowledgmentRemindDto = { recipients?: string[] };

/** The version a request or an answer is for (default: the current one). */
export const acknowledgmentVersionQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});
export type AcknowledgmentVersionQuery = z.infer<
  typeof acknowledgmentVersionQuerySchema
>;

export const acknowledgmentStatusQuerySchema = z.object({
  status: z.enum(['pending', 'acknowledged']).default('pending'),
});
export type AcknowledgmentStatusQuery = z.infer<
  typeof acknowledgmentStatusQuerySchema
>;

/** One person's acknowledgment of one version of a record. */
export const acknowledgmentSchema = z.object({
  id: z.string(),
  subject: z.string(),
  recordId: z.string(),
  version: z.number().int(),
  recipient: z.string(),
  recipientName: z.string().nullable(),
  requestedBy: z.string(),
  dueAt: z.iso.datetime().nullable(),
  overdue: z.boolean().describe('Not acknowledged, and past `dueAt`.'),
  reminders: z.number().int(),
  lastRemindedAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AcknowledgmentView = z.infer<typeof acknowledgmentSchema>;

/** The completion dashboard of one version of a record. */
export const acknowledgmentStatusSchema = z.object({
  recordId: z.string(),
  version: z.number().int(),
  total: z.number().int(),
  acknowledged: z.number().int(),
  pending: z.number().int(),
  overdue: z.number().int(),
  items: z.array(acknowledgmentSchema),
});

/** An acknowledgment asked of the caller, with the record it is about. */
export const myAcknowledgmentSchema = acknowledgmentSchema.extend({
  title: z.string().describe("The record's title or name."),
  link: z.string().describe('The record in the web app.'),
});
export type MyAcknowledgmentView = z.infer<typeof myAcknowledgmentSchema>;

export const myAcknowledgmentListSchema = z.object({
  items: z.array(myAcknowledgmentSchema),
});

export const acknowledgmentRemindResultSchema = z.object({
  reminded: z.number().int(),
  skipped: z.number().int().describe('Reminded in the last 24 hours already.'),
});
