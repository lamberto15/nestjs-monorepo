import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { IncomingWebhook } from '@nestjs/webhooks';
import { z } from 'zod';
import type { IncomingEvent } from './webhooks.schemas.js';

/** What a handler is given: the verified event, and who sent it. */
export interface IncomingEventContext {
  /** The sender's tenant: the work already runs in it. */
  tenantId: string;
  /** The sender's name in that tenant. */
  sender: string;
  /** Verified; `processInTransaction()` records its id for exactly-once effects. */
  webhook: IncomingWebhook<IncomingEvent>;
}

/**
 * An incoming event type, declared once next to its handler: the receiver
 * validates `data` with `data`, and the catalog
 * (`GET /v1/webhook-incoming-event-types`) is generated from it.
 */
export interface IncomingEventDefinition {
  description: string;
  /** The shape of the envelope's `data`; a body that doesn't match is a 400. */
  data: z.ZodType;
  /** A safe `data` for the docs; it must satisfy `data`. */
  example: unknown;
  /** What the sender may rely on: deduplication and acknowledgement. */
  delivery: string;
}

/**
 * Marks a provider's method as the handler of an incoming event `type`
 * from a tenant's senders. It runs in the sender's tenant with an
 * `IncomingEventContext`; its result may be `{ duplicate }` (from
 * `processInTransaction()`). A listed type documents, it doesn't permit:
 * the sender's signature lets it call, the handler authorizes the work.
 *
 * ```ts
 * @OnIncomingWebhook('note.publish-requested', { description, data: z.object({ noteId: z.uuid() }), example, delivery })
 * async publish({ webhook }: IncomingEventContext) { … }
 * ```
 */
export const OnIncomingWebhook = DiscoveryService.createDecorator<
  IncomingEventDefinition & { type: string }
>();

type Handler = (context: IncomingEventContext) => Promise<unknown>;

/** Every `@OnIncomingWebhook()` method of the app, by type (DiscoveryService: no registry to call). */
@Injectable()
export class IncomingEventHandlers implements OnModuleInit {
  private readonly handlers = new Map<
    string,
    { definition: IncomingEventDefinition; handle: Handler }
  >();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (
        !instance ||
        typeof instance !== 'object' ||
        !wrapper.isDependencyTreeStatic()
      )
        continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const declared = this.discovery.getMetadataByDecorator(
          OnIncomingWebhook,
          wrapper,
          method,
        );
        if (!declared) continue;
        const { type, ...definition } = declared;
        if (this.handlers.has(type)) {
          throw new Error(`Two handlers of the incoming event "${type}".`);
        }
        const fn = instance[method] as Handler;
        this.handlers.set(type, {
          definition,
          handle: (context) => fn.call(instance, context),
        });
      }
    }
  }

  find(type: string) {
    return this.handlers.get(type);
  }

  /** The registered types, documented, by type. */
  catalog() {
    return [...this.handlers]
      .map(([type, { definition }]) => ({
        type,
        description: definition.description,
        dataSchema: z.toJSONSchema(definition.data, {
          target: 'openapi-3.0',
        }) as Record<string, unknown>,
        example: { type, data: definition.example },
        delivery: definition.delivery,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }
}
