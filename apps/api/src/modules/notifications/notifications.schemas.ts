import { z } from 'zod';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { destinationProblem } from '../../core/http/safe-fetch.js';
import {
  emailSettingSchema,
  pushSettingSchema,
} from './notifications.preferences.js';

/** A notification as the API shows it: the texts in the request's language. */
export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string().meta({ example: 'note.published' }),
  title: z.string(),
  body: z.string(),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'What the texts were made from, and what a client needs to act on it.',
    ),
  link: z.string().nullable().describe('A path of the web app, or null.'),
  key: z.string().nullable().describe('The collapse key, when it has one.'),
  count: z
    .int()
    .describe('How many notifications this one stands for (collapsed).'),
  read: z.boolean(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NotificationView = z.infer<typeof notificationSchema>;
export const notificationPageSchema = pageSchema(notificationSchema);

export const unreadCountSchema = z.object({
  unread: z.int().meta({
    description:
      '`unread` stops at 1,000; `unreadCapped` is then true (show 1,000+).',
  }),
  unreadCapped: z.boolean(),
});

export const readAllSchema = z
  .object({
    before: z.iso
      .datetime()
      .optional()
      .describe(
        'Only those created before this moment (what the client has shown).',
      ),
  })
  .strict();
export type ReadAllDto = z.infer<typeof readAllSchema>;

export const testResultSchema = z.object({
  id: z.uuid().describe('The notification, delivered to you shortly.'),
});

export const readAllResultSchema = z.object({ updated: z.int() });

const emailDescription =
  'Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest.';
const pushDescription =
  'Users with a registered browser only, when web push is on: whether the notification is also pushed.';

/** The channels a user may set, with their settings. */
export const channelSettingsSchema = z.object({
  email: emailSettingSchema.optional().describe(emailDescription),
  push: pushSettingSchema.optional().describe(pushDescription),
});

/**
 * The same for the body of PUT. Loose, so a channel this schema doesn't know
 * (or one the caller can't set) reaches the service, which refuses it by name
 * (`<type>.<channel>`); the known ones are checked here.
 */
export const channelSettingsInputSchema = z.looseObject({
  email: emailSettingSchema.optional().describe(emailDescription),
  push: pushSettingSchema.optional().describe(pushDescription),
});

/** A declared type, as the catalog shows it to this caller. */
export const notificationTypeSchema = z.object({
  type: z.string().meta({ example: 'note.published' }),
  label: z.string().describe("In the request's language."),
  mandatory: z
    .boolean()
    .describe(
      'Its channels cannot be switched off (their frequency may change).',
    ),
  urgent: z.boolean().describe('Push goes through quiet hours at once.'),
  channels: channelSettingsSchema.describe(
    'The defaults of the channels you may set (in-app and realtime are always on).',
  ),
});
export const notificationTypeListSchema = listSchema(notificationTypeSchema);

/** Your effective settings, per type, for the channels you may set. */
export const preferencesViewSchema = z.object({
  types: z.record(z.string(), channelSettingsSchema).meta({
    example: { 'note.published': { email: 'daily' } },
  }),
});

/** The body of PUT: the full set of your overrides (checked against the declared types and your channels). */
export const preferencesInputSchema = z
  .record(z.string().max(100), channelSettingsInputSchema)
  .meta({ example: { 'note.published': { email: 'daily' } } })
  .describe(
    'Per type, the channels to change: a type or channel left out keeps its default.',
  );

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour clock');

/** The body of PUT /notifications/quiet-hours. */
export const quietHoursInputSchema = z
  .object({
    start: clock.meta({ example: '22:00' }),
    end: clock.meta({ example: '07:00' }),
  })
  .refine((value) => value.start !== value.end, {
    path: ['end'],
    message: 'The window must not be empty: start and end differ.',
  });
export type QuietHoursDto = z.infer<typeof quietHoursInputSchema>;

/** Your quiet hours, or null: push waits for the window to end (urgent types do not). */
export const quietHoursViewSchema = z.object({
  quietHours: z
    .object({
      start: clock,
      end: clock,
      timezone: z
        .string()
        .describe(
          "The time zone whose clock the window follows: yours, else the deployment's.",
        ),
    })
    .nullable(),
});

/**
 * The body of the one-click unsubscribe (RFC 8058 section 3.1): a mail client
 * posts the form `List-Unsubscribe=One-Click`. A JSON body with the same
 * field is read the same.
 */
export const unsubscribeSchema = z.object({
  'List-Unsubscribe': z
    .literal('One-Click')
    .describe('Always `One-Click` (RFC 8058).'),
});

/**
 * What an unsubscribe link stops (`GET`, the read-only twin of the POST): a
 * notification type, or a digest. Never the person's email or id.
 */
export const unsubscribeDescriptionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('type'),
      label: z
        .string()
        .nullable()
        .describe(
          "What the notification type is called, in the request's language. Null when the link would change nothing (the type is gone, or mandatory).",
        ),
    }),
    z.object({
      kind: z.literal('digest'),
      modes: z
        .array(z.enum(['hourly', 'daily']))
        .describe(
          'The digests the link stands for: every type the person gets in these modes.',
        ),
    }),
  ])
  .meta({ example: { kind: 'type', label: 'Note published' } });

/** The browser's PushSubscription, as `pushManager.subscribe()` returns it (`toJSON()`). */
export const registerDeviceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .meta({ example: 'Firefox on the laptop' }),
  subscription: z.object({
    endpoint: z
      .url()
      .max(2000)
      .refine((value) => destinationProblem(new URL(value)) === undefined, {
        message:
          'A push service URL: https, no credentials, not a private or metadata address.',
      })
      .describe(
        "The push service's URL. https only; private, loopback and metadata addresses are refused, also when a host name resolves to one at sending.",
      ),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(200),
    }),
  }),
});
export type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export const deviceListSchema = listSchema(deviceSchema);

export const webPushKeySchema = z.object({
  publicKey: z
    .string()
    .nullable()
    .describe(
      'The VAPID public key a browser subscribes with; null while web push is off.',
    ),
});

/** A record the caller watches. */
export const subscriptionSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  recordId: z
    .string()
    .meta({ example: '0199a3f2-0000-7000-8000-000000000000' }),
  createdAt: z.iso.datetime(),
});
export const subscriptionPageSchema = pageSchema(subscriptionSchema);
