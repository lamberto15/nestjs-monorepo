import { DiscoveryService } from '@nestjs/core';
import type { Principal } from '../../iam/auth/principal.js';

/** A hit of the global search: a record, as a result list shows it. */
export interface SearchHit {
  subject: string;
  id: string;
  title: string;
  /** Around the matches, the matches in <b>…</b>; null when the caller may not read the text. */
  snippet: string | null;
  /** How well it matches: 0 to 1. */
  score: number;
  /** Where to go: a path of the web app. */
  link: string | null;
  /** How the subject is named: one record and several. */
  subjectLabel: { singular: string; plural: string };
}

/** What a module adds to the global search besides the records: files, say. */
export interface SearchSourceProvider {
  /** The caller's matches, best first, at most `limit`, of what they may read. */
  search(
    principal: Principal,
    q: string,
    options: { limit: number },
  ): Promise<SearchHit[]>;
}

/**
 * Marks an injectable implementing `SearchSourceProvider` as a source of
 * `GET /v1/search` for the subject given (`@SearchSource('Attachment')`):
 * SearchService merges its hits with the records', best first, and asks it
 * only when `?subject=` is absent or names that subject.
 */
export const SearchSource = DiscoveryService.createDecorator<string>();
