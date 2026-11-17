import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Principal } from '../../iam/auth/principal.js';

/** One thing waiting on a person, as its source reports it. */
export interface InboxEntry {
  /** The source's own id for it (a request's, a notification's): a UUIDv7, which orders the whole list. */
  id: string;
  /** When it came to the person, shown with the item. */
  at: Date;
  /** What kind of work it is, for the client to word: `approval.decide`. */
  kind: string;
  /** What the client words it with (titles, names), nothing the person may not read. */
  data: Record<string, unknown>;
  /** Where to do it, a path of the web app. */
  link: string | null;
  dueAt: Date | null;
  subject?: string;
  recordId?: string;
  /** Two entries with the same value are one piece of work: the newest is kept. */
  dedupe?: string;
}

/**
 * Something that gives people work to do (approvals waiting on them,
 * mentions…), shown in their inbox (`GET /v1/inbox`). A source reads the
 * authoritative state (it keeps no copy), returns only what this principal
 * may see and still has to do, and says how an item is dismissed, if it can
 * be.
 */
export interface InboxSource {
  /** Up to `limit` entries, newest first (by `id`, descending), after the id `after`. */
  items(
    principal: Principal,
    page: { limit: number; after?: string },
  ): Promise<InboxEntry[]>;
  /** Dismisses one of the principal's entries (mark it read); absent: it is done at its source only. */
  dismiss?(principal: Principal, id: string): Promise<void>;
}

/**
 * Marks a provider as an inbox source, named `approval` or `mention` (part of
 * every item's key, so no `:`):
 *
 * ```ts
 * @InboxSourceOf('mention')
 * @Injectable()
 * export class MentionInbox implements InboxSource { … }
 * ```
 */
export const InboxSourceOf = DiscoveryService.createDecorator<string>();

/** The registered sources, found at startup (a name twice stops the app). */
@Injectable()
export class InboxSources implements OnModuleInit {
  private readonly sources = new Map<string, InboxSource>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: InboxSourceOf.KEY,
    })) {
      const name = this.discovery.getMetadataByDecorator(
        InboxSourceOf,
        wrapper,
      );
      if (!name || !wrapper.instance) continue;
      if (this.sources.has(name) || name.includes(':')) {
        throw new Error(
          `Two inbox sources are named "${name}", or the name has a colon.`,
        );
      }
      this.sources.set(name, wrapper.instance as InboxSource);
    }
  }

  all() {
    return [...this.sources].map(([name, source]) => ({ name, source }));
  }

  find(name: string) {
    return this.sources.get(name);
  }
}
