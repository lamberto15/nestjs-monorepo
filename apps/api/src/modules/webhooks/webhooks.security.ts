import { Injectable } from '@nestjs/common';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import { z } from 'zod';
import { OnDomainEvent } from '../../core/outbox/events.js';
import { apiKeyRotated } from '../../iam/api-clients/api-clients.events.js';
import { type WebhookEvent, WebhookEvents } from './webhook-events.js';
import { WebhookPublisher } from './webhook-publisher.js';

/**
 * `security.api-key-rotated` as a webhook to the rotated client only: a new
 * key, and when its previous keys stop working. iam/api-clients owns the
 * event but may not import this module (core ← iam ← modules), so the
 * declaration `WebhooksModule.forFeature()` would make lives here, relayed
 * the same way. `ApiKey.read` is every client's for its own keys
 * (iam/api-clients' permissions), so no other client receives it.
 */
const API_KEY_ROTATED: WebhookEvent = {
  event: apiKeyRotated,
  subject: 'ApiKey',
  description:
    "This client's keys were rotated: a new key, and when the previous ones stop working.",
  data: z.object({
    clientId: z.uuid(),
    keyId: z.string(),
    previousKeysEnd: z.iso.datetime(),
  }),
};

@WebhookEvents([API_KEY_ROTATED])
@Injectable()
export class SecurityWebhooks {
  constructor(private readonly publisher: WebhookPublisher) {}

  @OnDomainEvent(apiKeyRotated, { consumer: 'webhooks-relay' })
  relay(
    payload: NonNullable<(typeof apiKeyRotated)['payload']>,
    ctx: OutboxHandlerContext,
  ) {
    return this.publisher.publish(API_KEY_ROTATED, payload, ctx);
  }
}
