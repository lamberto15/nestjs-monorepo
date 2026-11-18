import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { WEBHOOK_SCOPES } from './webhooks.tables.js';

const eventTypes = z
  .array(z.string().max(200))
  .min(1)
  .max(100)
  .describe(
    'Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test.',
  );

/** Body of `POST /webhook-endpoints`. The package checks the URL and the types themselves. */
export const createEndpointSchema = z.object({
  url: z
    .string()
    .max(2048)
    .describe(
      'A public https:// URL. Private and cloud-metadata addresses are refused.',
    ),
  eventTypes,
  // Not empty: no description is its absence (or null on PATCH), never "".
  description: z.string().min(1).max(500).optional(),
});
export type CreateEndpointDto = z.infer<typeof createEndpointSchema>;

/** Body of `PATCH /webhook-endpoints/:id`: only what is sent changes. */
export const updateEndpointSchema = z.object({
  url: z.string().max(2048).optional(),
  eventTypes: eventTypes.optional(),
  description: z
    .string()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe(
      'null clears it (an empty string is refused: 400); absent leaves it as it is.',
    ),
  enabled: z.boolean().optional(),
});
export type UpdateEndpointDto = z.infer<typeof updateEndpointSchema>;

/** Body of `POST /webhook-deliveries/retry`: every failed delivery since an outage began. */
export const retryDeliveriesSchema = z.object({
  endpointId: z
    .string()
    .optional()
    .describe("One endpoint's failed deliveries; every endpoint's without it."),
  since: z.iso
    .datetime()
    .optional()
    .describe(
      'Deliveries created at or after this time: the start of the outage.',
    ),
});
export type RetryDeliveriesDto = z.infer<typeof retryDeliveriesSchema>;

const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;

const epochMs = z.number().describe('Epoch milliseconds.');
const isoTime = z.iso.datetime();

/** A webhook endpoint, as the API returns it (never with its secret). */
export const webhookEndpointSchema = z.object({
  id: z.string(),
  tenant: z.string().nullable(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  description: z.string().nullable(),
  enabled: z.boolean(),
  disabledReason: z.enum(['manual', 'failing', 'gone']).nullable(),
  failingSince: epochMs.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
});

/** `POST /webhook-endpoints`: the endpoint and its secret, shown this once. */
export const createdWebhookEndpointSchema = webhookEndpointSchema.extend({
  secret: z
    .string()
    .describe(
      'Standard Webhooks whsec_…: verify the signatures with it. Shown this once.',
    ),
});

export const rotatedSecretSchema = z.object({
  secret: z
    .string()
    .describe(
      'The new whsec_…. The old one keeps signing next to it for 24 hours.',
    ),
});

/** A signing secret, by its creation time: its identifier. Never the secret. */
export const signingSecretSchema = z.object({
  createdAt: isoTime.describe(
    "When the secret was made (the creation or the rotation that issued it): its identifier, to match with the rotations' times.",
  ),
  expiresAt: isoTime
    .nullable()
    .describe(
      'When it stops signing: a rotated-out secret, 24 hours after the rotation; null for the current one.',
    ),
});

/** One delivery of a message to an endpoint. */
export const webhookDeliverySchema = z.object({
  id: z.string(),
  messageId: z
    .string()
    .describe('The webhook-id header: the same on every attempt and replay.'),
  endpointId: z.string(),
  tenant: z.string().nullable(),
  type: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.int(),
  nextAttemptAt: isoTime.nullable(),
  lastAttemptAt: isoTime.nullable(),
  lastStatusCode: z.int().nullable(),
  lastError: z.string().nullable(),
  failureReason: z
    .enum(['exhausted', 'rejected', 'endpoint-disabled', 'endpoint-deleted'])
    .nullable(),
  createdAt: isoTime,
  completedAt: isoTime.nullable(),
});

/** A delivery with the message that was sent and every attempt. */
export const webhookDeliveryDetailsSchema = webhookDeliverySchema.extend({
  message: z.object({
    id: z.string(),
    type: z.string(),
    tenant: z.string().nullable(),
    body: z.string().describe('The exact JSON that was signed and sent.'),
    createdAt: isoTime,
  }),
  history: z.array(
    z.object({
      deliveryId: z.string(),
      attempt: z.int(),
      at: isoTime,
      durationMs: z.number(),
      statusCode: z.int().nullable(),
      response: z
        .string()
        .nullable()
        .describe('The first 4 KB of the response body.'),
      error: z.string().nullable(),
    }),
  ),
});

/**
 * `GET …/webhook-deliveries/{id}`: the delivery with its message, every
 * attempt, the time they took and the request last sent.
 */
export const webhookDeliveryViewSchema = webhookDeliveryDetailsSchema.extend({
  durationMs: z
    .number()
    .describe('Every attempt of the log together, in milliseconds.'),
  lastRequest: z
    .object({
      attempt: z.int().describe('1-based, within its round.'),
      sentAt: isoTime,
      headers: z
        .record(z.string(), z.string())
        .describe(
          'As sent: webhook-id, webhook-timestamp, webhook-signature (v1,… per live secret), content-type, user-agent. Never the secret.',
        ),
      signedWith: z
        .array(signingSecretSchema)
        .nullable()
        .describe(
          'The secrets that signed that attempt, newest first, in the order of the v1,… signatures: one normally, two during the overlap after a rotation. Identified by when each was made, never revealed. Null: not recorded (a delivery from before this was kept).',
        ),
    })
    .nullable()
    .describe('The request of the latest attempt; null before the first.'),
});

/** `GET /v1/webhook-event-types`: what an endpoint may subscribe to, by feature. */
export const webhookEventTypesSchema = z.object({
  items: z.array(
    z.object({
      group: z
        .string()
        .describe("The module that owns them: the types' first segment."),
      types: z.array(
        z.object({
          type: z.string().meta({ example: 'note.published' }),
          description: z.string(),
          subject: z
            .string()
            .describe('What a client must be allowed to read to receive it.'),
        }),
      ),
    }),
  ),
});

export const retriedSchema = z.object({
  retried: z.int().describe('How many deliveries were sent again.'),
});

// Incoming webhooks of a tenant's own senders.

/** A sender's name: the last segment of its URL. */
const senderName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62})$/, {
    message: 'Lower-case letters, digits and hyphens, at most 63 characters.',
  })
  .meta({ example: 'billing-system' });

