import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { secretColumns } from '../../core/database/secret-columns.js';

/** A signing secret as recorded: when it was made (its identifier) and when it stops signing, in epoch ms. */
export interface SigningSecret {
  createdAt: number;
  expiresAt: number | null;
}

/**
 * The request each outgoing delivery last sent: its headers (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`, content type, user agent;
 * never a secret) and which secrets signed it, written by the transport
 * before each attempt (webhook.transport.ts), one row per delivery, read
 * with the delivery.
 *
 * Custom: @nestjs/webhooks logs each attempt's status, duration and
 * response, not the request. Not a tenant table: the worker writes outside
 * any tenant, and a row is only read after the package's tenant-scoped
 * `get()` found its delivery.
 */
export const webhookDeliveryRequests = pgTable('webhook_delivery_requests', {
  /** The package's delivery id (`dlv_…`). */
  deliveryId: text('delivery_id').primaryKey(),
  /** 1-based, within the delivery's round (a manual retry starts at 1 again). */
  attempt: integer('attempt').notNull(),
  headers: jsonb('headers').$type<Record<string, string>>().notNull(),
  /** Newest first, in the order of the `v1,…` signatures; null when it couldn't be told. */
  signedWith: jsonb('signed_with').$type<SigningSecret[]>(),
  sentAt: at('sent_at').notNull().defaultNow(),
});

/**
 * The senders of a tenant's incoming webhooks (`POST
 * /v1/webhooks/tenants/{tenantId}/senders/{name}`): a name unique in the
 * tenant and the Standard Webhooks secret its calls are signed with, sealed
 * (core/encryption) and never shown after creation or rotation. After a
 * rotation the previous secret still verifies until
 * `previousSecretExpiresAt`.
 */
export const incomingWebhookSenders = tenantTable(
  'incoming_webhook_senders',
  {
    id: uuidPk(),
    /** The URL segment: lower-case letters, digits and hyphens. */
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    secret: encryptedText('secret').notNull(),
    previousSecret: encryptedText('previous_secret'),
    previousSecretExpiresAt: at('previous_secret_expires_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('incoming_webhook_senders_name_idx').on(t.tenantId, t.name),
  ],
);

encrypted(incomingWebhookSenders.secret);
// Bound as `secret`: a rotation moves the sealed value to this column as it is.
encrypted(incomingWebhookSenders.previousSecret, {
  aad: 'incoming_webhook_senders.secret',
});

/** `own`: the records the client owns; `tenant`: every record of its tenant it may read. */
export const WEBHOOK_SCOPES = ['own', 'tenant'] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

/**
 * Which records' events an API client's endpoints receive: `own`, the
 * default (no row), only the records the client owns; `tenant`, also the
 * records users and other clients of its tenant own, each only when the
 * client may `read` it, redacted to what it may read (WebhookPublisher).
 * Per client, not per endpoint: the package fans a message out to every
 * subscribed endpoint of the client. The client's deletion takes the row
 * along.
 */
export const webhookClientScopes = tenantTable(
  'webhook_client_scopes',
  {
    id: uuidPk(),
    clientId: uuid('client_id').notNull(),
    scope: text('scope').$type<WebhookScope>().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('webhook_client_scopes_client_idx').on(t.tenantId, t.clientId),
    tenantReference(
      'webhook_client_scopes_client_fk',
      [t.tenantId, t.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
);

secretColumns(incomingWebhookSenders, [
  incomingWebhookSenders.secret,
  incomingWebhookSenders.previousSecret,
]);
