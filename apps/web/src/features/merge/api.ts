import { unwrap } from '@nestjs-monorepo/api-client';
import {
  call,
  client,
  type Schemas,
  panelKeys,
} from '@/components/records/panels/api';

export type Duplicate = Schemas['Duplicate'];
export type MergePreview = Schemas['MergePreview'];

/** The duplicates' query key, under the record's panels (`panelKeys.all`). */
export const duplicateKeys = (base: string, id: string) =>
  [...panelKeys.all(base, id), 'duplicates'] as const;

/** A record's likely duplicates (docs/merging.md): those the user may read. */
export const listDuplicates = (base: string, id: string) =>
  unwrap(
    call<Schemas['DuplicateList']>('GET', base, '/duplicates', {
      params: { path: { id } },
    }),
  );

/**
 * The records a create or edit would duplicate (`POST <list>/duplicates`),
 * before it is saved: `listPath` is `/v1/<plural>`, `excludeId` the record
 * being edited.
 */
export const findDuplicates = (
  listPath: string,
  body: { values: Record<string, unknown>; excludeId?: string },
) =>
  unwrap(
    client.POST(`${listPath}/duplicates`, {
      params: { path: {} },
      body,
    }) as Promise<{
      data?: Schemas['DuplicateList'];
      response: Response;
    }>,
  );

/** Whose value each field keeps: the duplicate's where `duplicate`. */
export type MergeBody = {
  duplicateId: string;
  fields: Record<string, 'survivor' | 'duplicate'>;
};

/** What merging `duplicateId` into the record would do; changes nothing. */
export const previewMerge = (base: string, id: string, body: MergeBody) =>
  unwrap(
    call<MergePreview>('POST', base, '/merge/preview', {
      params: { path: { id } },
      body,
    }),
  );

/** Merges `duplicateId` into the record: the duplicate goes to the recycle bin. */
export const mergeRecord = (base: string, id: string, body: MergeBody) =>
  unwrap(
    call<Record<string, unknown>>('POST', base, '/merge', {
      params: { path: { id } },
      body,
    }),
  );