/** A tenant's incoming webhook sender, never with its secret. */
export const incomingSenderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    path: z
      .string()
      .describe(
        'Where the sender POSTs, under the API origin: `/v1/webhooks/tenants/{tenantId}/senders/{name}`.',
      ),
    previousSecretExpiresAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'While set and in the future, the secret before the last rotation still verifies.',
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'IncomingWebhookSender' });

/** A sender with its secret: shown once, at creation and at rotation. */
export const createdIncomingSenderSchema = incomingSenderSchema
  .extend({
    secret: z
      .string()
      .describe(
        'The `whsec_…` signing secret (Standard Webhooks). Shown this once.',
      ),
  })
  .meta({ id: 'CreatedIncomingWebhookSender' });

export const incomingSenderListSchema = listSchema(incomingSenderSchema).meta({
  id: 'IncomingWebhookSenderList',
});

/** Body of `POST /webhook-senders`. */
export const createIncomingSenderSchema = z.object({
  name: senderName,
  description: z.string().trim().min(1).max(500).optional(),
});
export type CreateIncomingSenderDto = z.infer<
  typeof createIncomingSenderSchema
>;

/** Body of `PATCH /webhook-senders/{id}`: only what is sent changes. */
export const updateIncomingSenderSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe('null clears it.'),
  enabled: z
    .boolean()
    .optional()
    .describe('false: the sender is refused (401) until it is enabled again.'),
});
export type UpdateIncomingSenderDto = z.infer<
  typeof updateIncomingSenderSchema
>;

/** Body of `POST /webhook-senders/{id}/rotate-secret`. */
export const rotateIncomingSenderSchema = z.object({
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600)
    .default(24 * 3600)
    .describe(
      'How long the old secret keeps verifying (default 24 hours; 0: it stops now).',
    ),
});
export type RotateIncomingSenderDto = z.infer<
  typeof rotateIncomingSenderSchema
>;

/** The answer of the receiver route. */
export const incomingEventResultSchema = z
  .object({
    received: z.literal(true),
    duplicate: z.boolean(),
    handled: z
      .boolean()
      .describe(
        'false: no handler is registered for the event type (acknowledged and ignored, so the sender does not retry).',
      ),
  })
  .meta({ id: 'IncomingWebhookResult' });

/** What a tenant sender POSTs: Standard Webhooks headers, and this envelope. */
export const incomingEventSchema = z.object({
  type: z.string().min(1).max(200).meta({ example: 'note.publish-requested' }),
  data: z.unknown(),
});
export type IncomingEvent = z.infer<typeof incomingEventSchema>;

/** `GET /v1/webhook-incoming-event-types`: what a sender may send, generated from the handlers. */
export const incomingEventTypesSchema = z
  .object({
    items: z.array(
      z.object({
        type: z.string().meta({ example: 'note.publish-requested' }),
        description: z.string(),
        dataSchema: z
          .record(z.string(), z.unknown())
          .describe("JSON Schema of the envelope's `data`."),
        example: z
          .object({ type: z.string(), data: z.unknown() })
          .describe('A complete, safe request body.'),
        delivery: z
          .string()
          .describe('Deduplication and acknowledgement semantics.'),
      }),
    ),
  })
  .meta({ id: 'IncomingWebhookEventTypes' });

/** `GET`/`PUT /access/clients/{clientId}/webhook-scope`: which records' events the client's endpoints receive. */
export const webhookScopeSchema = z.object({
  scope: z
    .enum(WEBHOOK_SCOPES)
    .describe(
      "own (the default): only the records the client owns. tenant: also its tenant's records owned by users and other clients, each only when the client may read it, without the fields it may not read.",
    ),
});
export type WebhookScopeDto = z.infer<typeof webhookScopeSchema>;
