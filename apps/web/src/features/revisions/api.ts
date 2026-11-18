import { etagOf, unwrap } from '@nestjs-monorepo/api-client';
import {
  call,
  allPages,
  PAGE_SIZE,
  type Schemas,
  panelKeys,
} from '@/components/records/panels/api';

export type Revision = Schemas['Revision'];
export type RevisionDiff = Schemas['RevisionDiff'];

/** The history's query keys, under the record's panels (`panelKeys.all`). */
export const revisionKeys = {
  list: (base: string, id: string) =>
    [...panelKeys.all(base, id), 'revisions'] as const,
  diff: (base: string, id: string, a: number, b: number) =>
    [...panelKeys.all(base, id), 'revisions', 'diff', a, b] as const,
};

export const listRevisions = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Schemas['RevisionPage']>('GET', base, '/revisions', {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

export const diffRevisions = (base: string, id: string, a: number, b: number) =>
  unwrap(
    call<RevisionDiff>('GET', base, '/revisions/{a}/diff/{b}', {
      params: { path: { id, a, b } },
    }),
  );

/** With the record's ETag, a record changed meanwhile is a 412. */
export async function restoreRevision(
  base: string,
  id: string,
  number: number,
  etag?: string,
) {
  const result = await call<unknown>(
    'POST',
    base,
    '/revisions/{number}/restore',
    {
      params: {
        path: { id, number },
        ...(etag && { header: { 'If-Match': etag } }),
      },
    },
  );
  return {
    record: await unwrap(Promise.resolve(result)),
    etag: etagOf(result),
  };
}
