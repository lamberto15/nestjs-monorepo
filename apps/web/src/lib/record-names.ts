import { unwrap } from '@nestjs-monorepo/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { OptionSearch } from '@/lib/data-table-types';
import { createBatcher, type Names, useNames } from '@/lib/people';

/**
 * Records as pickers and cells name them, by subject: `GET
 * /v1/lists/{subject}/options` searches their titles (`q`) and names their
 * ids (`id=`), among the records the user may read. A reference field of
 * any feature (`ref` in GET /v1/lists/{subject}: a record's subject) uses
 * it: its filter, its column, its form control, its detail.
 */
export const recordsKey = ['record-options'] as const;

/** The most ids `id=` takes at once, and the most a search gives. */
const BATCH = 20;
/** The longest `q` the route takes (a longer one is a 400). */
const MAX_TERM = 100;
/** Titles rarely change; a page doesn't need a new one each time. */
const NAME_STALE_MS = 5 * 60_000;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** A record as a picker shows it: its title, else its id. */
export interface RecordOption {
  id: string;
  title: string | null;
}

/**
 * Filters of the subject's own list, as its route takes them
 * (`{ productId }`: one product's statuses): a picker that depends on
 * another field. An empty value is left out.
 */
export type RecordFilter = Record<string, string | null | undefined>;

const sent = (filter: RecordFilter = {}) =>
  Object.fromEntries(
    Object.entries(filter)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const options = (
  subject: string,
  query: { q?: string; id?: string; limit?: number },
  filter: RecordFilter = {},
) =>
  unwrap(
    api.GET('/v1/lists/{subject}/options', {
      // The filters are the list's own parameters (any name the list declares).
      params: { path: { subject }, query: { ...sent(filter), ...query } },
    }),
  ).then(({ items }) => items as RecordOption[]);

// One batcher per subject: the ids a page's cells ask within a tick, one request.
const askers = new Map<string, (id: string) => Promise<string | null>>();
const askerOf = (subject: string) => {
  let ask = askers.get(subject);
  if (!ask) {
    ask = createBatcher<string>(BATCH, async (ids) => {
      const items = await options(subject, { id: ids.join(',') });
      return new Map(items.map((item) => [item.id, item.title ?? item.id]));
    });
    askers.set(subject, ask);
  }
  return ask;
};

/** One record's title by id (null: none the user may read). */
export const recordNameQuery = (subject: string) => (id: string) =>
  queryOptions({
    queryKey: [...recordsKey, subject, 'name', id],
    queryFn: () => askerOf(subject)(id),
    staleTime: NAME_STALE_MS,
    gcTime: 2 * NAME_STALE_MS,
    retry: false,
    meta: { errorToast: false },
  });

/** The titles of these ids of `subject`'s records: the id itself until known. */
export function useRecordNames(
  subject: string,
  ids: readonly (string | null | undefined)[],
): Names {
  return useNames(ids, UUID, recordNameQuery(subject));
}

/** The records whose title holds `term`, by title (the first ones for none), among those `filter` keeps. */
const search = (subject: string, term: string, filter?: RecordFilter) => {
  const q = term.trim().slice(0, MAX_TERM);
  const kept = sent(filter);
  return {
    queryKey: [...recordsKey, subject, 'search', q, kept] as const,
    queryFn: () =>
      options(subject, q ? { q, limit: BATCH } : { limit: BATCH }, kept),
  };
};

/** `subject`'s records found for `term`, for a picker of its own (RecordPicker). */
export const recordSearchQuery = (
  subject: string,
  term: string,
  filter?: RecordFilter,
) =>
  queryOptions({
    ...search(subject, term, filter),
    staleTime: 30_000,
    retry: false,
    meta: { errorToast: false },
  });

const searches = new Map<string, OptionSearch>();

/** `subject`'s records as a filter's options, searched as one types (one object per subject). */
export function recordSearch(subject: string): OptionSearch {
  let found = searches.get(subject);
  if (!found) {
    found = {
      key: [...recordsKey, subject],
      useNames: (values) => useRecordNames(subject, values).name,
      query: (term) => {
        const { queryKey, queryFn } = search(subject, term);
        return {
          queryKey,
          queryFn: async () =>
            (await queryFn()).map((item) => ({
              label: item.title ?? item.id,
              value: item.id,
            })),
        };
      },
    };
    searches.set(subject, found);
  }
  return found;
}
