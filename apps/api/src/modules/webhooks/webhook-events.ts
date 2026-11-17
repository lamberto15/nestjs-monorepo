import { DiscoveryService } from '@nestjs/core';
import type { z } from 'zod';
import type { DomainEvent } from '../../core/outbox/events.js';

/**
 * A domain event that API clients may receive as a webhook, declared by the
 * module that owns the event, in its own imports:
 * `WebhooksModule.forFeature([{ event: noteCreated, … }])` (README.md).
 */
export interface WebhookEvent<P = unknown> {
  /** The domain event (core/outbox); its type is the webhook's. */
  event: DomainEvent<P>;
  /** What the event types catalog says of it. */
  description: string;
  /**
   * The public payload, the webhook's `data`: the event's payload parsed
   * with it, so a key it doesn't declare never leaves the app (Zod objects
   * drop unknown keys).
   */
  data: z.ZodType;
  /**
   * The subject a client must be allowed to `read` to receive it, with
   * `data` as the record: conditions decide per event, and the fields
   * the client may not read are left out.
   */
  subject: string;
}

/** The webhook events a provider of `forFeature()` carries: how the catalog finds them. */
export const WebhookEvents =
  DiscoveryService.createDecorator<readonly WebhookEvent<unknown>[]>();

/**
 * The reserved test event (`POST …/webhook-endpoints/{id}/test`): not in
 * the catalog, so subscribing to it is a 400; it reaches only the endpoint
 * it was sent to.
 */
export const TEST_EVENT_TYPE = 'webhook.test';
