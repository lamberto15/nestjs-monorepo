import { unwrap, type components } from '@nestjs-monorepo/api-client';
import { api } from '@/lib/api';

/**
 * The record panels' routes (docs/comments.md, attachments.md, tags.md,
 * revisions.md). Every feature that registers a target has the same routes
 * under its own path, with the same shapes. The API publishes those shapes as
 * named schemas (`Comment`, `Attachment`…) whether or not a feature has the
 * add-on, so the answers below are typed from them and no feature's path is
 * named here: a feature may be removed, the last one included.
 *
 * `base` is the record's route, `/v1/<plural>/{id}`.
 */
/** A route under the record's: `/comments`, `/revisions/{number}/restore`. */
type Suffix = `/${string}`;

export type Schemas = components['schemas'];

type Init = {
  params: {
    path: Record<string, string | number>;
    query?: Record<string, string | number | undefined>;
    header?: Record<string, string>;
  };
  body?: unknown;
};
type Call = (
  path: string,
  init: Init,
) => Promise<{ data?: unknown; response: Response }>;

/**
 * The client for these routes. openapi-fetch types a call by its literal
 * path, and these hang off any feature's path (or none's): one cast, as
 * lib/list-query.ts's fetchPage and features/bulk do; the answers are typed
 * by the functions below.
 */
export const client = api as unknown as Record<
  'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  Call
>;

/** `GET`, `POST`… on `<base><suffix>`, answering `T`. */
export const call = <T>(
  method: keyof typeof client,
  base: string,
  suffix: Suffix,
  init: Init,
) =>
  client[method](`${base}${suffix}`, init) as Promise<{
    data?: T;
    response: Response;
  }>;

/** Pages of 100, at most 10: far past what a thread or a list can use. */
export const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export const panelKeys = {
  all: (base: string, id: string) => ['panels', base, id] as const,
  documents: (base: string, id: string) =>
    ['panels', base, id, 'documents'] as const,
  related: (base: string, id: string, path: string, field: string) =>
    ['panels', base, id, 'related', path, field] as const,
};

export async function allPages<T>(
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const result = await page(cursor);
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/** The first records a related panel shows; the rest are on their list. */
export const RELATED_LIMIT = 10;

/**
 * A page of the records that refer to one, newest first, with how many
 * there are and the cursor of the next (`cursor`, as a list pages): their
 * own list filtered by the reference (`related` of GET /v1/lists/{subject}),
 * which shows only those the user may read.
 */
export const listRelated = (
  path: string,
  field: string,
  id: string,
  cursor?: string,
) =>
  unwrap(
    client.GET(`/v1/${path}`, {
      params: {
        path: {},
        query: {
          [field]: id,
          limit: RELATED_LIMIT,
          count: 'true',
          ...(cursor && { cursor }),
        },
      },
    }) as Promise<{
      data?: {
        items: Record<string, unknown>[];
        nextCursor?: string | null;
        total?: number | null;
      };
      response: Response;
    }>,
  );

/** Watch the record: its owner and watchers are told of changes (docs/notifications.md). */
export const watchRecord = (base: string, id: string) =>
  unwrap(
    call<Schemas['Watching']>('POST', base, '/watch', {
      params: { path: { id } },
    }),
  );

/** Stop watching it (404 when it was not watched). */
export const unwatchRecord = (base: string, id: string) =>
  unwrap(call<unknown>('DELETE', base, '/watch', { params: { path: { id } } }));

/**
 * Asks for the record's PDF in `lang` (`POST <base>/pdf?lang=`, docs/documents.md):
 * 202 with the document's id, a worker renders it. A new `Idempotency-Key`
 * goes with every POST (the client); asking again is a new document.
 */
export const issueDocument = (base: string, id: string, lang: string) =>
  unwrap(
    call<Schemas['DocumentQueued']>('POST', base, '/pdf', {
      params: { path: { id }, query: { lang } },
    }),
  );

export type RecordDocument = Schemas['RecordDocument'];

/** The record's documents, newest first: running, failed and issued. */
export const listDocuments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Schemas['RecordDocumentPage']>('GET', base, '/documents', {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

/** An issued document's PDF: a redirect to a signed link (GET /v1/documents/{id}/download). */
export const documentDownloadUrl = (id: string) =>
  `/v1/documents/${id}/download`;
