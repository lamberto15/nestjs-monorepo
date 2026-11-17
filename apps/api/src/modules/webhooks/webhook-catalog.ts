import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { type WebhookEvent, WebhookEvents } from './webhook-events.js';

/**
 * Every webhook event the app's modules declared (`WebhooksModule.forFeature()`),
 * found through DiscoveryService: what an endpoint may subscribe to and what
 * `GET /v1/webhook-event-types` lists. No central list.
 */
@Injectable()
export class WebhookCatalog {
  private declared?: ReadonlyMap<string, WebhookEvent>;

  constructor(private readonly discovery: DiscoveryService) {}

  /** The declared types, sorted. */
  types(): string[] {
    return [...this.events().keys()].sort();
  }

  has(type: string): boolean {
    return this.events().has(type);
  }

  /** By group (a type's first segment, the module that owns it), each sorted. */
  groups() {
    const groups = new Map<
      string,
      { type: string; description: string; subject: string }[]
    >();
    for (const type of this.types()) {
      const { description, subject } = this.events().get(type)!;
      const group = type.split('.')[0]!;
      groups.set(group, [
        ...(groups.get(group) ?? []),
        { type, description, subject },
      ]);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, types]) => ({ group, types }));
  }

  private events(): ReadonlyMap<string, WebhookEvent> {
    if (this.declared) return this.declared;
    const found = new Map<string, WebhookEvent>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: WebhookEvents.KEY,
    })) {
      for (const event of this.discovery.getMetadataByDecorator(
        WebhookEvents,
        wrapper,
      ) ?? []) {
        if (found.has(event.event.type)) {
          throw new Error(
            `The webhook event ${event.event.type} is declared twice (WebhooksModule.forFeature()).`,
          );
        }
        found.set(event.event.type, event);
      }
    }
    this.declared = found;
    return found;
  }
}
