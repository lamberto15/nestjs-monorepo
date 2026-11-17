import { DiscoveryService } from '@nestjs/core';
import type { Principal } from '../auth/principal.js';

/**
 * Finds one record of a subject for the explanation of access
 * (GET /v1/access/users/{id}/explanation?recordId=): the record as its own
 * routes load it, or null when it doesn't exist or `visibleTo` may not
 * read it (the lookup's read filter). The module that owns the subject
 * marks a provider `@AccessRecordFinder('Note')`; a subject without one
 * takes no `recordId`.
 */
export interface RecordFinder {
  find(
    id: string,
    visibleTo: Principal,
  ): Promise<Record<string, unknown> | null>;
}

/** Marks the provider that finds the records of a subject (its name). */
export const AccessRecordFinder = DiscoveryService.createDecorator<string>();
